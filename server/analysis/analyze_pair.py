#!/usr/bin/env python3
"""
サルサペア動画から YOLOv8-pose で2人分の骨格を計測し、
SHR（2D肩腰比）に基づく Leader/Follower の一次判定と
「判定が難しい区間（contested）」を抽出する。

docs/folder-analysis-detailed-design.md §8.1 参照

検出器の変遷: MediaPipe Heavy (num_poses=4) は密着オクルージョンでペアを1人に潰し、
検証動画で2人同時検出 4% だった。YOLOv8s-pose は同条件で 89% を達成したため全面移行した
（docs/HANDOFF-2026-07-29.md §3）。COCO 17キーポイントには z が無いため SHR は 2D になるが、
検出率の価値が圧倒的に上回る。横向きで精度が落ちる場合は YOLO bbox → MediaPipe crop の
ハイブリッド（選択肢B）を検討する。

- 10fps 相当に間引き（CPU処理時間を抑える。男女判定に30fpsは不要）
- 検出候補から bbox 面積の大きい上位2人をペアとして採用
  （背景の鏡・通行人など第三者がスロットを汚染するのを防ぐ）
- ROIマスク: 前フレームで確定したペアの bbox+マージンの外側をグレーで塗りつぶしてから検出
  （背景人物を検出器の視野から物理的に排除する。crop でなくマスクなのは座標系を保つため。
  検出が2人未満になったらマージンを拡大して維持→0人2連続で全画面フォールバックの安全弁付き）
- スロット割り当ては前フレームの腰位置との Nearest Neighbor（オフライン処理
  なので速度予測は持たない。1フレーム欠けても次フレームで復帰できれば十分）
- SHR = 2D肩幅 / 2D腰幅（ピクセル座標。肩・腰とも概ね水平な線分なのでアスペクト比の影響は相殺）
  肩(5,6)・腰(11,12) の keypoint confidence が閾値未満の人物は計測から除外
- verdict 用の SHR 平均はオクルージョンフレームを除外した「クリーンフレーム」のみから算出
  （密着姿勢で計測が崩れたフレームの混入を防ぐ）
- verdict はスロット別平均ではなく「フレーム内で SHR が高い側 / 低い側」の分離で判定
  （スロット番号は人物IDではなく、CBL等の交差でNNトラッキングが入れ替わると
  スロット平均に両者が混ざり符号が反転し得るため。
  スロット別サマリは参考情報として残すが、同一性リークがあり得る点に注意）

出力: measurements.json（スキーマは詳細設計 §8.1。shr3d → shr2d に改名済み）
     [debug_video_path 指定時] マスク適用後フレーム+検出枠のデバッグ動画（mp4v。
     ブラウザ再生用の H.264 変換は Node 側（jobWorker）が ffmpeg で行う）

Usage: python analyze_pair.py <video_path> <yolo_model_path> <output_json_path> [debug_video_path]
"""
import os
import sys
import json
import math
import cv2
import numpy as np
from ultralytics import YOLO

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frame_time  # noqa: E402
from frame_time import seek_read  # noqa: E402

# COCO 17 keypoints
LEFT_SHOULDER = 5
RIGHT_SHOULDER = 6
LEFT_WRIST = 9
RIGHT_WRIST = 10
LEFT_HIP = 11
RIGHT_HIP = 12

TARGET_FPS = 10.0          # 間引き後の実効fps
BOX_CONF = 0.4             # 人物 bbox の最小信頼度
KP_CONF = 0.3              # 肩・腰 keypoint の最小信頼度（未満は計測に使わない）
SHR_DIFF_THRESHOLD = 0.05  # これ未満は「拮抗」
CONTESTED_MIN_SEC = 3.0    # 拮抗が続いたら contested とみなす最小長
OCCLUSION_DIST = 0.10      # 腰中点間の正規化距離がこれ未満ならオクルージョン
MAX_CONTESTED = 5          # Claude に渡す contested 区間の上限
SMOOTH_WINDOW = 20         # SHR差の移動平均窓（10fpsで2秒）
MIN_CLEAN_SAMPLES = 10     # verdict をクリーンフレームから出すのに必要な最小サンプル数
ROI_MARGIN = 0.15          # ペアbboxに足すマージン（正規化座標）
ROI_GRAY = 128             # マスクの塗りつぶし色
EDGE_MARGIN = 0.01         # bbox がこの距離以内で画面左右端に接していたら「見切れ」扱い
SPECTATOR_AREA_RATIO = 0.45  # ペアの典型bbox面積のこの割合未満は観客とみなし候補から除外
SPECTATOR_AREA_EMA = 0.05    # 典型面積の更新率

# 腰から上の寄りの動画（腰が画面の下に切れている人）は、肩だけで計測する（README 29）。
# 以前は肩・腰の 4 点がそろわない人を全員落としていたので、腰から上の寄りの cap1790 ではペアのコマが 0、出来事も 0 件だった
# （落とした箱 806 のうち 741 が「肩は可・腰が低信頼」）。使うのは「腰が画面の外にある」と言えるときだけ:
#   1. 両肩は KP_CONF 以上、腰のどちらかが KP_CONF 未満
#   2. bbox の下端が画面の下端から WAIST_UP_BOTTOM_MARGIN 以内（体が画面の下で切れている）
#   3. 肩から推した腰の高さが、画面の下端から推定の誤差（胴 × WAIST_UP_HIP_SLACK）以内か、それより下
# 全身が映る動画で腰が隠れた人（重なり・背景の人）は 2・3 を満たさないので、今までどおり落とす。
# 肩だけの人は hipX = 肩の中点の X（CBL の左右の入れ替わり）、hipY = 推した腰の高さ、shr2d = None（腰幅が無い）、
# "torso": "shoulders" と推した胴の長さ "torsoN"（画面の高さで正規化）を持つ。ターン（肩の左右の並び shDx）は元から肩だけ。
# 胴の向きは画面の真下、長さは max(肩幅 × SHOULDER_TORSO_RATIO, 鼻〜肩の中点 × NECK_TORSO_RATIO)。
# 正解表 6 本の全身のコマ（4 点とも KP_CONF 以上の 7334 人・コマ）で測った値（scratchpad の calib.py、2026-10-05）:
#   - 本当の胴（肩の中点 → 腰の中点）と画面の真下の角度は中央値 3.0°（90% 点 7.7°）。肩の線の法線は 7.6°（33°）、
#     鼻 → 肩の中点の向きは 36.5° で、どちらも真下より悪い（ダンサーは立っている。横向きの肩の線は短く向きが不安定）
#   - 胴 / 肩幅（正面向き = 肩の X 差が胴の 0.5 以上の 2750 コマ）は中央値 1.61（動画ごと 1.55〜1.71）。横向きでは肩幅が縮むので
#     肩幅だけだと 10% 点で胴の 0.19 倍まで短く出る。胴 / 鼻〜肩の中点は 2.36（2.24〜2.49）で向きに依らない
#   - 腰の中点の推定誤差（胴の長さ単位）: 肩幅だけ 中央値 .32 / 90% 点 .81、鼻だけ .15 / .48、両方の max .13 / .27
WAIST_UP_FALLBACK = True
WAIST_UP_BOTTOM_MARGIN = 0.02
WAIST_UP_HIP_SLACK = 0.3      # 推した腰の高さの誤差（90% 点 .27 胴）
SHOULDER_TORSO_RATIO = 1.61
NECK_TORSO_RATIO = 2.36
NOSE = 0


def shoulder_torso_px(kps_xy, kps_conf):
    """肩（と鼻）から推した胴の長さ（px）。肩幅 × SHOULDER_TORSO_RATIO と 鼻〜肩の中点 × NECK_TORSO_RATIO の大きい方"""
    sl, sr = kps_xy[LEFT_SHOULDER], kps_xy[RIGHT_SHOULDER]
    est = float(np.linalg.norm(sl - sr)) * SHOULDER_TORSO_RATIO
    if kps_conf[NOSE] >= KP_CONF:
        est = max(est, float(np.linalg.norm((sl + sr) / 2 - kps_xy[NOSE])) * NECK_TORSO_RATIO)
    return est


def hips_out_of_frame(box_xyxyn, kps_xy, kps_conf, frame_h):
    """腰が画面の下に切れているか（肩だけで計測してよいか）。両肩は呼び出し側で確かめてある"""
    if box_xyxyn[3] < 1.0 - WAIST_UP_BOTTOM_MARGIN:
        return False
    torso = shoulder_torso_px(kps_xy, kps_conf)
    sy = float(kps_xy[LEFT_SHOULDER][1] + kps_xy[RIGHT_SHOULDER][1]) / 2
    return sy + torso * (1.0 - WAIST_UP_HIP_SLACK) >= frame_h * (1.0 - WAIST_UP_BOTTOM_MARGIN)


def measure_person(box_xyxyn, kps_xy, kps_conf, det_conf, frame_w, frame_h):
    """1人分の検出結果から計測値を返す。肩が低信頼なら None。腰が低信頼なら、腰が画面の下に切れているときだけ
    肩だけで計測し（WAIST_UP_FALLBACK）、それ以外は None

    位置系（hipX/hipY/bbox）は正規化座標（既存の閾値・ROIロジックと互換）、
    幅系（肩幅・腰幅）はピクセル座標（比を取るので単位は相殺される）
    """
    if any(kps_conf[i] < KP_CONF for i in (LEFT_SHOULDER, RIGHT_SHOULDER)):
        return None
    sl, sr = kps_xy[LEFT_SHOULDER], kps_xy[RIGHT_SHOULDER]
    shoulder_w = float(np.linalg.norm(sl - sr))
    x0, y0, x1, y1 = (float(v) for v in box_xyxyn)
    if any(kps_conf[i] < KP_CONF for i in (LEFT_HIP, RIGHT_HIP)):
        if not (WAIST_UP_FALLBACK and hips_out_of_frame(box_xyxyn, kps_xy, kps_conf, frame_h)):
            return None
        torso = shoulder_torso_px(kps_xy, kps_conf)
        if shoulder_w < 1.0 or torso < 1.0:
            return None
        hip_x = float(sl[0] + sr[0]) / 2
        hip_y = float(sl[1] + sr[1]) / 2 + torso  # 胴は画面の真下へ
        shr = None
        extra = {"torso": "shoulders", "torsoN": round(torso / frame_h, 4)}
    else:
        hl, hr = kps_xy[LEFT_HIP], kps_xy[RIGHT_HIP]
        hip_w = float(np.linalg.norm(hl - hr))
        if hip_w < 1.0:  # 1px 未満は計測不能
            return None
        hip_x, hip_y = float(hl[0] + hr[0]) / 2, float(hl[1] + hr[1]) / 2
        shr = round(shoulder_w / hip_w, 4)
        extra = {}
    return {
        "hipX": round(hip_x / frame_w, 4),
        "hipY": round(hip_y / frame_h, 4),
        "shr2d": shr,
        "shoulderW": round(shoulder_w, 1),
        # 左肩と右肩の画面X差（正規化・符号付き）。符号 = 体の向き（正面/背面）の指標。
        # ターン検出は「この符号の反転回数」で行う（幅の収縮より直接的）
        "shDx": round(float(sl[0] - sr[0]) / frame_w, 4),
        "bboxHpx": round((y1 - y0) * frame_h, 1),
        # 手首の正規化座標（低信頼なら None）。ペアの手のつなぎ（ホールド）検出に使う
        "wrists": {
            "L": (round(float(kps_xy[LEFT_WRIST][0]) / frame_w, 4), round(float(kps_xy[LEFT_WRIST][1]) / frame_h, 4))
                 if kps_conf[LEFT_WRIST] >= KP_CONF else None,
            "R": (round(float(kps_xy[RIGHT_WRIST][0]) / frame_w, 4), round(float(kps_xy[RIGHT_WRIST][1]) / frame_h, 4))
                 if kps_conf[RIGHT_WRIST] >= KP_CONF else None,
        },
        "bboxArea": round((x1 - x0) * (y1 - y0), 5),
        "bbox": (x0, y0, x1, y1),
        "conf": round(float(det_conf), 3),
        # 画面左右端で体が見切れていると肩・腰が切れて SHR が崩れる（検証動画の冒頭で
        # 男性が右端に見切れて SHR 0.73 に潰れ、leaderAtStart を誤らせた実績あり）。
        # 追跡・ROI には使うが verdict 母集団からは除外する
        "edgeClipped": x0 <= EDGE_MARGIN or x1 >= 1.0 - EDGE_MARGIN,
        **extra,
    }


def shoulders_only(p):
    """肩だけで計測した人（腰が画面の下に切れている。measure_person の WAIST_UP_FALLBACK）か"""
    return bool(p) and p.get("torso") == "shoulders"


def detect_persons(model, frame):
    """YOLO で人物を検出し、計測可能な人物のリストを返す"""
    res = model(frame, verbose=False, conf=BOX_CONF)[0]
    persons = []
    if res.keypoints is None or res.boxes is None or len(res.boxes) == 0:
        return persons
    h, w = frame.shape[:2]
    kps_xy = res.keypoints.xy.cpu().numpy()
    kps_conf = res.keypoints.conf
    kps_conf = kps_conf.cpu().numpy() if kps_conf is not None else np.zeros(kps_xy.shape[:2])
    boxes_n = res.boxes.xyxyn.cpu().numpy()
    confs = res.boxes.conf.cpu().numpy()
    for i in range(len(boxes_n)):
        m = measure_person(boxes_n[i], kps_xy[i], kps_conf[i], confs[i], w, h)
        if m is not None:
            # 骨格人形レンダリング用の全キーポイント（正規化 + conf）
            m["kps"] = [(round(float(kps_xy[i][k][0]) / w, 4), round(float(kps_xy[i][k][1]) / h, 4),
                         round(float(kps_conf[i][k]), 2)) for k in range(len(kps_xy[i]))]
            persons.append(m)
    return persons


# COCO 17キーポイントの骨格エッジ（骨格人形の線）
SKELETON_EDGES = [
    (5, 6),                      # 肩
    (5, 7), (7, 9),              # 左腕
    (6, 8), (8, 10),             # 右腕
    (5, 11), (6, 12), (11, 12),  # 胴体
    (11, 13), (13, 15),          # 左脚
    (12, 14), (14, 16),          # 右脚
]
SKELETON_KP_CONF = 0.3


def draw_skeleton_person(canvas, kps, color, w, h):
    """1人分の骨格人形を描く（低confの関節は省略。頭は鼻の位置に円）"""
    def px(k):
        return int(kps[k][0] * w), int(kps[k][1] * h)
    for a, b in SKELETON_EDGES:
        if kps[a][2] >= SKELETON_KP_CONF and kps[b][2] >= SKELETON_KP_CONF:
            cv2.line(canvas, px(a), px(b), color, 5, cv2.LINE_AA)
    for k in range(5, 17):
        if kps[k][2] >= SKELETON_KP_CONF:
            cv2.circle(canvas, px(k), 5, color, -1, cv2.LINE_AA)
    # 頭: 鼻(0)を中心に、肩幅から推定した半径の円
    if kps[0][2] >= SKELETON_KP_CONF and kps[5][2] >= SKELETON_KP_CONF and kps[6][2] >= SKELETON_KP_CONF:
        sw = math.hypot((kps[5][0] - kps[6][0]) * w, (kps[5][1] - kps[6][1]) * h)
        cv2.circle(canvas, px(0), max(8, int(sw * 0.28)), color, 3, cv2.LINE_AA)


def render_skeleton_video(skeleton_video_path, draw_frames, leader_pid, effective_fps, events, size=(720, 1280)):
    """実写を消し、骨格人形（Leader=青 / Follower=ピンク）だけで踊りを再現した動画を書き出す"""
    w, h = size
    writer = cv2.VideoWriter(skeleton_video_path, cv2.VideoWriter_fourcc(*"mp4v"),
                             max(1.0, effective_fps), (w, h))
    for df in draw_frames:
        canvas = np.full((h, w, 3), 24, dtype=np.uint8)  # ほぼ黒の背景
        # 床のガイド線（空間の感覚を残す）
        cv2.line(canvas, (0, int(h * 0.92)), (w, int(h * 0.92)), (60, 60, 60), 2)
        # 奥行き順に描画（画家のアルゴリズム）: 足元（bbox下端）が画面上で高い=遠い人を先に、
        # 低い=カメラに近い人を後に描く → 重なったとき手前の人が正しく上に乗る
        for p in sorted(df["kept"], key=lambda q: q["bbox"][3]):
            if "kps" not in p:
                continue
            if leader_pid is None:
                color = COLOR_NEUTRAL
            elif p.get("pid") is None:
                continue  # ダンサーと同定できない人物（観客等）は骨格人形に出さない
            elif p["pid"] == leader_pid:
                color = COLOR_LEADER
            else:
                color = COLOR_FOLLOWER
            draw_skeleton_person(canvas, p["kps"], color, w, h)
        # 技ラベル（デバッグ動画と同じ規則）
        li = 0
        for e in events:
            if e["t"] <= df["t"] <= e["t"] + EVENT_LABEL_SEC:
                label = e["type"].upper()
                if e.get("rotations", 1) > 1:
                    label += f" x{e['rotations']}"
                if e["by"] != "pair":
                    label += f" ({e['by']})"
                y = 60 + li * 44
                cv2.putText(canvas, label, (14, y), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2, cv2.LINE_AA)
                li += 1
        # タイムコード
        cv2.putText(canvas, f"{df['t']:5.1f}s", (w - 130, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (150, 150, 150), 2)
        writer.write(canvas)
    writer.release()


# 同じ人への二重検出: YOLO の NMS（IoU 0.7）をすり抜けた、1 人に重なる 2 つ目の枠（bbox IoU 0.6〜0.7）。
# 面積上位 2 人を占めて相手を外してしまう（8c312c6d 29.56〜29.76 で女性が外れた）。
# bbox の重なりだけでは密着ホールド・CBL の交差（IoU 0.5〜0.7 の本物の 2 人）と区別できないので、
# 肩・腰の位置が胴の長さに比べてほぼ同じ（同じ骨格）ものだけを二重とみなす。
# 本物の 2 人は 0.3〜3（多くは 1 以上）、二重検出は 0.01〜0.2 だった（正解表 6 本の tracks で実測）
# 既定で無効（数えて reliability.duplicateFrames に出すだけ）。正解表 6 本を YOLO から回し直して比べると、
# 二重検出を除いた分は正しく直るが、ROI と外見追跡の連鎖で 8c312c6d の ID の見直しが変わり、合計では
# CBL F1 .866 → .839 と下がった（docs/salsa-knowledge/README.md 反映済み 18）。
# ID の見直しを resolve_identity_joint にした後も、有効にすると CBL .893 → .897 だが女性のターン R .865 → .838、
# 男のターン F1 .600 → .571、向き 36/38 → 35/37 で差し引きの得にならない（同 19）
DEDUP_DUPLICATES = False
DEDUP_IOU = 0.5     # bbox がこれ以上重なっていて
DEDUP_TORSO = 0.25  # 肩・腰 4 点のずれの平均が 胴の長さ × これ 未満なら同じ人
TORSO_KPS = (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP)


def torso_distance(p, q, aspect=1.0):
    """2 つの検出の肩・腰 4 点のずれの平均を、長い方の胴（肩の中点〜腰の中点）で割った値。
    kps は正規化座標なので、x に aspect（幅 / 高さ）を掛けて縦横の縮尺をそろえる。
    どちらかが肩だけの人（腰が画面の外）なら肩の 2 点だけで比べ、胴はその人の推した長さ（torsoN）を使う"""
    kps_idx = TORSO_KPS[:2] if shoulders_only(p) or shoulders_only(q) else TORSO_KPS

    def pts(k):
        return [(k[i][0] * aspect, k[i][1]) for i in kps_idx]

    def torso_len(person):
        if shoulders_only(person):
            return person["torsoN"]
        ps = [(person["kps"][i][0] * aspect, person["kps"][i][1]) for i in TORSO_KPS]
        sx, sy = (ps[0][0] + ps[1][0]) / 2, (ps[0][1] + ps[1][1]) / 2
        hx, hy = (ps[2][0] + ps[3][0]) / 2, (ps[2][1] + ps[3][1]) / 2
        return math.hypot(sx - hx, sy - hy)

    a, b = pts(p["kps"]), pts(q["kps"])
    size = max(torso_len(p), torso_len(q), 1e-6)
    return sum(math.hypot(u[0] - v[0], u[1] - v[1]) for u, v in zip(a, b)) / len(a) / size


def suppress_duplicates(persons, aspect=1.0):
    """同じ人への二重検出を 1 つにまとめる。信頼度の高い順に残し、残したものと
    bbox IoU ≥ DEDUP_IOU かつ 胴のずれ < DEDUP_TORSO のものを捨てる。戻り値: (残す, 捨てる)
    （DEDUP_DUPLICATES に関わらず見つける。使うかどうかは呼び出し側が決める）"""
    if len(persons) < 2:
        return persons, []
    order = sorted(persons, key=lambda p: p.get("conf", 0.0), reverse=True)
    kept, dropped = [], []
    for p in order:
        if any(bbox_iou(p["bbox"], q["bbox"]) >= DEDUP_IOU and torso_distance(p, q, aspect) < DEDUP_TORSO
               for q in kept):
            dropped.append(p)
        else:
            kept.append(p)
    return [p for p in persons if any(p is k for k in kept)], dropped


def pick_main_pair(persons):
    """検出候補から bbox 面積の大きい上位2人（＝カメラ手前のダンサーペア）を選ぶ。

    背景の鏡・通行人など小さく写る第三者を弾く。3人目が主ペアと同等サイズの
    場合は選別できないが、その場合はスロットNNトラッキングの連続性に委ねる。
    """
    if len(persons) <= 2:
        return persons
    return sorted(persons, key=lambda p: p["bboxArea"], reverse=True)[:2]


# 背景の別人（相方が手前の相手の陰に隠れている間に、追跡が奥の人に乗り換わる）を主ペアから外す。
# 820f0461 の冒頭 0〜1.4 秒は男性が女性の陰に隠れ、奥に立つ観客が「2人目」として拾われ、男性として色が付いていた。
# 判定は make_strips.py と同じ: 2人の bbox の高さ比が BG_MIN_HEIGHT_RATIO 未満、または足元（bbox 下端）のずれが
# 背の高い方の高さの BG_MAX_FOOT_GAP 倍を超えたら、面積の小さい方は別人（奥行きが違う）。
# 外した人は kept から rejected に移す（その区間は「相方なし」の欠損で、別人では埋めない）。
# MOTION_LAB_BG_FILTER=0 で無効（回帰の比較用）
BG_FILTER = os.environ.get("MOTION_LAB_BG_FILTER", "1") != "0"
BG_MIN_HEIGHT_RATIO = 0.6
BG_MAX_FOOT_GAP = 0.3
BG_MIN_RUN_SEC = 1.2    # ペアに見えないコマがこの秒数以上続いたら乗り換わり
# 相方を見失った（1人だけの）コマのこの秒数以内も乗り換わりとみなす。既定は 0（無効）。
# 0.3 にすると 820f0461 の 2.45〜2.52 秒の別人も外れるが、回帰評価（1230b3d5 の短い区間に効く）で
# CBL の誤検出が 11→13 に増え All F1 が .900→.897 に下がったので既定では使わない
BG_SOLO_ADJ_SEC = float(os.environ.get("MOTION_LAB_BG_SOLO_ADJ", "0"))


def background_person_index(kept):
    """kept（ちょうど2人）の、奥の別人とみなす方のインデックス。ペアに見えるなら None"""
    if len(kept) != 2:
        return None
    a, b = kept[0]["bbox"], kept[1]["bbox"]
    ha, hb = a[3] - a[1], b[3] - b[1]
    hmax = max(ha, hb)
    if hmax <= 0:
        return None
    if min(ha, hb) / hmax < BG_MIN_HEIGHT_RATIO or abs(a[3] - b[3]) > BG_MAX_FOOT_GAP * hmax:
        area = lambda bb: max(0.0, bb[2] - bb[0]) * max(0.0, bb[3] - bb[1])
        return 1 if area(a) >= area(b) else 0
    return None


def drop_background_persons(draw_frames):
    """ペアに見えないコマの奥の別人を kept から外して rejected へ移す（in place）。戻り値: 外したコマ数

    1コマだけの点滅（接近・部分遮蔽で箱が欠けただけ）は本物のペアなので外さない。外すのは次のどちらか:
    - ペアに見えないコマが BG_MIN_RUN_SEC 秒以上続いた区間（相方が長く隠れ、別人に乗り換わっている）
    - 相方が取れず1人しか居ないコマの BG_SOLO_ADJ_SEC 秒以内に出た、ペアに見えないコマ（見失った直後に別人を拾った）
    """
    if not BG_FILTER:
        return 0
    flagged = [background_person_index(df["kept"]) for df in draw_frames]
    n = len(draw_frames)
    drop = [False] * n
    i = 0
    while i < n:
        if flagged[i] is None:
            i += 1
            continue
        j = i
        while j + 1 < n and flagged[j + 1] is not None and draw_frames[j + 1]["t"] - draw_frames[j]["t"] < 0.4:
            j += 1
        long_run = draw_frames[j]["t"] - draw_frames[i]["t"] >= BG_MIN_RUN_SEC
        for k in range(i, j + 1):
            drop[k] = long_run
        i = j + 1
    solo = [len(df["kept"]) == 1 for df in draw_frames]
    for k in range(n):
        if flagged[k] is None or drop[k]:
            continue
        t = draw_frames[k]["t"]
        lo = k
        while lo > 0 and t - draw_frames[lo - 1]["t"] <= BG_SOLO_ADJ_SEC:
            lo -= 1
            if solo[lo]:
                drop[k] = True
                break
        hi = k
        while not drop[k] and hi + 1 < n and draw_frames[hi + 1]["t"] - t <= BG_SOLO_ADJ_SEC:
            hi += 1
            if solo[hi]:
                drop[k] = True
    count = 0
    for df, f_idx, d in zip(draw_frames, flagged, drop):
        if d:
            p = df["kept"].pop(f_idx)
            df.setdefault("rejected", []).append({"bbox": p["bbox"], "shr2d": p.get("shr2d")})
            count += 1
    return count


def roi_from_persons(persons, margin):
    """ペアの bbox の合併 + マージンを ROI（正規化座標）として返す"""
    x0 = min(p["bbox"][0] for p in persons) - margin
    y0 = min(p["bbox"][1] for p in persons) - margin
    x1 = max(p["bbox"][2] for p in persons) + margin
    y1 = max(p["bbox"][3] for p in persons) + margin
    return (max(0.0, x0), max(0.0, y0), min(1.0, x1), min(1.0, y1))


def apply_roi_mask(frame, roi):
    """ROI の外側をグレーで塗りつぶしたフレームを返す（座標系は保たれる）"""
    h, w = frame.shape[:2]
    x0, y0 = max(0, int(roi[0] * w)), max(0, int(roi[1] * h))
    x1, y1 = min(w, int(roi[2] * w)), min(h, int(roi[3] * h))
    out = np.full_like(frame, ROI_GRAY)
    out[y0:y1, x0:x1] = frame[y0:y1, x0:x1]
    return out


# ブラウザ実装（usePoseEstimation.ts）と同じカラーコーディング: Leader=青, Follower=ピンク
# OpenCV は BGR 順なので注意
COLOR_LEADER = (255, 102, 0)     # 青 (#0066ff)
COLOR_FOLLOWER = (204, 0, 255)   # ピンク (#ff00cc)
COLOR_NEUTRAL = (0, 220, 0)      # 緑: ロール判定材料なし
COLOR_REJECTED = (0, 0, 255)     # 赤: 背景人物として除外

TORSO_HIST_REGION = 0.55   # bbox 上部何割をヒストグラム対象にするか（胴体+腕。脚は両者とも黒で無情報）
APPEARANCE_EMA = 0.1       # 外見リファレンスの更新率（小さいほどオクルージョン混入に頑健）
# 錨リファレンス: 2人がそろってから最初の ANCHOR_SEC 秒の、重なっていない（IoU < ANCHOR_CLEAN_IOU）
# コマの平均ヒストグラム。EMA だけだと密着交差で相手の色が混ざったリファレンスに引きずられて
# ID が入れ替わり、以後戻らない（1230b3d5 で 13.5 秒の交差から最後まで逆転、同一性 15%）。
# 割り当てコストに錨との距離を ANCHOR_WEIGHT だけ混ぜると戻ってこられる（同一性 5 本計 63%→96%）。
# 重みを上げすぎる（0.7）と、背中を向いた女性が正面の錨と合わずターン中に ID が揺れる（screenrec）
ANCHOR_SEC = 8.0
ANCHOR_CLEAN_IOU = 0.05
ANCHOR_WEIGHT = 0.3


def torso_hist(frame, bbox):
    """人物 bbox 上部の HSV 色ヒストグラム（正規化済み128次元: 色相8×彩度4×明度4）を返す。

    幾何学的特徴（SHR・身長・肩幅）はどれも「体の向き」か「カメラ距離」に
    敏感で、女性が手前に来るターン区間で3特徴が揃って誤投票する実測があった。
    服装・肌の色分布は向きにも距離にもほぼ不変なので、人物の同一性の追跡に使う
    """
    h, w = frame.shape[:2]
    x0, x1 = int(max(0.0, bbox[0]) * w), int(min(1.0, bbox[2]) * w)
    y0 = int(max(0.0, bbox[1]) * h)
    y1 = int(min(1.0, bbox[1] + (bbox[3] - bbox[1]) * TORSO_HIST_REGION) * h)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    hsv = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    # 色相・彩度に加えて明度も使う。黒い服とグレーの服は色相・彩度がほぼ同じで明度だけが違い、
    # 明度なしでは見分けられずにすれ違いの瞬間に ID が入れ替わっていた（9/23 ScreenRecording で実測）
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return hist.flatten()


def hist_dist(a, b):
    return float(np.abs(a - b).sum())


def bbox_iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def track_appearance(draw_frames, anchor=None, anchor_weight=0.0):
    """各フレームの検出を、リファレンスヒストグラム（EMA更新）との距離で人物ID 0/1 に割り当てる
    （2人同時のときはペア割り当てコストの小さい方）。anchor があれば、その距離を anchor_weight だけ混ぜる"""
    refs = [None, None] if anchor is None else [anchor[0].copy(), anchor[1].copy()]

    def cost(h, k):
        d = hist_dist(h, refs[k])
        return d if anchor is None else (1.0 - anchor_weight) * d + anchor_weight * hist_dist(h, anchor[k])

    for df in draw_frames:
        ks = [p for p in df["kept"] if p.get("hist") is not None]
        for p in df["kept"]:
            p.pop("pid", None)
        if refs[0] is None:
            if len(ks) == 2:
                refs[0], refs[1] = ks[0]["hist"].copy(), ks[1]["hist"].copy()
                ks[0]["pid"], ks[1]["pid"] = 0, 1
            continue
        if len(ks) == 2:
            direct = cost(ks[0]["hist"], 0) + cost(ks[1]["hist"], 1)
            swapped = cost(ks[0]["hist"], 1) + cost(ks[1]["hist"], 0)
            pids = (0, 1) if direct <= swapped else (1, 0)
        elif len(ks) == 1:
            pids = (0,) if cost(ks[0]["hist"], 0) <= cost(ks[0]["hist"], 1) else (1,)
        else:
            continue
        # 注意: ここに「外見が遠い人物にIDを与えないゲート」を入れてはならない。
        # 一度入れたところ、ダンサーが背面を向いた区間で本人のID更新まで拒否され、
        # クラスタが途中で入れ替わって男女の色が全編逆転した（実測）。
        # 観客の排除は検出段の体格門番（SPECTATOR_AREA_RATIO）が担う
        for p, pid in zip(ks, pids):
            p["pid"] = pid
            refs[pid] = (1.0 - APPEARANCE_EMA) * refs[pid] + APPEARANCE_EMA * p["hist"]


def anchor_refs(draw_frames):
    """1回目の追跡結果から、冒頭 ANCHOR_SEC 秒の重なっていないコマで pid 別の平均ヒストグラムを作る"""
    acc, t0 = ([], []), None
    for df in draw_frames:
        ks = [p for p in df["kept"] if p.get("hist") is not None and p.get("pid") is not None]
        if len(ks) != 2:
            continue
        t0 = df["t"] if t0 is None else t0
        if df["t"] > t0 + ANCHOR_SEC:
            break
        if bbox_iou(ks[0]["bbox"], ks[1]["bbox"]) < ANCHOR_CLEAN_IOU:
            for p in ks:
                acc[p["pid"]].append(p["hist"])
    if not acc[0] or not acc[1]:
        return None
    return [np.mean(a, axis=0) for a in acc]


SEGMENT_REID = True
SEGMENT_IOU = 0.4         # 2人の bbox がこれ以上重なったコマは区間の切れ目（ここで ID が入れ替わり得る）
SEGMENT_MOVE = 0.15       # 隣のコマとの腰の X の差がこれを超えたら切れ目（取り違え・別人）
SEGMENT_MIN_FRAMES = 8    # これより短い区間は判定しない
SEGMENT_MARGIN = 0.02     # 錨との距離の差（入れ替えた方 − そのまま）の区間平均がこの値だけ負なら入れ替える
SEGMENT_DEBUG = False


def fix_identity_segments(draw_frames, anchor):
    """密着の交差で入れ替わったまま戻らない ID を、交差と交差の間の区間ごとに錨で見直す。

    track_appearance はコマごとに EMA の参照（重み 0.7）で割り当てるので、2人の服が似ている動画では交差で一度
    入れ替わると参照も入れ替わり、以後戻らない（8c312c6d の 31.4 秒の CBL から最後まで入れ替わり、CBL・女性の
    ダブルターンが 1 件も出なかった）。1コマの錨の差は小さく揺れるが、2人が離れている区間（位置で同一人物と
    言える）でまとめて足すと向きがはっきりする。区間 = 2人がそろい、bbox が重ならず、腰の X が飛ばないコマの連なり。
    区間の外のコマ（重なり・1人だけ）は、前後の区間がどちらも入れ替えなら入れ替える。片方だけなら近い方に従う"""
    segs, cur = [], []

    def two(df):
        ks = [p for p in df["kept"] if p.get("pid") in (0, 1) and p.get("hist") is not None]
        if len(ks) != 2 or ks[0]["pid"] == ks[1]["pid"] or bbox_iou(ks[0]["bbox"], ks[1]["bbox"]) >= SEGMENT_IOU:
            return None
        return {p["pid"]: p for p in ks}

    prev = None
    for i, df in enumerate(draw_frames):
        by = two(df)
        if by is None:
            if cur:
                segs.append(cur)
            cur, prev = [], None
            continue
        if prev is not None and any(abs(by[k]["hipX"] - prev[k]["hipX"]) > SEGMENT_MOVE for k in (0, 1)):
            segs.append(cur)
            cur = []
        cur.append(i)
        prev = by
    if cur:
        segs.append(cur)

    decisions = []  # (最初のコマ, 最後のコマ, 入れ替えるか)
    for seg in segs:
        if len(seg) < SEGMENT_MIN_FRAMES:
            decisions.append((seg[0], seg[-1], False))  # 短い区間は見直さないが、前後のコマの拠り所にはする
            continue
        ms = []
        for i in seg:
            by = two(draw_frames[i])
            direct = hist_dist(by[0]["hist"], anchor[0]) + hist_dist(by[1]["hist"], anchor[1])
            swapped = hist_dist(by[0]["hist"], anchor[1]) + hist_dist(by[1]["hist"], anchor[0])
            ms.append(swapped - direct)
        mean = sum(ms) / len(ms)
        if SEGMENT_DEBUG:
            sd = (sum((m - mean) ** 2 for m in ms) / len(ms)) ** 0.5
            print(f"  seg {draw_frames[seg[0]]['t']:.1f}-{draw_frames[seg[-1]]['t']:.1f} n={len(ms)} mean={mean:+.3f} "
                  f"sd={sd:.3f} neg={sum(m < 0 for m in ms) / len(ms):.2f}", file=sys.stderr)
        decisions.append((seg[0], seg[-1], mean < -SEGMENT_MARGIN))
    if not any(s for _, _, s in decisions):
        return
    print("identity segments swapped: " + ", ".join(
        f"{draw_frames[a]['t']:.1f}-{draw_frames[b]['t']:.1f}" for a, b, s in decisions if s), file=sys.stderr)
    _apply_segment_flips(draw_frames, decisions)


def _apply_segment_flips(draw_frames, decisions):
    """decisions = [(最初のコマ, 最後のコマ, 入れ替えるか)]。区間の外のコマは前後の区間に従う（食い違えば近い方）"""
    for i, df in enumerate(draw_frames):
        inside = next((d for d in decisions if d[0] <= i <= d[1]), None)
        if inside is not None:
            flip = inside[2]
        else:
            before = next((d for d in reversed(decisions) if d[1] < i), None)
            after = next((d for d in decisions if d[0] > i), None)
            if before and after:
                flip = before[2] if before[2] == after[2] else \
                    (before[2] if i - before[1] <= after[0] - i else after[2])
            else:
                flip = (before or after or (0, 0, False))[2]
        if flip:
            for p in df["kept"]:
                if p.get("pid") in (0, 1):
                    p["pid"] = 1 - p["pid"]


# 区間ごとの ID の見直しを、全区間まとめて決める版（resolve_identity_joint）。fix_identity_segments の代わりに使う。
# 正解表 6 本（YOLO から回した tracks の検出に外見を付け直して採点、docs/salsa-knowledge/README.md 反映済み 19）:
# 服の手がかり（素足 / 黒いズボン等）で男女が決まるコマの ID の誤り 111 → 10 / 2706 コマ、
# 検出の小さな揺れ（枠 ±1.5%・2% のコマ落ち・二重検出の除去）での出来事の食い違い 119 → 48 件
IDENTITY_JOINT = True
JOINT_REGIONS = ("hist", "upper", "lower", "shin", "head", "arms")
JOINT_GEOM_WEIGHT = 0.3   # 体の寸法（bbox の高さ・胴の長さ・肩幅・SHR、標準化）の重み
JOINT_SHRINK = 0.3        # 判別の共分散を対角へ縮める割合
JOINT_KAPPA = 0.5         # コマごとの対数尤度比の割引（隣のコマは独立でない）
JOINT_EMIT_CAP = 8.0      # 1 コマの対数尤度比の上限
JOINT_BLOCK_SEC = 4.0     # この長さごとに、自分の前後を除いて判別を学び直す
JOINT_GUARD_SEC = 1.0
JOINT_SWITCH_COST = 2.0   # 隣の区間と入れ替えの有無が変わるコスト（2〜12 で結果はほぼ同じ）
JOINT_TRAIN_IOU = 0.3     # 判別の学習に使うのは 2 人の bbox がこれ未満しか重ならないコマ
JOINT_ITERS = 3


def _region_hist(frame, x0, y0, x1, y1):
    """正規化座標の矩形の HSV ヒストグラム（torso_hist と同じ 8×4×4 = 128 次元、L1 正規化）。小さすぎれば None"""
    h, w = frame.shape[:2]
    x0, x1 = int(max(0.0, min(x0, x1)) * w), int(min(1.0, max(x0, x1)) * w)
    y0, y1 = int(max(0.0, min(y0, y1)) * h), int(min(1.0, max(y0, y1)) * h)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None
    hsv = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return hist.flatten().astype(np.float32)


def appearance_regions(frame, p, aspect):
    """骨格に合わせた部位ごとの色（胴・腿・脛・頭・腕）と体の寸法。resolve_identity_joint 用。
    2 人とも黒白の服でも、脚（素足 / 黒いズボン）・腕（袖 / 素肌）・髪のように部位で分けると違いが出る。
    肩・腰の 4 点は measure_person が信頼度を保証している。戻り値: {部位: hist or None, "torsoLen", "shW"}
    肩だけの人（腰が画面の下に切れている）は、胴を肩から真下へ推した長さ（torsoN）で取り、腿・脛は読まない（None）。
    胴の長さも推した値なので寸法には入れない（torsoLen = None。肩幅と同じ情報になる）"""
    def kp(i):
        k = p["kps"][i]
        return (k[0], k[1]) if k[2] >= KP_CONF else None
    if shoulders_only(p):
        sl, sr = (p["kps"][i][:2] for i in (LEFT_SHOULDER, RIGHT_SHOULDER))
        sy = (sl[1] + sr[1]) / 2
        torso = max(p["torsoN"], 1e-3)
        out = {"upper": _region_hist(frame, min(sl[0], sr[0]), sy, max(sl[0], sr[0]), sy + torso),
               "torsoLen": None, "shW": abs(sl[0] - sr[0]) * aspect, "lower": None, "shin": None}
    else:
        sl, sr, hl, hr = (p["kps"][i][:2] for i in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP))
        sy, hy = (sl[1] + sr[1]) / 2, (hl[1] + hr[1]) / 2
        torso = max(hy - sy, 1e-3)
        xs = [sl[0], sr[0], hl[0], hr[0]]
        out = {"upper": _region_hist(frame, min(xs), sy, max(xs), hy), "torsoLen": torso, "shW": abs(sl[0] - sr[0]) * aspect}
        _lower_regions(frame, kp, hl, hr, hy, torso, out)
    heads = [k for k in (kp(i) for i in range(5)) if k]
    cx = float(np.mean([k[0] for k in heads])) if heads else (sl[0] + sr[0]) / 2
    half = max(0.5 * torso, out["shW"]) * 0.45 / aspect
    out["head"] = _region_hist(frame, cx - half, max(p["bbox"][1], sy - 0.7 * torso), cx + half, sy)
    arms = []
    for ids in ((LEFT_SHOULDER, 7, LEFT_WRIST), (RIGHT_SHOULDER, 8, RIGHT_WRIST)):
        pts = [q for q in (kp(i) for i in ids) if q]
        if len(pts) >= 2:
            ax, ay_ = [q[0] for q in pts], [q[1] for q in pts]
            pd = 0.08 * torso
            hh = _region_hist(frame, min(ax) - pd / aspect, min(ay_) - pd, max(ax) + pd / aspect, max(ay_) + pd)
            if hh is not None:
                arms.append(hh)
    out["arms"] = np.mean(arms, axis=0).astype(np.float32) if arms else None
    return out


def _lower_regions(frame, kp, hl, hr, hy, torso, out):
    """腿（腰〜膝）と脛（膝〜足首）の色を out に書く（全身が映る人だけ）"""
    kl, kr, al, ar = kp(13), kp(14), kp(15), kp(16)
    ky = max([k[1] for k in (kl, kr) if k] or [hy + 0.9 * torso])
    lx = [hl[0], hr[0]] + [k[0] for k in (kl, kr) if k]
    pad = 0.15 * (max(lx) - min(lx) + 1e-3)
    out["lower"] = _region_hist(frame, min(lx) - pad, hy, max(lx) + pad, ky)
    out["shin"] = None
    if (kl or kr) and (al or ar):
        ay = max(a[1] for a in (al, ar) if a)
        sx = [k[0] for k in (kl, kr, al, ar) if k]
        pad = 0.2 * (max(sx) - min(sx) + 1e-3)
        out["shin"] = _region_hist(frame, min(sx) - pad, ky, max(sx) + pad, ay)


def _identity_geom(p):
    app = p.get("app") or {}
    tl, sw = app.get("torsoLen"), app.get("shW")
    shr = p.get("shr2d")
    return np.array([math.log(max(p["bboxHpx"], 1.0)), math.log(tl) if tl else np.nan,
                     math.log(sw) if sw else np.nan, np.nan if shr is None else shr], dtype=float)


def _identity_vector(p, means, geo_mu, geo_sd):
    parts = []
    for r in JOINT_REGIONS:
        h = p.get("hist") if r == "hist" else (p.get("app") or {}).get(r)
        parts.append(np.sqrt(h) if h is not None else means[r])
    g = (_identity_geom(p) - geo_mu) / geo_sd
    return np.concatenate(parts + [JOINT_GEOM_WEIGHT * np.nan_to_num(g)])


def _shrunk_lda(D):
    """2 人の差ベクトル D（行 = コマ、0 番 − 1 番）から、差の向きの対数尤度比を出す重み（共分散を対角へ縮める Fisher 判別）"""
    mu = D.mean(axis=0)
    C = np.cov((D - mu).T)
    C = (1 - JOINT_SHRINK) * C + JOINT_SHRINK * np.eye(len(C)) * (np.trace(C) / len(C))
    w = np.linalg.solve(C, mu)
    return w * (2 * float(w @ mu) / max(float(w @ C @ w), 1e-9))


def resolve_identity_joint(draw_frames):
    """区間（2 人がそろい重ならないコマの連なり。区間の中は位置で同一人物と言える）ごとの ID の入れ替えを、全区間まとめて決める。

    fix_identity_segments（錨との色の距離を区間ごとに見て、閾値で 1 つずつ入れ替える）は、黒白の服の 2 人では差がわずかで、
    ROI のわずかな変化で入れ替える区間が変わり、撮影の寄りが変わった後の正しい区間まで入れ替えていた（8c312c6d 26.8〜27.7）。ここでは
      1. 外見を部位ごとの色（bbox 上部・胴・腿・脛・頭・腕）と体の寸法のベクトルにし、
      2. 区間ごとの 2 人の差の平均を、区間の中の揺れで白色化した空間の第 1 主成分に射影した符号で、まず全区間の向きをそろえる
         （追跡の結果に頼らない。2% のコマ落ちで追跡が半分近く間違えた 8c312c6d も戻せる）、
      3. そのラベルで「2 人の差 → どちらが 0 番か」の判別（縮小 Fisher 判別）を学び、区間ごとの証拠（コマごとの対数尤度比の和）を出す。
         判別は JOINT_BLOCK_SEC 秒ごとに、その前後 JOINT_GUARD_SEC 秒を除いたコマで学び直す（自分のラベルで自分を確かめない。
         全部で学ぶと間違った区間のラベルまで覚えて、どの区間も「そのまま」と出る）、
      4. 区間の並びに沿った 2 状態の Viterbi（そのまま / 入れ替え、隣と変わるたびに JOINT_SWITCH_COST）で全区間を決め、
         3〜4 を数回くり返す。区間の外のコマ（重なり・1 人だけ）は fix_identity_segments と同じく前後の区間に従う"""
    segs, cur, prev = [], [], None

    def two(df):
        ks = [p for p in df["kept"] if p.get("pid") in (0, 1) and p.get("hist") is not None]
        if len(ks) != 2 or ks[0]["pid"] == ks[1]["pid"] or bbox_iou(ks[0]["bbox"], ks[1]["bbox"]) >= SEGMENT_IOU:
            return None
        return {p["pid"]: p for p in ks}

    for i, df in enumerate(draw_frames):
        by = two(df)
        if by is None:
            if cur:
                segs.append(cur)
            cur, prev = [], None
            continue
        if prev is not None and any(abs(by[k]["hipX"] - prev[k]["hipX"]) > SEGMENT_MOVE for k in (0, 1)):
            segs.append(cur)
            cur = []
        cur.append(i)
        prev = by
    if cur:
        segs.append(cur)
    if len(segs) < 2:
        return
    ps = [p for s in segs for i in s for p in two(draw_frames[i]).values()]
    means = {}
    for r in JOINT_REGIONS:
        hs = [np.sqrt(h) for h in ((p.get("hist") if r == "hist" else (p.get("app") or {}).get(r)) for p in ps)
              if h is not None]
        means[r] = np.mean(hs, axis=0) if hs else np.zeros(128)
    G = np.array([_identity_geom(p) for p in ps])
    ok = np.isfinite(G)
    cnt = np.maximum(ok.sum(axis=0), 1)
    geo_mu = np.where(ok, G, 0.0).sum(axis=0) / cnt
    geo_sd = np.sqrt(np.where(ok, (G - geo_mu) ** 2, 0.0).sum(axis=0) / cnt)
    geo_sd = np.where(geo_sd < 1e-6, 1.0, geo_sd)
    # 区間のコマごとの差ベクトル（追跡のラベルのまま: 0 番 − 1 番）
    D, T, IOU, seg_of = [], [], [], []
    for k, s in enumerate(segs):
        for i in s:
            by = two(draw_frames[i])
            D.append(_identity_vector(by[0], means, geo_mu, geo_sd) - _identity_vector(by[1], means, geo_mu, geo_sd))
            T.append(draw_frames[i]["t"])
            IOU.append(bbox_iou(by[0]["bbox"], by[1]["bbox"]))
            seg_of.append(k)
    D, T, IOU, seg_of = np.array(D), np.array(T), np.array(IOU), np.array(seg_of)
    n_frames = np.array([len(s) for s in segs])

    def orient(flip):
        # 0 番 / 1 番の向きは任意なので、入れ替えるコマが少ない方にそろえる
        return [not f for f in flip] if n_frames[np.array(flip, bool)].sum() > n_frames.sum() / 2 else flip

    # 2. 白色化した空間の第 1 主成分で初期の向きをそろえる
    dim = D.shape[1]
    M = np.array([D[seg_of == k].mean(axis=0) for k in range(len(segs))])
    R = D - M[seg_of]
    Sw = R.T @ R / len(D)
    Sw = (1 - JOINT_SHRINK) * Sw + JOINT_SHRINK * np.eye(dim) * (np.trace(Sw) / dim) + 1e-9 * np.eye(dim)
    ev, U = np.linalg.eigh(Sw)
    Mw = M @ (U / np.sqrt(ev))
    _, V = np.linalg.eigh((Mw * n_frames[:, None]).T @ Mw)
    flip = orient([float(x) < 0 for x in Mw @ V[:, -1]])
    t0, t1 = float(T.min()), float(T.max())
    train = IOU < JOINT_TRAIN_IOU
    if train.sum() < 10:
        return
    for _ in range(JOINT_ITERS):
        Dl = D * np.where(np.array(flip)[seg_of], -1.0, 1.0)[:, None]  # 今のラベルでの 0 番 − 1 番
        llr = np.zeros(len(D))
        b0 = t0
        while b0 <= t1:
            inb = (T >= b0) & (T < b0 + JOINT_BLOCK_SEC)
            if inb.any():
                mask = train & ((T < b0 - JOINT_GUARD_SEC) | (T >= b0 + JOINT_BLOCK_SEC + JOINT_GUARD_SEC))
                w = _shrunk_lda(Dl[mask] if mask.sum() >= 10 else Dl[train])
                llr[inb] = np.clip(JOINT_KAPPA * (D[inb] @ w), -JOINT_EMIT_CAP, JOINT_EMIT_CAP)
            b0 += JOINT_BLOCK_SEC
        keep = np.bincount(seg_of, weights=llr, minlength=len(segs))  # 追跡のラベルのままを支持する証拠
        # 4. Viterbi（状態: 0 = そのまま, 1 = 入れ替え）
        cost = [-keep[0] / 2, keep[0] / 2]
        back = []
        for k in range(1, len(segs)):
            nc, bk = [], []
            for z in (0, 1):
                c = [cost[zp] + (JOINT_SWITCH_COST if zp != z else 0.0) for zp in (0, 1)]
                zp = 0 if c[0] <= c[1] else 1
                nc.append(c[zp] + (-keep[k] / 2 if z == 0 else keep[k] / 2))
                bk.append(zp)
            cost = nc
            back.append(bk)
        z = 0 if cost[0] <= cost[1] else 1
        new = [False] * len(segs)
        for k in range(len(segs) - 1, -1, -1):
            new[k] = bool(z)
            if k > 0:
                z = back[k - 1][z]
        new = orient(new)
        if new == flip:
            break
        flip = new
    decisions = [(s[0], s[-1], f) for s, f in zip(segs, flip)]
    if any(flip):
        print("identity segments swapped (joint): " + ", ".join(
            f"{draw_frames[a]['t']:.1f}-{draw_frames[b]['t']:.1f}" for a, b, f in decisions if f), file=sys.stderr)
        _apply_segment_flips(draw_frames, decisions)


def assign_appearance_ids(draw_frames):
    """外見（色ヒストグラム）で全検出を2人分のクラスタに分け、Leader クラスタを決める。

    - 1回目: EMA リファレンスだけで追跡し、冒頭のきれいなコマから錨リファレンスを作る
    - 2回目: 錨を混ぜたコストで追跡し直す（密着交差での取り違えから戻れるように）
    - 区間ごとの入れ替えを全区間まとめて見直す（resolve_identity_joint。IDENTITY_JOINT = False なら旧 fix_identity_segments）
    - Leader は「クラスタ単位の SHR 平均」が高い方（フレーム単位の勝負ではないので
      横向きの一瞬に色が乗っ取られない）
    - 各 kept エントリに "pid" を書き込み、Leader の pid を返す（判定不能なら None）
    - 最初に、ペアに見えないコマの奥の別人を kept から外す（drop_background_persons）
    """
    dropped = drop_background_persons(draw_frames)
    if dropped:
        print(f"background person dropped in {dropped} frames", file=sys.stderr)
    track_appearance(draw_frames)
    anchor = anchor_refs(draw_frames)
    if anchor is not None:
        track_appearance(draw_frames, anchor, ANCHOR_WEIGHT)
    if IDENTITY_JOINT:
        resolve_identity_joint(draw_frames)
    elif anchor is not None and SEGMENT_REID:
        fix_identity_segments(draw_frames, anchor)

    # Leader クラスタの選択: フレーム毎のペア比較（pid0 - pid1）の中央値による多数決。
    # SHR差（重み2）+ 身長差 + 肩幅差。かつて「SHR平均が高い方」で選んでいたが、
    # ターン中の異常値（SHR 2.8 等）が平均を汚染し、僅差（1.555 vs 1.591）で
    # 女性クラスタをリーダーと誤選択→全編の色が逆転した実測がある。
    # 中央値のペア比較は外れ値に頑健で、同一フレーム内の比較なので遠近の影響も相殺される
    d_shr, d_h, d_sw = [], [], []
    for df in draw_frames:
        ks = {p["pid"]: p for p in df["kept"] if p.get("pid") is not None}
        if 0 in ks and 1 in ks and not (ks[0]["edgeClipped"] or ks[1]["edgeClipped"]):
            # 肩だけの人（腰が画面の外）には SHR が無い。身長（bbox の高さ = 画面に見えている高さ）と肩幅は比べる
            if ks[0].get("shr2d") is not None and ks[1].get("shr2d") is not None:
                d_shr.append(ks[0]["shr2d"] - ks[1]["shr2d"])
            d_h.append(ks[0]["bboxHpx"] - ks[1]["bboxHpx"])
            d_sw.append(ks[0]["shoulderW"] - ks[1]["shoulderW"])
    if not d_h:
        return None

    def med(v):
        s = sorted(v)
        return s[len(s) // 2]

    score = (2 * (1 if med(d_shr) >= 0 else -1) if d_shr else 0) \
        + (1 if med(d_h) >= 0 else -1) \
        + (1 if med(d_sw) >= 0 else -1)
    shr_txt = f"{med(d_shr):.3f}" if d_shr else "None"
    print(f"leader cluster vote: medSHRdiff={shr_txt} medHdiff={med(d_h):.1f} "
          f"medSWdiff={med(d_sw):.1f} score={score} pairs={len(d_h)} shrPairs={len(d_shr)}", file=sys.stderr)
    return 0 if score > 0 else 1


HINT_SIZE_RATIO = 0.7  # ヒントを当てるコマ: 2 人とも本人の bbox 高さの中央値のこの割合以上（観客・背景の人を拾ったコマを除く）
HINT_MAX_SEC = 2.0     # ヒントの時刻からこの秒数以内のコマが無ければ使わない


def leader_from_hint(draw_frames, leader_pid, leader_hint):
    """Claude アンカー（例: right@5.00）で Leader の pid を決める。使えなければ leader_pid のまま。

    ヒントの時刻にいちばん近い「きれいな」コマ（2 人とも本人の背丈で写り、bbox が SEGMENT_IOU 未満しか重ならない）で、
    指定の側にいる pid を Leader とする。以前は単に一番近いコマを使っていたので、screenrec（cb822fe5）の 0 秒のように
    女性と背景の小さな人が 2 人として写ったコマで右の人（背景）を Leader にし、全編の男女が逆になっていた。
    窓の多数決（ヒントから 2 秒）にすると、1230b3d5 のように 0.3 秒で 2 人が入れ替わる動画で逆になる"""
    try:
        side, t_str = leader_hint.split("@")
        t_hint = float(t_str)
    except ValueError as e:
        print(f"leader hint ignored: {e}", file=sys.stderr)
        return leader_pid
    if side not in ("left", "right"):
        print(f"leader hint ignored: side={side}", file=sys.stderr)
        return leader_pid
    pairs = []
    for df in draw_frames:
        by_pid = {p.get("pid"): p for p in df["kept"] if p.get("pid") is not None}
        if 0 in by_pid and 1 in by_pid:
            pairs.append((abs(df["t"] - t_hint), by_pid))
    if not pairs:
        print(f"leader hint unusable (no pair frame near t={t_hint})", file=sys.stderr)
        return leader_pid

    def height(p):
        return p["bbox"][3] - p["bbox"][1]
    med = {k: sorted(height(bp[k]) for _, bp in pairs)[len(pairs) // 2] for k in (0, 1)}
    clean = [x for x in pairs if all(height(x[1][k]) >= HINT_SIZE_RATIO * med[k] for k in (0, 1))
             and bbox_iou(x[1][0]["bbox"], x[1][1]["bbox"]) < SEGMENT_IOU]
    d, by_pid = min(clean or pairs, key=lambda x: x[0])
    if d > HINT_MAX_SEC:
        print(f"leader hint unusable (no pair frame near t={t_hint})", file=sys.stderr)
        return leader_pid
    right_pid = 0 if by_pid[0]["hipX"] >= by_pid[1]["hipX"] else 1
    anchored = right_pid if side == "right" else 1 - right_pid
    if anchored != leader_pid:
        print(f"leader anchor override: {leader_pid} -> {anchored} (hint={leader_hint})", file=sys.stderr)
    else:
        print(f"leader anchor agrees with CV vote (hint={leader_hint})", file=sys.stderr)
    return anchored


# --- 技イベント検出（ロードマップ②: Turn / CBL のタイムスタンプ候補） ---
# ブラウザ版 usePoseEstimation.ts の runPatternDetection() を、オフライン+外見ID前提で強化移植。
# あくまで「候補」であり誤検出があり得る。最終的な採用可否・命名は P2 の Claude が裁定する

TURN_FLIP_WINDOW = 1.5     # この秒数以内に向き反転が2回 = 一回転（360°）
TURN_FLIP_MARGIN = 0.015   # 左右肩のX分離がこれ未満（真横向き）は向き不定として無視
TURN_SWEEP_MIN = 0.04      # 反転の前後で要求する肩分離の振り幅（しっかり正面/背面まで回ったこと）
TURN_PRE_SEC = 1.0         # 1回目の反転前にこの秒数以内で旧向きの振り幅があること
TURN_CHAIN_GAP_SEC = 0.6   # 連続回転（ダブルターン）とみなす反転ペア間の最大間隔
TURN_MAX_ROTATIONS = 3     # 連続回転として連結する反転ペアの上限（それ以上はジッタの可能性が高い）
# 回転数の数え方の上限。連結（上の上限）とは別に、反転の総数から数える（detect_turns の最後）
TURN_COUNT_MAX = 4
CBL_MIN_SEP = 0.08         # 交差前後で必要な左右分離（正規化X。ジッタの往復を弾く）
CBL_WINDOW_SEC = 2.0       # 交差の前後この秒数内に十分な分離があること
CBL_PIVOT_SUPPRESS_SEC = 0.8  # CBL・女性のターンの±この秒数内のリーダーのターンはピボット・連られ回転として棄却
# 1.2 → 0.8（10/4、正解表 5 本を 0.1 秒刻みで読み直した版。eval_ground_truth.py tracks モードの合計）:
# 男のターン P/R/F1 .333/.111/.167 → .333/.222/.267、向き 17/23 → 18/24、回転数の誤差 .375 → .36、CBL・女性のターンは不変。
# 0.5 だと F1 .353 まで上がるが向きの正答率が .731 に下がり、0（フィルタ無し）は P .30 に落ちる
# 本物の男性ターンも落とすが、精度優先で残す（10/3 に正解表5本で検証）:
# この条件だけで落ちる正味360°以上の候補は6件で、本物は screenrec 23.57（CBL の 0.93秒後）の1件のみ。
# 残り5件は CBL の −1.08〜+1.03秒に散らばっており、窓幅では本物だけを残せない。
# もう1件の取りこぼし（screenrec 13.3）は、直前に棄却される候補（11.18）からの EVENT_COOLDOWN_SEC で
# 塞がれ、1.5秒遅れて検出されたもの。冷却を 2.0秒に縮めても男性は戻らず、女性ターンの P が 0.70→0.60 に落ちる
# リーダーのターン（detect_leader_turns）: 向きの反転ペア（= 1 回転）を1つずつ見て、2つの反転の回る向きが
# 揃ったもの（RR / LL）だけを残す。男性が振り返って戻る・相手を見て向き直る動きは RL / LR（正味0°）になる。
# 旧版（detect_turns の候補に後からフィルタ）は、CBL・女性のターンの近くで捨てられる候補でも冷却（2.5 秒）を
# 張っていたので、その後の本物のターンまで塞いでいた（bb0efcb9 の 31.2・33.9・34.9 は 3 件ともこれ）。
# また連続回転の連結が男の左→右の別々のターンや CBL のピボットを1つにまとめ、時刻が始まりの反転に寄っていた
# （29.45 の候補が 31.2 のターンを含んで CBL 29.99 の近くで捨てられる、2fda2815 7.0 が 5.91 になる等）。
# 10/4、正解表 5 本（tracks モード）: 男のターン P/R/F1 .333/.222/.267 → .462/.667/.545（tp 2→6、fp 4→7）、
# CBL・女性のターンは不変。向きは対応した男のターン 7 件中 6 件（外れは向きを決めきれない bb0efcb9 16.6）
LEADER_FLIP_WINDOW = 2.0   # 男のターンの反転の間隔の上限（1.5 → 2.0 秒、README 45）
LEADER_TURN_COOLDOWN_SEC = 0.8   # 男のターン同士の最小間隔（1.5 → 0.8、README 32。33.9 の左の 1 秒弱後に逆へもう 1 回回る bb0efcb9 34.9 のため。冷却なしは fp +1）
# 男の振り返りの誤検出（img1884 の背中側から撮った男が正面を見せて戻る等）: 肩の左右（shDx の符号）の反転は、
# YOLO が背中向きの人の左右の肩を付け違えたときにも起きる。本当に回ったなら反転のたびに正面 ↔ 背中が入れ替わり、
# 顔（鼻）の見え方も変わる。そこで反転ペアの2つ目の反転の前後で、それぞれいちばん正対したコマ（|shDx| 最大）の
# 鼻の信頼度が LEADER_FACE_SEEN をまたいで変わらないもの（正面のまま・背中のまま）は回転ではないとして捨てる。
# 1つ目の反転にも同じ条件をかけると screenrec 13.3 の本物（前の回転の続きで1つ目の前後が正面のまま）を落とす
LEADER_FACE_FLIP_CHECK = True
LEADER_FACE_SEEN = 0.4
LEADER_FACE_FLIP_BOTH = False
LEADER_FACE_FLIP_START = True   # 回転の始まり（直前に反転が無い）の 1 つ目の反転にも顔の見え方の変化を求める（README 46）
LEADER_FACE_MIN_FRAC = 0.6   # 0 = 従来（|shDx| 最大のコマの鼻）。>0 なら、最大の この倍以上のコマのうち鼻の信頼度の最小（README 32）
EVENT_COOLDOWN_SEC = 2.5   # ターンの最小間隔（冷却を縮める・終わりから測る等は README 20 で試して不採用）
# CBL の最小間隔。2.5秒だと 1.3〜2秒間隔で続く CBL を落としていた（9/23 人手校正で2件の取りこぼしを実測）。
# 往復ジッタは CBL_MIN_SEP / CBL_WINDOW_SEC の分離条件で弾けるので、ここは短くてよい
CBL_COOLDOWN_SEC = 0.6
# CBL の時刻は腰の交差（10fps で新しい側に最初に読めたコマ）から一定の遅れを引いて、実際の通過の瞬間に寄せる。
# 腰の交差は通過より遅れる（refine_events の計測で正解の通過→交差の遅れは 47 件の中央値 +0.41 秒）。
# 元の交差の時刻は tCross に残し、通る側・手の高さ・ホールド・男のターンの随伴フィルタ、振付シートの格子
# （normalize_routine の SWAP_BEAT は交差の時刻で合わせてある）、refine_events はそちらを使う。
# 10/4、正解表 5 本（tracks モード）: CBL P/R/F1 .733/.821/.775 → .819/.881/.849（1230b3d5 .600/.774/.676 →
# .757/.903/.824、ほかの 4 本は不変）。0.2 で .829、0.3 で .835、0.5 で .855（ただし 0.5 は 1230b3d5 の
# 後半 120 秒以降のように遅れの小さい区間で前に行き過ぎる。中央値に合わせて 0.4）
CBL_TIME_SHIFT_SEC = 0.4
# CBL の判定から外す「背の縮んだ」コマ: 本人の前後 CBL_SIZE_WIN_SEC 秒の bbox 高さ中央値の
# この割合未満。ペアが重なって片方が隠れたコマで、背景の小さいダンサー（ペアの 0.55〜0.67 倍）が
# 2人目として拾われ、左右の偽の入れ替わりになる（1230b3d5 の CBL 誤検出の主因。57〜60秒のディップ等）。
# 5本で CBL P 0.687→0.76・R 0.851 のまま、他の指標は不変（eval_ground_truth.py）。
# 0.75 にすると本物の交差のコマも落ちて R 0.821 に下がるので上げない
CBL_SIZE_RATIO = 0.7
CBL_SIZE_WIN_SEC = 3.0
# ターンの向きの目安（spin）を見る窓: イベント時刻の前後
SPIN_PRE_SEC = 0.4
SPIN_POST_SEC = 1.6
SPIN_KP_MIN = 0.3
# 女性のターンの向きは、固定窓（時刻の -0.4〜+1.6 秒）ではなく、そのターンを作った反転（最初の反転〜連なりの最後の
# 反転。単発の反転ペアなら 2 つ目の反転）だけで読む。隣のターンの反転は入れない（前のターンの最後の反転より後、次の
# ターンの最初の反転より前）。固定窓は短いターンでは次のターンの反転まで読み、長い連続回転では途中で切れていた:
# 8c312c6d 12.82（12.3〜12.9 の左回り。続く 13.70 の右回りの反転 3 つまで窓に入って LRRR → 右）と
# screenrec 16.68（左 1 → 右 3 の 16.68〜19.29 を 18.3 で切って左 1½ / 右 1½ の同数 → 左）。
# 10/4、正解表 6 本（tracks モード、保存した YOLO の検出）: 向き 37/40 → 39/40、spin の回転数の誤差 .362 → .287、
# イベント・通る側・回転数（rotations）は不変。揺らし検査（5 通り）でも向きはどれも +2、イベントの差分は 48 のまま。
# 余裕 0〜0.4 秒で向きは同じ。隣のターンで切らない版は余裕 0.3 秒以上で 12.82 が戻る。README 22
SPIN_USE_TURN_SPAN = True
SPIN_SPAN_FRAME_SEC = 0.15   # 反転の 1 つ前のコマを入れるための余裕（10fps の 1 コマ + α）
SPIN_SPAN_MARGIN_SEC = 0.1


# 速い連続回転: 反転が TURN_CHAIN_GAP_SEC 以内の間隔で MIN〜MAX 個続く連なり（2½〜3 回転）。
# EVENT_COOLDOWN_SEC は「前のターンの始まり」から測るので、CBL の通過や前のターンの 1.3〜2.5 秒後に始まる
# 頭上の連続回転を落としていた（2fda2815 の 11.2 / 13.8 / 19.2 を 3 件とも見逃し）。また冷却が明けた所、
# つまり回転の終わり際から始まったターンは回転数を少なく数えていた（bb0efcb9 8.5: 右 2½ を 1）。
# そこで冷却で落ちた連なりはターンとして足し、連なりの最後の TAIL 個の反転から始まっていたターンは
# この連なりに置き換える（始まりを前へ、回転数を連なり全体で数え直す）。それ以外と重なるときは何もしない。
# 10/4、正解表 5 本（tracks モード）: 女性のターン P/R .800/.828 → .844/.931、向き 23/24 → 26/27、
# 回転数の誤差 .360 → .304、CBL・男のターンは不変。MIN=4 は向き 25/27（2fda2815 5.9 の CBL の通過の
# 半回転から始めて逆向きを読む）、MIN=3 は往復・歩きの向き直りまで拾って P .771。MAX を 7 以上にすると
# 入れ替わりの前後の揺れ（bb0efcb9 21〜23.5 の 8 反転など）まで1つにまとめる
TURN_FAST_MIN_FLIPS = 5
TURN_FAST_MAX_FLIPS = 6
TURN_FAST_TAIL_FLIPS = 2
# 半回転の取り込み: 冷却が明けた所で拾ったターンが、2つ目の反転でちょうど速い連続回転の始まりに乗っているだけ
# （遅い反転ペア = 歩き込み・CBL の通過の半回転）のとき、上の「それ以外と重なるときは何もしない」に当たって
# 連続回転が冷却に隠れていた。8c312c6d 27.41（半回転、1.27 秒かけた反転ペア）が 28.68〜30.05 の
# 5 反転の右 2 回転（正解 29.6）を塞いでいたのがこれ。そこでその半回転は捨てて連続回転に置き換える。
# 10/4、正解表 6 本（tracks モード、保存した YOLO の検出）: 女性のターン P/R .914/.865 → .917/.892（tp 32 → 33）、
# 向き 36/38 → 37/39、回転数の誤差 .329 → .295、CBL・男のターン・通る側は不変（screenrec 29.0 も 28.42 の
# 1 回転 → 29.17 の 2 回転に）。半回転を残して連続回転を足す版は fp +1。README 20
TURN_FAST_ABSORB_LEAD = True
# 頭上の手の下での連続回転: 相手（男）の手首が頭より上にある間の反転の連なりは、TURN_FAST_MAX_FLIPS を超えても
# 連続回転として扱う。男が手を頭上に上げて女性を回している間は女性が速く何回も回れるが、入れ替わりの前後の揺れ
# （bb0efcb9 21〜23.5 の 8 反転など）では手は下がっている。8c312c6d 13.9（13.70〜15.76 の 7 反転、頭上で手をつないで
# 左回り）がこれで、12.82 のターンの冷却に隠れていた。手は左右どちらでもよい（内側/外側は回る向きで決まり、手では決まらない）。
# 連なりの終わりは手が上がっていた最後の反転で切る（15.37〜15.76 は 15.9 の CBL の通過の半回転）。
# 手前で終わるターン（12.82、正解 12.6 の 1 回転）は、上の取り込み（半回転の歩き込み）と違って本物なので残す。
# 10/4、正解表 6 本（tracks モード）: 女性のターン P/R .917/.892 → .919/.919（tp 33 → 34）。README 21
TURN_RAISED_MAX_FLIPS = 12    # 0 = 無効。7〜99 で結果は同じ（ほかに手が頭上の長い連なりは無い）
TURN_RAISED_MIN_RATIO = 0.5   # 連なりの間、相手の手首が頭より上にあったコマの割合（13.9 は 0.59。0.6 では外れる）
TURN_RAISED_WHO = "partner"   # partner / self / either（0.5 ならどれも同じ。0.4 にすると self / either は男のターンを落とす）
TURN_RAISED_TRIM = True       # 連なりの終わりを、手が上がっていた最後の反転で切る（回転数 3 → 2、正解 1½）
TURN_RAISED_KEEP_LEAD = True  # 手前で終わるターンを残す（False だと 12.6 を落として R は変わらない）
# CBL の通過の半回転: 反転が 2 つだけ（½〜1 回転未満）で、その反転の間（± 1 コマ）に CBL の腰の交差があるものは
# 女性のターンとして出さない。CBL の通過では女性は相手に向き合ったまま ½ 回って反対側へ出るので、肩の左右が 2 回入れ替わる
# ことがあるが、CBL＋ターンなら通過の½に 1 回転が足されて反転は 3 つ以上になる。誤検出だった 2fda2815 3.91
# （クローズドから開いて正面へ）・screenrec 10.72（CBL 10.6）・19.29（入れ替わり 20.4）は 3 件ともこの形。
# 捨てた半回転も男のターンの随伴フィルタには使う（通過で男も一緒に回る）。
# 10/4、正解表 6 本（tracks モード）: 女性のターン P/R .919/.919 → 1.000/.919（fp 3 → 0）、全体 F1 .884 → .895、
# ほかは不変、揺らし検査の食い違い 48 → 48。余裕 0 は 2fda2815 の d2 で 3.91 が 4.00 にずれて残り食い違い 50、
# 0.2 以上は screenrec 22.36（CBL の 0.28 秒前に終わる本物の 1 回転）まで落とす。README 23
TURN_CBL_HALF_DROP = True
TURN_CBL_HALF_MARGIN = 0.1
TURN_CBL_HALF_KEEP_SUPPRESS = True
# 冷却の内の、手を上げ直したターン（試して出していない。既定は無効）: 前のターンの反転から TURN_REARM_GAP 秒以上空き、
# 次のターンとも離れた反転ペアで、本人（女性）の手首が頭上だったコマが TURN_REARM_RATIO 以上なら、冷却の内でもターンとして足す。
# 8c312c6d 22.7 は拾える（全体 F1 .900）が、揺らし検査の食い違いが 48 → 51 に増える。README 23
TURN_REARM_RATIO = 0.0
# 反転の連なり（セグメント）を先に区切る方式（README 35）。False なら従来の冷却だけの流れ
TURN_SEGMENTS = os.environ.get("MOTION_LAB_TURN_SEGMENTS", "0") == "1"   # 環境変数は比較用
TURN_SEG_GAP_SEC = float(os.environ.get("MOTION_LAB_TURN_SEG_GAP", "1.0"))   # この秒数以内の間隔で続く反転を同じ連なりとする
TURN_REARM_GAP = 0.8
TURN_REARM_WHO = "self"
TURN_REARM_PRE_SEC = 0.3


def wrist_over_head(p):
    """左右どちらかの手首が本人の頭（鼻。鼻が読めなければ肩の上 0.05）より上か。読めなければ None"""
    k = p.get("kps") if p else None
    if not k:
        return None
    if k[0][2] >= SPIN_KP_MIN:
        head_y = k[0][1]
    else:
        sh = [k[i][1] for i in (LEFT_SHOULDER, RIGHT_SHOULDER) if k[i][2] >= SPIN_KP_MIN]
        if not sh:
            return None
        head_y = min(sh) - 0.05
    ws = [k[i][1] for i in (LEFT_WRIST, RIGHT_WRIST) if k[i][2] >= SPIN_KP_MIN]
    return bool(ws) and min(ws) < head_y


def raised_samples(draw_frames, pid, who="partner"):
    """[(t, 手が頭上か)]（読めたコマのみ）。who: partner = 相手の手、self = 本人、either = どちらか"""
    out = []
    for df in draw_frames:
        ps = {p.get("pid"): p for p in df["kept"] if p.get("pid") in (0, 1)}
        vals = []
        if who in ("partner", "either"):
            vals.append(wrist_over_head(ps.get(1 - pid)))
        if who in ("self", "either"):
            vals.append(wrist_over_head(ps.get(pid)))
        vals = [v for v in vals if v is not None]
        if vals:
            out.append((df["t"], any(vals)))
    return out


def segment_flips(times, gap):
    """反転の時刻列を、隣との間隔が gap 以内で続く連なりに区切る。[(最初の番号, 最後の番号)]（純粋な関数）"""
    segs, a = [], 0
    for k in range(1, len(times) + 1):
        if k == len(times) or times[k] - times[k - 1] > gap:
            segs.append((a, k - 1))
            a = k
    return segs if times else []


def cbl_half_segments(segs, times, cbl_times, margin):
    """連なりのうち、反転が 2 つ以下で、その範囲（± margin）に CBL の腰の交差があるもの（= CBL の通過の半回転）"""
    return [(a, b) for a, b in segs
            if b - a + 1 <= 2 and any(times[a] - margin <= c <= times[b] + margin for c in cbl_times)]


def detect_turns(draw_frames, pid, with_span=False, cbl_times=None):
    """指定人物のターン候補時刻を返す。

    COCO キーポイントは左肩(5)と右肩(6)を区別するため、画面上での左右肩の
    並び順（shDx の符号）は体が正面向きか背面向きかを直接表す。
    回転すると 90°/270° を跨ぐたびに符号が反転する = 一回転で2回反転。
    「TURN_FLIP_WINDOW 秒以内の2回反転」かつ「反転の前・間でしっかり
    正面/背面まで振れた（TURN_SWEEP_MIN 以上）」をターンとして検出する。
    振り幅の条件が無いと、際どい向きでのジッタ反転を大量に誤検出する（実測）。
    （初版の「肩幅の収縮」方式は横向きポーズや相手の動きでも誤発火したため廃止）
    """
    series = []  # (t, shDx) 向きが確定できるサンプルのみ
    for df in draw_frames:
        for p in df["kept"]:
            if p.get("pid") == pid and abs(p["shDx"]) >= TURN_FLIP_MARGIN:
                series.append((df["t"], p["shDx"]))
    flips = []  # (時刻, 反転前の符号)
    for (t0, d0), (t1, d1) in zip(series, series[1:]):
        if (d0 > 0) != (d1 > 0):
            flips.append((t1, 1 if d0 > 0 else -1))

    def sweep_ok(t_from, t_to, sign):
        """区間内に sign 向きで TURN_SWEEP_MIN 以上の分離があるか"""
        return any(d * sign >= TURN_SWEEP_MIN for t, d in series if t_from <= t <= t_to)

    def pair_ok(i):
        (t1, sign_before), (t2, _) = flips[i], flips[i + 1]
        return (t2 - t1 <= TURN_FLIP_WINDOW
                and sweep_ok(t1 - TURN_PRE_SEC, t1, sign_before)   # 反転前: 旧向きでしっかり見えていた
                and sweep_ok(t1, t2, -sign_before))                # 反転間: 背面までしっかり回った

    def chain_end(i):
        j = i
        while j + 1 < len(flips) and flips[j + 1][0] - flips[j][0] <= TURN_CHAIN_GAP_SEC:
            j += 1
        return j

    spans = []  # [最初の反転の番号, 最後の反転の番号, 時刻]（回転数を数える範囲）
    last_event = -1e9
    seg_half = None
    if TURN_SEGMENTS and cbl_times:
        # 連なり（セグメント）への先の区切り: 反転の間隔が TURN_SEG_GAP_SEC 以内で続く反転を1つの連なりにする。
        # 反転が 2 つだけで、その間に CBL の腰の交差がある連なりは「CBL の通過の半回転」で、後で捨てる候補なので
        # 冷却を張らない（次の本物のターンを塞がない）。連なりの区切りは過去の採否に依らず決まる
        seg_half = {a for a, b in cbl_half_segments(segment_flips([f[0] for f in flips], TURN_SEG_GAP_SEC),
                                                     [f[0] for f in flips], cbl_times, TURN_CBL_HALF_MARGIN)}
    i = 0
    while i + 1 < len(flips):
        (t1, sign_before), (t2, _) = flips[i], flips[i + 1]
        if seg_half is not None and i in seg_half and t1 - last_event > EVENT_COOLDOWN_SEC and pair_ok(i):
            spans.append([i, chain_end(i), t1])   # 半回転は出すが冷却は張らない
            i += 2
        elif t1 - last_event > EVENT_COOLDOWN_SEC and pair_ok(i):
            # 連続回転（ダブルターン等）: 「直後（0.6秒以内）に始まり、振り幅条件も満たす」
            # 反転ペアのみ連結する。緩い連結は後続の別ターンやジッタを際限なく飲み込む（実測: rotations=10）
            rotations = 1
            i_start = i
            i += 2
            while (
                rotations < TURN_MAX_ROTATIONS
                and i + 1 < len(flips)
                and flips[i][0] - t2 <= TURN_CHAIN_GAP_SEC
                and flips[i + 1][0] - flips[i][0] <= TURN_FLIP_WINDOW
                and sweep_ok(flips[i][0], flips[i + 1][0], -flips[i][1])
            ):
                rotations += 1
                t2 = flips[i + 1][0]
                i += 2
            spans.append([i_start, chain_end(i_start), t1])
            last_event = t1
        else:
            i += 1

    # 速い連続回転（反転 TURN_FAST_MIN_FLIPS〜TURN_FAST_MAX_FLIPS 個の連なり）: 冷却で落ちたものを足し、
    # 回転の終わりの方（最後の TURN_FAST_TAIL_FLIPS 個の反転）から始まっていたターンはこの回転に置き換える
    raised = raised_samples(draw_frames, pid, TURN_RAISED_WHO) if TURN_RAISED_MAX_FLIPS else []

    def raised_end(t_from, t_to):
        """区間内で手が頭上だったコマの割合が足りれば、手が上がっていた最後の時刻。足りなければ None"""
        vals = [(t, r) for t, r in raised if t_from <= t <= t_to]
        if len(vals) < 3 or sum(r for _, r in vals) < TURN_RAISED_MIN_RATIO * len(vals):
            return None
        return max(t for t, r in vals if r)

    i = 0
    while i + 1 < len(flips):
        j_chain = j = chain_end(i)
        raised_run = False
        if TURN_RAISED_MAX_FLIPS and TURN_FAST_MAX_FLIPS < j - i + 1 <= TURN_RAISED_MAX_FLIPS:
            t_up = raised_end(flips[i][0], flips[j][0])
            if t_up is not None:
                raised_run = True
                if TURN_RAISED_TRIM:
                    j = max(k for k in range(i, j + 1) if k == i or flips[k][0] <= t_up + 0.1)
                    j = max(j, i + TURN_FAST_MIN_FLIPS - 1)
                ok_n = True
            else:
                ok_n = False
        else:
            ok_n = TURN_FAST_MIN_FLIPS <= j - i + 1 <= TURN_FAST_MAX_FLIPS
        if ok_n and pair_ok(i):
            # 既存のターンの範囲は2つ目の反転までは含む（間隔が空いて連なりの直前で終わるものも重なりとみなす）
            over = [s for s in spans if s[0] <= j and max(s[1], s[0] + 1) >= i]
            # 連なりの前で始まり、2つ目の反転が連なりの最初の反転になっているだけのターン（半回転の歩き込み）
            lead = [s for s in over if s[0] < i and s[1] < i] if TURN_FAST_ABSORB_LEAD else []
            rest = [s for s in over if s not in lead]
            if all(i < s[0] and s[0] > j - TURN_FAST_TAIL_FLIPS for s in rest):
                drop = rest if (raised_run and TURN_RAISED_KEEP_LEAD) else over
                spans = [s for s in spans if s not in drop] + [[i, max([j] + [s[1] for s in rest]), flips[i][0]]]
        i = j_chain + 1
    spans.sort()
    if TURN_REARM_RATIO > 0:
        rearm = raised_samples(draw_frames, pid, TURN_REARM_WHO)
        added = []
        i = 0
        while i + 1 < len(flips):
            prev = [s for s in spans + added if s[0] < i]
            nxt = [s[0] for s in spans if s[0] > i]
            ok = bool(prev) and pair_ok(i)
            if ok:
                p = max(prev)
                p_end = min(len(flips) - 1, max(p[1], p[0] + 1))
                ok = (i > p_end and flips[i][0] - p[2] <= EVENT_COOLDOWN_SEC
                      and flips[i][0] - flips[p_end][0] >= TURN_REARM_GAP
                      and not (nxt and min(nxt) <= i + 1))
            if ok:
                t1, t2 = flips[i][0], flips[i + 1][0]
                vals = [r for t, r in rearm if t1 - TURN_REARM_PRE_SEC <= t <= t2]
                ok = len(vals) >= 2 and sum(vals) >= TURN_REARM_RATIO * len(vals)
            if ok:
                j = chain_end(i)
                if nxt:
                    j = min(j, min(nxt) - 1)
                if nxt and flips[min(nxt)][0] - flips[max(j, i + 1)][0] < TURN_REARM_GAP:
                    i += 1  # 次のターンと同じ連なり（その前触れ）
                    continue
                added.append([i, j, flips[i][0]])
                i = max(j, i + 1) + 1
            else:
                i += 1
        spans = sorted(spans + added)
    # 回転数 = 範囲内の反転の数 / 2（切り捨て）。10fps の骨格では速い連続回転は1周3〜4コマしかなく、
    # 反転ペアの連結（振り幅条件つき）では途中のペアが条件を外して少なく数えるので、連結はターンの区切りにだけ使い、
    # 回転数は反転の総数から数える（正解表2本の回転数 MAE 0.43 → 0.29）。
    # ½ 刻み（反転の数 / 2 をそのまま）は正解表 5 本で誤差 .36 → .38 と悪くなるので切り捨てのまま
    if with_span == "count":
        # (時刻, 回転数, 最初の反転, 最後の反転（単発のペアなら 2 つ目）, 反転の数)
        return [(round(t, 2), max(1, min(TURN_COUNT_MAX, (b - a + 1) // 2)), flips[a][0],
                 flips[min(len(flips) - 1, max(b, a + 1))][0], min(len(flips) - 1, max(b, a + 1)) - a + 1)
                for a, b, t in spans]
    if with_span == "pair":
        # 向きを読む範囲: 1 つ目の反転から、連なりの最後の反転（単発の反転ペアなら 2 つ目の反転）まで
        return [(round(t, 2), max(1, min(TURN_COUNT_MAX, (b - a + 1) // 2)), flips[a][0],
                 flips[min(len(flips) - 1, max(b, a + 1))][0]) for a, b, t in spans]
    if with_span:
        return [(round(t, 2), max(1, min(TURN_COUNT_MAX, (b - a + 1) // 2)), flips[a][0], flips[b][0])
                for a, b, t in spans]
    return [(round(t, 2), max(1, min(TURN_COUNT_MAX, (b - a + 1) // 2))) for a, b, t in spans]


# 頭上で女性を回している間の男の反転は随伴回転: 女性のターンの範囲（最初〜最後の反転）の中で、2 人のどちらかの手首が
# 頭より上にあったコマが LEADER_IN_SPIN_RAISED 以上なら、その範囲の男のターンは捨てる。男が手を上げて女性を回すと、
# 男の上体も女性について回る（2fda2815 12.00 は女性の 10.86〜12.38 の連続回転の中、screenrec 17.61 は 16.68〜19.29 の中）。
# ±CBL_PIVOT_SUPPRESS_SEC の窓は女性のターンの始まりからしか測らないので、長い連続回転の後半を拾えていなかった。
# 10/4、正解表 6 本（tracks モード）: 男のターン F1 .600 → .667（fp 4 → 2）、ほかは不変。手の条件を外す（範囲だけ）と
# bb0efcb9 12.73（optional の正解に当たっていた男の左回り）も落ちて向きが 37/39 → 36/38。0.4〜0.6 で結果は同じ。README 21
LEADER_IN_SPIN_SUPPRESS = True
LEADER_IN_SPIN_RAISED = 0.5       # >0 なら、その範囲で手が頭上（どちらかの人）だったコマの割合がこれ以上のときだけ捨てる
LEADER_IN_SPIN_MARGIN = 0.0       # 範囲の前後に足す秒数（0.3 でも同じ）


# 男の回る向きが、近くの女性のターンの向きと逆なら、女性を回すときの上体の連れ回りではない（連れ回りは女性と同じ向きに
# 肩がひねられる）ので、随伴フィルタ（女性のターンの ±CBL_PIVOT_SUPPRESS_SEC）で落とさない（README 32）。
# 女性の向きは spin_hint の正味（netDeg）で、読めない・0 のときは従来どおり落とす。CBL の近傍は変えない
LEADER_COUNTER_ROT_KEEP = True
LEADER_DROP_GLITCH = True
LEADER_GLITCH_MAX_SEC = 0.25   # 前後の同符号のコマがこの秒数以内（10fps の連続した 3 コマ）に収まるものだけ。穴の空いた列は触らない


def detect_leader_turns(draw_frames, pid, cbl_times, follower_turn_times, follower_spans=(), with_span=False,
                        follower_turn_dirs=None):
    """男のターン: 向きの反転ペア（= 1 回転）を1つずつ見て、2つの反転が同じ向き（RR / LL）に読めたものだけ残す。
    follower_spans: 女性のターンの [(最初の反転, 最後の反転)]
    follower_turn_dirs: {女性のターンの時刻: +1（右）/ -1（左）}。LEADER_COUNTER_ROT_KEEP で逆向きを随伴から外す
    戻り値: [(時刻, 回転数, spin)]。with_span なら [(時刻, 回転数, spin, 最初の反転, 最後の反転)]"""
    in_spin = []
    if LEADER_IN_SPIN_SUPPRESS:
        raised = raised_samples(draw_frames, pid, "either") if LEADER_IN_SPIN_RAISED > 0 else []
        for a, b in follower_spans:
            if LEADER_IN_SPIN_RAISED > 0:
                vals = [r for t, r in raised if a <= t <= b]
                if not vals or sum(vals) < LEADER_IN_SPIN_RAISED * len(vals):
                    continue
            in_spin.append((a - LEADER_IN_SPIN_MARGIN, b + LEADER_IN_SPIN_MARGIN))
    series = []
    for df in draw_frames:
        for p in df["kept"]:
            if p.get("pid") == pid and abs(p["shDx"]) >= TURN_FLIP_MARGIN:
                series.append((df["t"], p["shDx"], p))
    if LEADER_DROP_GLITCH:
        # 同じ符号の両側に挟まれた 1 コマだけ逆の符号は、肩の左右の付け違い（YOLO のラベルの揺れ）で、回転ではない
        # （体は 1 コマ = 0.1 秒で 180° 反転しない）。反転の列から外す
        series = [s for k, s in enumerate(series)
                  if not (0 < k < len(series) - 1 and (series[k - 1][1] > 0) == (series[k + 1][1] > 0) != (s[1] > 0)
                          and series[k + 1][0] - series[k - 1][0] <= LEADER_GLITCH_MAX_SEC)]
    flips = []  # (時刻, 反転前の符号, "R"/"L"/"?")
    for (t0, d0, p0), (t1, d1, p1) in zip(series, series[1:]):
        if (d0 > 0) == (d1 > 0):
            continue
        near, far = (p0, p1) if abs(d0) <= abs(d1) else (p1, p0)
        side = face_side(near) or face_side(far)
        r = "?" if side == 0 else ("R" if ((side < 0) if d0 > 0 else (side > 0)) else "L")
        flips.append((t1, 1 if d0 > 0 else -1, r))

    def sweep_ok(t_from, t_to, sign):
        return any(d * sign >= TURN_SWEEP_MIN for t, d, _ in series if t_from <= t <= t_to)

    def near(t, ts):
        return any(abs(t - s) <= CBL_PIVOT_SUPPRESS_SEC for s in ts)

    def companion_times(r):
        """向き r の男の回転に対して随伴とみなす女性のターンの時刻（逆向きと読めたものは除く）"""
        if not (LEADER_COUNTER_ROT_KEEP and follower_turn_dirs):
            return follower_turn_times
        mine = 1 if r == "R" else -1
        return [t for t in follower_turn_times if follower_turn_dirs.get(t, 0) != -mine]

    def face_seen(t_from, t_to, sign):
        """区間内で sign 側の向きにいちばん正対したコマで顔（鼻）が見えたか。コマが無ければ None"""
        ph = [(abs(d), p["kps"][0][2]) for t, d, p in series
              if t_from <= t < t_to and d * sign > 0 and p.get("kps")]
        if not ph:
            return None
        if LEADER_FACE_MIN_FRAC > 0:
            # 正対に近いコマ（|shDx| が最大の LEADER_FACE_MIN_FRAC 倍以上）のうち鼻がいちばん見えないコマ。
            # 10fps では背中向きの瞬間が 1 コマしか無く、最大のコマの鼻が帽子のつばや肩越しで読めてしまう
            top = max(a for a, _ in ph)
            return min(c for a, c in ph if a >= LEADER_FACE_MIN_FRAC * top) >= LEADER_FACE_SEEN
        return max(ph)[1] >= LEADER_FACE_SEEN

    def second_flip_turns(i):
        """2つ目の反転で顔の見え方（正面 ↔ 背中）が変わったか。変わらなければ肩の左右の付け違いとみなす"""
        (t1, s, _), (t2, _, _) = flips[i], flips[i + 1]
        t_next = flips[i + 2][0] if i + 2 < len(flips) else float("inf")
        mid = face_seen(t1, t2, -s)
        post = face_seen(t2, min(t2 + TURN_PRE_SEC, t_next), s)
        t_prev = flips[i - 1][0] if i >= 1 else float("-inf")
        # README 46: 1 つ目の反転も、直前 TURN_PRE_SEC 秒に別の反転が無い（= 回転の始まり）なら、反転の前後で顔の見え方が
        # 変わることを求める。前の回転の続きの 1 つ目は、前後とも正面のままでも本物がある（screenrec 13.3）ので除く
        if LEADER_FACE_FLIP_BOTH or (LEADER_FACE_FLIP_START and t1 - t_prev > TURN_PRE_SEC):
            pre = face_seen(max(t1 - TURN_PRE_SEC, t_prev), t1, s)
            if pre is not None and mid is not None and pre == mid:
                return False
        return mid is None or post is None or mid != post

    pairs = []  # (反転1の番号, 中点, 向き)
    i = 0
    while i + 1 < len(flips):
        (t1, s, r1), (t2, _, r2) = flips[i], flips[i + 1]
        tm = (t1 + t2) / 2
        # README 45: 反転の間隔は男だけ 2.0 秒まで。TURN_FLIP_WINDOW（1.5 秒）を超える遅い回転は、女性を回すときの
        # 上体のひねり（随伴）が女性のターンの長さ（≦1.5 秒）に収まることから、随伴フィルタを当てない
        if (t2 - t1 <= LEADER_FLIP_WINDOW and sweep_ok(t1 - TURN_PRE_SEC, t1, s) and sweep_ok(t1, t2, -s)
                and r1 == r2 and r1 != "?" and not near(tm, cbl_times)
                and (t2 - t1 > TURN_FLIP_WINDOW or not near(tm, companion_times(r1)))
                and not any(a <= tm <= b for a, b in in_spin)
                and (not LEADER_FACE_FLIP_CHECK or second_flip_turns(i))):
            pairs.append((i, tm, r1))
            i += 2
        else:
            i += 1
    # 同じ向きで間を空けずに続く反転ペアは連続回転として1つにまとめる（向きが変わったら別のターン）。
    # 時刻は最初の1回転の中点
    out = []  # [時刻, 回転数, 向き, 最後の反転ペアの番号, 最初の反転ペアの番号]
    for i, tm, r in pairs:
        if out and out[-1][2] == r and out[-1][3] + 2 == i and flips[i][0] - flips[i - 1][0] <= TURN_CHAIN_GAP_SEC:
            out[-1][1] += 1
            out[-1][3] = i
        else:
            out.append([tm, 1, r, i, i])
    res, last = [], -1e9
    for tm, n, r, i_last, i_first in out:
        if tm - last <= LEADER_TURN_COOLDOWN_SEC:
            continue
        last = tm
        item = (round(tm, 2), min(n, TURN_COUNT_MAX), {"seq": r * (2 * n), "netDeg": (180 if r == "R" else -180) * 2 * n})
        if with_span:
            # 回転の範囲: 最初の反転〜最後の反転（turn_span の材料。README 28）
            item += (flips[i_first][0], flips[i_last + 1][0])
        res.append(item)
    return res


def detect_cbl(draw_frames):
    """CBL（クロスボディリード）候補時刻を返す。

    CBL の定義そのものである「2人の左右位置の入れ替わり」を検出する。
    腰X差の符号反転のうち、交差の前後 CBL_WINDOW_SEC 以内に十分な分離
    （CBL_MIN_SEP 以上）が両側にあるものだけを採用（密着中のジッタを弾く）。
    どちらかが本人の普段の背丈より大きく縮んだコマは別人の取り違えとみなして使わない（CBL_SIZE_RATIO）
    """
    heights = {0: [], 1: []}  # pid -> [(t, bbox 高さ)]
    for df in draw_frames:
        for p in df["kept"]:
            if p.get("pid") in heights and p.get("bbox"):
                heights[p["pid"]].append((df["t"], p["bbox"][3] - p["bbox"][1]))

    def shrunk(pid, t, p):
        if not p.get("bbox"):
            return False
        hs = sorted(h for tt, h in heights[pid] if abs(tt - t) <= CBL_SIZE_WIN_SEC)
        return (p["bbox"][3] - p["bbox"][1]) < CBL_SIZE_RATIO * hs[len(hs) // 2]

    pair = []  # (t, hipX[pid0] - hipX[pid1])
    for df in draw_frames:
        by_pid = {p.get("pid"): p for p in df["kept"] if p.get("pid") is not None}
        if 0 in by_pid and 1 in by_pid and not any(shrunk(k, df["t"], by_pid[k]) for k in (0, 1)):
            pair.append((df["t"], by_pid[0]["hipX"] - by_pid[1]["hipX"]))
    events = []
    last_event = -1e9
    for i in range(1, len(pair)):
        t_prev, d_prev = pair[i - 1]
        t_cur, d_cur = pair[i]
        if d_prev == 0 or d_cur == 0 or (d_prev > 0) == (d_cur > 0):
            continue
        before = [d for t, d in pair if t_cur - CBL_WINDOW_SEC <= t < t_cur]
        after = [d for t, d in pair if t_cur < t <= t_cur + CBL_WINDOW_SEC]
        sign_prev = 1 if d_prev > 0 else -1
        ok_before = any(d * sign_prev >= CBL_MIN_SEP for d in before)
        ok_after = any(d * -sign_prev >= CBL_MIN_SEP for d in after)
        if ok_before and ok_after and t_cur - last_event > CBL_COOLDOWN_SEC:
            events.append(round(t_cur, 2))
            last_event = t_cur
    return events


def face_side(p):
    """顔が画面右を向いていれば +1、左なら -1、読めなければ 0（鼻と耳/肩の中点のX差）"""
    k = p.get("kps")
    if not k or k[0][2] < SPIN_KP_MIN:
        return 0
    refs = [k[i][0] for i in (3, 4) if k[i][2] >= SPIN_KP_MIN]  # 左耳・右耳
    if not refs:
        refs = [(k[5][0] + k[6][0]) / 2]  # 耳が無ければ肩の中点
    off = k[0][0] - sum(refs) / len(refs)
    if abs(off) < 0.004:
        return 0
    return 1 if off > 0 else -1


def spin_hint(draw_frames, pid, t_center, span=None):
    """ターン候補の回る向きと回転量の目安: {"seq": "RRL", "netDeg": 360} or None

    shDx の符号が変わる瞬間（真横向き）に顔が画面の右/左どちらを向いているかで、
    正面↔背中をどちら回りで通過したかが決まる（上から見て時計回り = 右回り = R）:
      正面→背中 を画面右向きで通過 = 左回り / 画面左向き = 右回り
      背中→正面 を画面右向きで通過 = 右回り / 画面左向き = 左回り
    反転ごとに ±180° を足すので、半回転して戻る動きは 0° になり1回転と区別できる。
    10fps 間引きのため速いターンで真横を取りこぼし、回転量は ±180° ずれることがある
    （9/23 の2本で向きは女性のターン10件中9件一致・量は目安）。確定は Claude がストリップで行う
    span を渡すと固定窓の代わりにそのターンの反転の範囲だけを読む（SPIN_USE_TURN_SPAN）
    """
    lo, hi = t_center - SPIN_PRE_SEC, t_center + SPIN_POST_SEC
    if span is not None:
        # span = (最初の反転, 最後の反転, 前のターンの最後の反転, 次のターンの最初の反転)。そのターンの反転だけを読む。
        # 反転は「真横を跨いだ後のコマ」の時刻なので、1 つ前のコマ（約 0.1 秒前）も入るように前へ余裕を取る
        first, last, prev_end, next_start = span
        lo, hi = first - SPIN_SPAN_FRAME_SEC - SPIN_SPAN_MARGIN_SEC, last + SPIN_SPAN_MARGIN_SEC
        if prev_end < first:
            lo = max(lo, prev_end)
        if next_start > first:
            hi = min(hi, next_start - 0.01)
    series = []
    for df in draw_frames:
        if not (lo <= df["t"] <= hi):
            continue
        for p in df["kept"]:
            if p.get("pid") == pid and abs(p["shDx"]) >= TURN_FLIP_MARGIN:
                series.append((p["shDx"], p))
    seq, net = "", 0
    for (d0, p0), (d1, p1) in zip(series, series[1:]):
        if (d0 > 0) == (d1 > 0):
            continue
        near, far = (p0, p1) if abs(d0) <= abs(d1) else (p1, p0)
        side = face_side(near) or face_side(far)
        if side == 0:
            seq += "?"
            continue
        front_to_back = d0 > 0
        right_turn = (side < 0) if front_to_back else (side > 0)
        seq += "R" if right_turn else "L"
        net += 180 if right_turn else -180
    return {"seq": seq, "netDeg": net} if seq else None


DENSE_PRE_SEC = 0.5        # 全フレーム再計測: イベント時刻のこの秒数前から見る
DENSE_MIN_POST_SEC = 1.0   # 少なくともイベント時刻のこの秒数後までは見る
DENSE_MAX_POST_SEC = 4.0   # 連続ターンでもイベント時刻のこの秒数後で打ち切る
DENSE_QUIET_SEC = 0.6      # 最後の反転からこの秒数反転が無ければ回転が終わったとみなす（回転中の反転は0.15〜0.45秒おき。0.8だとCBLの半回転まで飲み込んだ）
DENSE_JITTER_SEC = 0.12    # これより短い向きの区間は真横付近の揺れとして前後に吸収する
DENSE_MATCH_DIST = 0.2     # 追跡中の人物とみなす bbox 中心の最大ずれ（正規化）
# 全フレームの取り直しは ROI マスクも観客フィルタも無い全画面で YOLO をかけるので、近くの別人（寄りの動画の手前に座った
# 見学者など）を拾うことがある。拾った人の胴の長さが、10fps の追跡でのその人の胴の長さ（全編の中央値）の
# DENSE_SIZE_RATIO 倍未満か 1 / DENSE_SIZE_RATIO 倍より大きければ別人として使わない（0 で無効。README 30）
DENSE_SIZE_RATIO = 0.6
DENSE_OVERLAP_SEC = 0.15     # 全フレームの反転の範囲が 10fps の回転の範囲 ± この秒数と重ならなければ取り直しを捨てる（None で無効）
# 回転が続く限り読み進めると、10fps が別のターンと分けた同じ人の次のターンまで飲み込み（absorbed）、範囲の真ん中が
# どちらのターンからも外れる。True なら次のターンの 10fps の回転の始まり（の 1 コマ前）で読むのをやめ、次のターンは自分で取り直す
DENSE_SPLIT_AT_NEXT = True


def _turn_start(e):
    """ターンの回転の始まり: 10fps の範囲（span.from）、無ければ t"""
    sp = e.get("span")
    return sp["from"] if isinstance(sp, dict) and isinstance(sp.get("from"), (int, float)) else e["t"]


def _bbox_center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def torso_height(p):
    """胴の長さ（画面の高さ単位）: 肩の中点と腰の中点の高さの差。肩だけの人は推した胴（torsoN）。読めなければ None"""
    if p.get("torsoN"):
        return p["torsoN"]
    k = p.get("kps")
    if not k or len(k) <= RIGHT_HIP:
        return None
    if min(k[i][2] for i in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP)) < KP_CONF:
        return None
    t = abs((k[LEFT_HIP][1] + k[RIGHT_HIP][1]) / 2 - (k[LEFT_SHOULDER][1] + k[RIGHT_SHOULDER][1]) / 2)
    return t or None


def track_torso_median(draw_frames, pid):
    """10fps の追跡でのその人の胴の長さの中央値（画面の高さ単位）。測れたコマが無ければ None"""
    xs = sorted(x for df in draw_frames for p in df["kept"] if p.get("pid") == pid for x in [torso_height(p)] if x)
    return xs[len(xs) // 2] if xs else None


def same_body_size(p, ref_torso):
    """全フレームの取り直しで拾った人 p が、追跡中の人と同じくらいの体の大きさか（DENSE_SIZE_RATIO）"""
    if not DENSE_SIZE_RATIO or not ref_torso:
        return True
    t = torso_height(p)
    return t is None or DENSE_SIZE_RATIO <= t / ref_torso <= 1 / DENSE_SIZE_RATIO


def _spin_runs(seq):
    """反転列 "LLLRRRRRRR" を向きの連続（run）にまとめる。1回だけの逆向き（L/R の取り違えノイズ）は前後に吸収する"""
    runs = []
    for ch in seq:
        if ch == "?":
            continue
        if runs and runs[-1][0] == ch:
            runs[-1][1] += 1
        else:
            runs.append([ch, 1])
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for i, (ch, n) in enumerate(runs):
            if n != 1:
                continue
            neighbors = [runs[j][1] for j in (i - 1, i + 1) if 0 <= j < len(runs)]
            if max(neighbors) >= 2:  # 長い run の隣の単発はノイズとして消す
                del runs[i]
                merged = []
                for r in runs:
                    if merged and merged[-1][0] == r[0]:
                        merged[-1][1] += r[1]
                    else:
                        merged.append(list(r))
                runs = merged
                changed = True
                break
    return [{"dir": "right" if ch == "R" else "left", "turns": n / 2} for ch, n in runs]


def refine_turns_dense(video_path, model, draw_frames, events, leader_pid, clock=None):
    """ターン候補の区間だけ全フレームで YOLO をかけ直し、spin（回る向きと回転数）を置き換える。

    10fps 間引きでは速いターンの真横を取りこぼし、向きが消えたり回転数が半分になったりする
    （9/23 の人手校正で実測。0:16 の「左1→右3」が差し引き0になっていた）。全フレームなら
    正解の分かっている5区間すべてで向きが合い、回転数も ±半回転に収まった。
    回転が続く限り区間を延ばし（最大 DENSE_MAX_POST_SEC）、同じ人の区間内に入った後続の
    ターン候補は同じ回転の一部として吸収する（absorbed に時刻を残す）。ただし 10fps が分けた同じ人の次のターンの手前で
    読むのをやめ（DENSE_SPLIT_AT_NEXT）、体の大きさの違う人は拾わず（DENSE_SIZE_RATIO）、読めた反転が 10fps の回転の範囲と
    重ならなければ書き換えない（DENSE_OVERLAP_SEC）。README 30。
    clock（frame_time.FrameClock）: 10fps の tracks と同じ時計。シークは clock.to_pts、読んだコマの PTS は
    clock.from_pts で解析の時刻に直す（無ければ動画から作る。README 27）。
    """
    if leader_pid is None:
        return events
    tracks = {0: [], 1: []}
    for df in draw_frames:
        for p in df["kept"]:
            if p.get("pid") in tracks:
                tracks[p["pid"]].append((df["t"], p["bbox"]))

    def tracked_center(pid, t):
        best = None
        for tt, b in tracks[pid]:
            if abs(tt - t) <= 0.15 and (best is None or abs(tt - t) < best[0]):
                best = (abs(tt - t), b)
        return _bbox_center(best[1]) if best else None

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return events
    if clock is None:
        clock = frame_clock(video_path, cap.get(cv2.CAP_PROP_FPS) or 30.0)
    covered = {0: [], 1: []}  # pid → [(from, to, event)]
    ref_torso = {pid: track_torso_median(draw_frames, pid) for pid in (0, 1)}
    out = []
    turn_starts = {by: sorted(_turn_start(x) for x in events if x["type"] == "Turn" and x["by"] == by)
                   for by in ("leader", "follower")}
    for e in events:
        if e["type"] != "Turn" or e["by"] not in ("leader", "follower"):
            out.append(e)
            continue
        pid = leader_pid if e["by"] == "leader" else 1 - leader_pid
        host = next((c for c in covered[pid] if c[0] <= e["t"] <= c[1]), None)
        if host is not None:
            host[2].setdefault("absorbed", []).append(e["t"])
            continue

        t = e["t"]
        # 同じ人の次のターン（10fps の回転の始まり）の手前で読むのをやめる（DENSE_SPLIT_AT_NEXT。README 30）
        t_stop = float("inf")
        if DENSE_SPLIT_AT_NEXT:
            t_stop = next((s for s in turn_starts[e["by"]] if s > _turn_start(e) + 1e-6), t_stop) - SPIN_SPAN_FRAME_SEC
        # POS_MSEC のシークは可変フレームレートで最大 0.3 秒遅れて着くので、手前に着いたことを確かめてから読む（README 27）
        t_begin = t - DENSE_PRE_SEC
        frame, p = seek_read(cap, clock.to_pts(t_begin))
        series, prev_c, last_flip_t, t_cur = [], None, None, t
        while frame is not None:
            if p is None:
                ret, frame = cap.read()
                if not ret:
                    break
                p = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
            t_cur = clock.from_pts(p)
            p = None  # 次の周回で次のコマを読む
            if t_cur < t_begin - 1e-6:
                continue
            if t_cur > t + DENSE_MAX_POST_SEC or t_cur >= t_stop:
                break
            if t_cur > t + DENSE_MIN_POST_SEC and (last_flip_t is None or t_cur - last_flip_t > DENSE_QUIET_SEC):
                break
            persons = [q for q in detect_persons(model, frame) if same_body_size(q, ref_torso[pid])]
            ref = tracked_center(pid, t_cur)
            target = prev_c or ref
            if ref and prev_c and math.dist(prev_c, ref) > 0.15:
                target = ref  # 直前の選択が計測トラックから大きく外れたらトラックに戻す
            if not persons or target is None:
                continue
            pick = min(persons, key=lambda p: math.dist(_bbox_center(p["bbox"]), target))
            if math.dist(_bbox_center(pick["bbox"]), target) > DENSE_MATCH_DIST:
                continue
            prev_c = _bbox_center(pick["bbox"])
            if abs(pick["shDx"]) < TURN_FLIP_MARGIN:
                continue
            if series and (series[-1][1] > 0) != (pick["shDx"] > 0):
                last_flip_t = t_cur
            series.append((t_cur, pick["shDx"], pick))

        # 同じ向き（正面/背中）が続く区間にまとめ、真横付近の揺れでできた短い区間は前後に吸収する
        segs = []  # [sign, [samples]]
        for s in series:
            sign = s[1] > 0
            if segs and segs[-1][0] == sign:
                segs[-1][1].append(s)
            else:
                segs.append([sign, [s]])
        i = 1
        while i < len(segs) - 1:
            dur = segs[i][1][-1][0] - segs[i][1][0][0]
            if dur < DENSE_JITTER_SEC and segs[i - 1][0] == segs[i + 1][0]:
                segs[i - 1][1].extend(segs[i][1] + segs[i + 1][1])
                del segs[i:i + 2]
            else:
                i += 1

        seq, net, flip_times = "", 0, []
        for a, b in zip(segs, segs[1:]):
            t0, d0, p0 = a[1][-1]
            t1, d1, p1 = b[1][0]
            near, far = (p0, p1) if abs(d0) <= abs(d1) else (p1, p0)
            side = face_side(near) or face_side(far)
            flip_times.append(t1)
            if side == 0:
                seq += "?"
                continue
            right = (side < 0) if d0 > 0 else (side > 0)
            seq += "R" if right else "L"
            net += 180 if right else -180
        coarse_span = e.get("span") if isinstance(e.get("span"), dict) else None
        if seq and DENSE_OVERLAP_SEC is not None and coarse_span and (
                flip_times[0] > coarse_span["to"] + DENSE_OVERLAP_SEC
                or flip_times[-1] < coarse_span["from"] - DENSE_OVERLAP_SEC):
            # 全フレームで読めた反転が 10fps で見つけた回転の範囲と重ならない = 本人を見失って別の動き（次の技・相手）を
            # 読んだ。spin・範囲は 10fps のまま（README 30）
            seq = ""
        if seq:
            if isinstance(e.get("spin"), dict) and "spinCoarse" not in e:
                # 10fps の向きの読み（spin_hint。反転ペアの向き・21〜23 の直し込み）を残す。全フレームの取り直しは
                # 回転数には効くが向きを上書きして外すことがあり、振付シートは向きを 10fps から読む（README 25）
                e["spinCoarse"] = e["spin"]
            e["spin"] = {
                "seq": seq, "netDeg": net, "runs": _spin_runs(seq),
                "from": round(flip_times[0], 2), "to": round(flip_times[-1], 2), "source": "fullFrames",
            }
            set_turn_span(e, flip_times[0], flip_times[-1], source="fullFrames")
            covered[pid].append((flip_times[0], flip_times[-1], e))
        out.append(e)
    cap.release()
    return out


PASS_DEPTH_WINDOW = 0.35           # すれ違いの前後この秒数で奥行き（手前/奥）を読む
PASS_ANKLE_MIN_DIFF = 0.015        # 足首の高さの差がこれ未満なら奥行きは足首では決めない（正規化）


def _ankle_y(p):
    """両足首（COCO 15/16）の低い方＝床に近い方の y。見えなければ None"""
    k = p.get("kps")
    if not k:
        return None
    ys = [k[i][1] for i in (15, 16) if k[i][2] >= SPIN_KP_MIN]
    return max(ys) if ys else None


def _kp_visibility(p, hips=True):
    """上半身の keypoint（鼻・肩・肘・手首・腰）の平均信頼度。重なって隠れると下がる。
    hips=False なら腰を除く（腰が画面の外の人と比べるとき。腰の低い信頼度は隠れたせいではない）"""
    k = p.get("kps")
    if not k:
        return None
    idx = (0, 5, 6, 7, 8, 9, 10, 11, 12) if hips else (0, 5, 6, 7, 8, 9, 10)
    return sum(k[i][2] for i in idx) / len(idx)


def detect_pass_side(draw_frames, t_cross, leader_pid):
    """左右の入れ替わりで、女性が男性の体から見て左右どちら側を通ったかを推定する。

    上から見た方位（E=画面右・W=画面左・S=カメラ側・N=奥）で、すれ違う前の男性の向き h と、
    すれ違う瞬間の女性の位置 p（男性から見て手前 S か奥 N）の外積 hx*py - hy*px の符号で決める
    （正=男性の左）。ユーザーの言い方「基本の CBL は女性が男性の左を通る」と一致する向きの取り方
    （例: 女性の方＝W を向いた男性の手前を女性が通る → 左）。
    - 奥行き: すれ違う前後で足首が画面の下にある方が手前。足首で決まらなければ上半身の見え方
      （重なって隠れた方が奥）。片方しか検出されないフレームは、見えている方が手前
    - 男性の向き: すれ違う前に女性がいた側を向いていたとみなす（向かい合うのが基本の立ち位置。
      正解表で10件中10件この通りだった）
    """
    if leader_pid is None:
        return None
    follower_pid = 1 - leader_pid

    def people(df):
        return {p.get("pid"): p for p in df["kept"] if p.get("pid") in (0, 1)}

    # すれ違う前に女性が画面の左右どちらにいたか
    before = [people(df) for df in draw_frames if t_cross - 1.2 <= df["t"] < t_cross - 0.1]
    dx = [b[follower_pid]["hipX"] - b[leader_pid]["hipX"] for b in before if leader_pid in b and follower_pid in b]
    if not dx:
        return None
    follower_from = "right" if sorted(dx)[len(dx) // 2] > 0 else "left"

    # 奥行き: 女性が手前（near）か奥（far）か
    votes = 0.0
    for df in draw_frames:
        if abs(df["t"] - t_cross) > PASS_DEPTH_WINDOW:
            continue
        ps = people(df)
        if leader_pid in ps and follower_pid not in ps:
            votes -= 1.0  # 女性が隠れて見えない → 女性が奥
            continue
        if follower_pid in ps and leader_pid not in ps:
            votes += 1.0
            continue
        if leader_pid not in ps:
            continue
        fa, la = _ankle_y(ps[follower_pid]), _ankle_y(ps[leader_pid])
        if fa is not None and la is not None and abs(fa - la) >= PASS_ANKLE_MIN_DIFF:
            votes += 1.0 if fa > la else -1.0
            continue
        hips = not (shoulders_only(ps[follower_pid]) or shoulders_only(ps[leader_pid]))
        fv, lv = _kp_visibility(ps[follower_pid], hips), _kp_visibility(ps[leader_pid], hips)
        if fv is not None and lv is not None and abs(fv - lv) >= 0.1:
            votes += 0.5 if fv > lv else -0.5
    follower_depth = "near" if votes > 0 else "far" if votes < 0 else "unknown"

    # 男性の向き: 入れ替わりの前は女性の方を向いているとみなす。
    # 人手の正解表（2本19件）で向きが E/W に決まる10件はすべて「女性の方」だった。顔と肩から測る方式は
    # 同じ10件で1件外した（向きの読み違い）ので、測らずにこの規則を使う
    leader_facing = "E" if follower_from == "right" else "W"
    facing_basis = "towardFollower"

    if follower_depth == "unknown":
        side = "unknown"
    else:
        hx = 1 if leader_facing == "E" else -1
        py = -1 if follower_depth == "near" else 1
        side = "left" if hx * py > 0 else "right"   # 外積 hx*py - hy*px（hy=0, px≈0）
    return {"side": side, "followerDepth": follower_depth, "leaderFacing": leader_facing,
            "facingBasis": facing_basis, "followerFrom": follower_from}


# 入れ替わり時刻の前 BEFORE 秒〜後 AFTER 秒で男性の手の高さを見る。
# CBL からのターンは、入れ替わり（3拍目前後）を過ぎてから 5〜6 拍目で手を上げるので後ろを長く取る。
# 前後 0.8 秒の対称窓では、正解表で「上げた」5件中3件が窓の外（+0.6〜+1.4 秒）で上がっていた
RAISE_WINDOW_BEFORE_SEC = 0.8
RAISE_WINDOW_AFTER_SEC = 1.2
# 頭上に来たフレームがこの数以上なら「手を上げた」。手を頭上に通すのは一瞬（0.2〜0.5 秒）なので
# 窓内の割合では薄まる（旧: 割合 0.25 以上）
RAISE_MIN_FRAMES = 3
RAISE_NOSE_DROP = 0.25  # 鼻から肩へ向かって、この割合だけ下げた線より手首が上なら「頭の高さより上」


def detect_hand_raise(draw_frames, t_cross, leader_pid):
    """入れ替わりの前後で、男性の手首が頭（鼻、無ければ肩より上）より上がったかを測る。

    女性が男性の奥を通って見えなくなっても、男性の手は見えていることが多い。手が頭上に上がっていれば
    その入れ替わりにはターンが入っている（ターンの合図）。上がった手の左右と、上がり始めの横方向
    （男性の体から見て、女性がいる側へ向かうか＝inward、反対へ＝outward）も返す。
    戻り値 {raised, ratio, hand, firstMove} / 男性がほぼ見えなければ None
    """
    if leader_pid is None:
        return None
    follower_pid = 1 - leader_pid
    seen = up = 0
    hand_votes = {"L": 0, "R": 0}
    first = None  # 最初に頭上に来たフレームの (t, 手, 手首x, 女性の腰x or None)
    track = []    # (t, 手首x) 上がった手の軌跡
    for df in draw_frames:
        if not -RAISE_WINDOW_BEFORE_SEC <= df["t"] - t_cross <= RAISE_WINDOW_AFTER_SEC:
            continue
        ps = {p.get("pid"): p for p in df["kept"] if p.get("pid") in (0, 1)}
        lp = ps.get(leader_pid)
        k = lp.get("kps") if lp else None
        if not k:
            continue
        if k[0][2] >= SPIN_KP_MIN:
            sh_ = [k[i][1] for i in (5, 6) if k[i][2] >= SPIN_KP_MIN]
            head_y = k[0][1] + (RAISE_NOSE_DROP * (min(sh_) - k[0][1]) if sh_ and min(sh_) > k[0][1] else 0.0)
        else:
            sh = [k[i][1] for i in (5, 6) if k[i][2] >= SPIN_KP_MIN]
            if not sh:
                continue
            head_y = min(sh) - 0.05  # 肩から頭頂までのおおよその高さ
        seen += 1
        hi = None
        for hand, idx in (("L", 9), ("R", 10)):
            if k[idx][2] >= SPIN_KP_MIN and k[idx][1] < head_y and (hi is None or k[idx][1] < hi[1]):
                hi = (hand, k[idx][1], k[idx][0])
        if hi is None:
            continue
        up += 1
        hand_votes[hi[0]] += 1
        fp = ps.get(follower_pid)
        if first is None:
            first = (df["t"], hi[0], hi[2], fp["hipX"] if fp else None, lp["hipX"])
        if hi[0] == first[1]:
            track.append(hi[2])
    if seen < 3:
        return None
    ratio = up / seen
    raised = up >= RAISE_MIN_FRAMES
    out = {"raised": raised, "ratio": round(ratio, 2)}
    if raised:
        out["hand"] = max(hand_votes, key=lambda h: hand_votes[h])
        # 上がり始めの横の動き: 最初の数フレームの手首xの変化を、女性がいる側の向き（男性の腰から見た）と比べる
        if first is not None and first[3] is not None and len(track) >= 3:
            dx = track[min(3, len(track) - 1)] - track[0]
            toward = 1 if first[3] > first[4] else -1
            if abs(dx) >= 0.01:
                out["firstMove"] = "inward" if dx * toward > 0 else "outward"
    return out


HOLD_DIST = 0.07       # 手首間の正規化距離がこれ未満なら「つないでいる」
HOLD_WINDOW_SEC = 0.35  # イベント時刻の前後この範囲でホールドを判定
HOLD_SAME_SIDE_PENALTY = 1.5  # 向かい合う2人の握手は男の左×女の右・男の右×女の左（クロス）。同じ側同士は交差握手のときだけなので、近さを比べるときに距離を割り増す
HOLD_SEG_MIN_SEC = 0.5  # ホールドタイムラインに載せる区間の最小長
HOLD_MISS_TOLERANCE = 3  # 区間を切らずに許容する連続取りこぼしサンプル数（10fpsで0.3秒）


# 手の左右を、COCO のラベルでなく本人の向き（顔が見えるか）から決める。
# カメラを向いている人は画面の左の手が本人の右手、背中を向けている人は画面の左の手が本人の左手。
# YOLOv8-pose は背中向きのとき左右が逆に付くことがある。向きは鼻・両目（kp0〜2）の信頼度で読み、
# 読めない（横向き・どちらとも言えない）ときは COCO のラベルのまま
HOLD_SIDE_BY_FACING = True
HOLD_FACE_SEEN = 0.5   # 鼻・両目の全部がこれ以上なら「顔が見える＝正面」
HOLD_FACE_HIDDEN = 0.3  # 鼻・両目の全部がこれ未満なら「顔が見えない＝背中」
# 向きの時間平滑化: 前後 HOLD_FACING_WINDOW 個のコマの多数決（0 = コマごと）。
# 向きは連続的にしか変わらないので、窓の中で顔の見え方が割れたら窓の多数派に寄せる
HOLD_FACING_WINDOW = 0


def person_facing(p):
    """"front" / "back" / None（横向き・読めない）"""
    k = p.get("kps")
    if not k or len(k) < 3 or any(len(k[i]) < 3 for i in (0, 1, 2)):
        return None
    c = [k[i][2] for i in (0, 1, 2)]
    if min(c) >= HOLD_FACE_SEEN:
        return "front"
    if max(c) < HOLD_FACE_HIDDEN:
        return "back"
    return None


def hold_wrists(p, facing=None):
    """本人の左右で見た手首 {"L","R"}。向きが読めて COCO と食い違うときだけ入れ替える"""
    w = p["wrists"]
    if not HOLD_SIDE_BY_FACING:
        return w
    if facing is None:
        facing = person_facing(p)
    if facing is None:
        return w
    # 画面の左にある手首を決める（両方取れたら x の小さい方。片方だけなら肩の中心より左か）
    if w["L"] is not None and w["R"] is not None:
        screen_left = "L" if w["L"][0] <= w["R"][0] else "R"
    else:
        k = p.get("kps")
        one = "L" if w["L"] is not None else "R" if w["R"] is not None else None
        if one is None or not k or len(k) < 7:
            return w
        cx = (k[5][0] + k[6][0]) / 2
        screen_left = one if w[one][0] <= cx else ("R" if one == "L" else "L")
    # 正面: 画面の左 = 本人の右手 / 背中: 画面の左 = 本人の左手
    if (facing == "back") == (screen_left == "L"):
        return w
    return {"L": w["R"], "R": w["L"]}


def smooth_facing(draw_frames, pid):
    """pid の向きを前後の窓の多数決で平滑化して {フレーム位置: facing} を返す（読めないコマは窓の多数派）"""
    raw = []
    for df in draw_frames:
        q = next((p for p in df["kept"] if p.get("pid") == pid), None)
        raw.append(person_facing(q) if q is not None else None)
    n, w = len(raw), HOLD_FACING_WINDOW
    out = {}
    for i in range(n):
        seg = [x for x in raw[max(0, i - w):i + w + 1] if x is not None]
        if not seg:
            out[i] = None
            continue
        f, b = seg.count("front"), seg.count("back")
        out[i] = "front" if f > b else "back" if b > f else raw[i]
    return out


def nearest_hold_pair(df, leader_pid, facing=None, wrists=None):
    """1フレームの最近接手首ペアを返す: ("L-R"等, 距離) or None。
    facing: {pid: 平滑化済みの向き}（省略ならコマごとに読む）
    wrists: {pid: {"L","R"}} 追跡済みの手首（省略なら hold_wrists で決める）"""
    by_pid = {p.get("pid"): p for p in df["kept"] if p.get("pid") is not None}
    if leader_pid not in by_pid or (1 - leader_pid) not in by_pid:
        return None
    facing = facing or {}
    wrists = wrists or {}
    lw = wrists.get(leader_pid) or hold_wrists(by_pid[leader_pid], facing.get(leader_pid))
    fw = wrists.get(1 - leader_pid) or hold_wrists(by_pid[1 - leader_pid], facing.get(1 - leader_pid))
    best, best_rank = None, None
    for lk in ("L", "R"):
        for fk in ("L", "R"):
            if lw[lk] is None or fw[fk] is None:
                continue
            d = math.hypot(lw[lk][0] - fw[fk][0], lw[lk][1] - fw[fk][1])
            rank = d * (HOLD_SAME_SIDE_PENALTY if lk == fk else 1.0)
            if best is None or rank < best_rank:
                best, best_rank = (f"{lk}-{fk}", d), rank
    return best


_FACING_CACHE = {}


def _facing_tables(draw_frames, leader_pid):
    """平滑化した向きの表（draw_frames ごとに 1 回だけ作る）。窓 0 なら None（コマごと）"""
    if not HOLD_SIDE_BY_FACING or HOLD_FACING_WINDOW <= 0:
        return None
    key = (id(draw_frames), len(draw_frames), HOLD_FACING_WINDOW, leader_pid, draw_frames[0]["kept"][0].get("pid") if draw_frames and draw_frames[0]["kept"] else None)
    if key not in _FACING_CACHE:
        _FACING_CACHE.clear()
        _FACING_CACHE[key] = {pid: smooth_facing(draw_frames, pid) for pid in (0, 1)}
    return _FACING_CACHE[key]


def _facing_at(tables, i):
    return None if tables is None else {pid: t.get(i) for pid, t in tables.items()}


# (2) 手首の追跡: 手首は 1 コマで飛ばない。前のコマの左手首／右手首に近い方を同じ手として、
# COCO のラベルが一時的に入れ替わっても追跡側のラベルを信じる（位置＋速度の予測との距離で割り当て）
HOLD_TRACK_WRISTS = False
HOLD_TRACK_MAX_GAP = 4     # 手首を見失ってからこのコマ数を超えたら追跡を捨てて hold_wrists から付け直す
HOLD_TRACK_GATE = 0.25     # 予測位置からこれ以上離れた点は同じ手と見なさない
HOLD_TRACK_SWAP_RATIO = 0.7  # 入れ替えた割り当ての距離和が、そのままの 0.7 倍未満のときだけ入れ替える


def _tracked_wrists(draw_frames, pid, facing_tab):
    """pid の手首を追跡して [{"L","R"} or None] をコマごとに返す"""
    out = []
    state = {"L": None, "R": None}  # 各手: (pos, vel, last_i)
    for i, df in enumerate(draw_frames):
        p = next((q for q in df["kept"] if q.get("pid") == pid), None)
        if p is None:
            out.append(None)
            continue
        base = hold_wrists(p, None if facing_tab is None else facing_tab.get(i))
        raw = p["wrists"]  # COCO のまま
        pts = [raw["L"], raw["R"]]
        # 予測位置（速度で線形外挿。見失い期間が長いものは捨てる）
        pred = {}
        for k in ("L", "R"):
            s = state[k]
            if s is not None and i - s[2] <= HOLD_TRACK_MAX_GAP:
                gap = i - s[2]
                pred[k] = (s[0][0] + s[1][0] * gap, s[0][1] + s[1][1] * gap)
        cur = [q for q in pts if q is not None]
        res = {"L": None, "R": None}
        if len(pred) == 0 or not cur:
            res = dict(base)
        elif len(pred) == 2 and len(cur) == 2:
            a, b = pts[0], pts[1]  # COCO L, R
            keep = math.hypot(a[0] - pred["L"][0], a[1] - pred["L"][1]) + math.hypot(b[0] - pred["R"][0], b[1] - pred["R"][1])
            swap = math.hypot(a[0] - pred["R"][0], a[1] - pred["R"][1]) + math.hypot(b[0] - pred["L"][0], b[1] - pred["L"][1])
            # 追跡ラベルの割り当て（そのまま／入れ替え）を距離和で比べる。基準は hold_wrists の割り当て
            base_is_keep = base["L"] is raw["L"]
            if base_is_keep:
                use_swap = swap < keep * HOLD_TRACK_SWAP_RATIO
            else:
                use_swap = not (keep < swap * HOLD_TRACK_SWAP_RATIO)
                # base が入れ替え済みのとき、use_swap=True は「COCO を入れ替えた割り当て」
            res = {"L": b, "R": a} if use_swap else {"L": a, "R": b}
        else:
            # 点が 1 つ、または予測が 1 つ: 近い方の追跡ラベルに付ける（ゲート内のみ）
            if len(cur) == 1:
                q = cur[0]
                best = min(pred, key=lambda k: math.hypot(q[0] - pred[k][0], q[1] - pred[k][1]))
                if math.hypot(q[0] - pred[best][0], q[1] - pred[best][1]) <= HOLD_TRACK_GATE:
                    res[best] = q
                else:
                    res = dict(base)
            else:
                k0 = next(iter(pred))
                near = min(pts, key=lambda q: math.hypot(q[0] - pred[k0][0], q[1] - pred[k0][1]))
                other = pts[1] if near is pts[0] else pts[0]
                res[k0] = near
                res["R" if k0 == "L" else "L"] = other
        # 状態更新
        for k in ("L", "R"):
            q = res[k]
            if q is None:
                continue
            s = state[k]
            if s is not None and i - s[2] <= HOLD_TRACK_MAX_GAP:
                g = max(1, i - s[2])
                vel = ((q[0] - s[0][0]) / g, (q[1] - s[0][1]) / g)
            else:
                vel = (0.0, 0.0)
            state[k] = ((q[0], q[1]), vel, i)
        out.append(res)
    return out


# (3) つないだ手はターン中も同じ手: 向かい合って顔が見え、手首が近いコマ（読めるコマ）で決まった hold を、
# 手首が近いまま続く限り前後のコマへ引き継ぐ。引き継いだコマは自分の投票を使わない
HOLD_CARRY = False
HOLD_CARRY_DIST = 0.10      # 引き継ぎ中、握っている組の手首間距離がこれ未満なら続いていると見なす
HOLD_CARRY_MAX_GAP = 3      # 引き継ぎ中に許す連続の取りこぼしコマ数
HOLD_CARRY_NEED_OPPOSITE = True  # 読めるコマの条件: 2 人の向きが正面×背中（向かい合っている）


def _pair_dist(wl, wf, pair):
    lk, fk = pair.split("-")
    if wl is None or wf is None or wl[lk] is None or wf[fk] is None:
        return None
    return math.hypot(wl[lk][0] - wf[fk][0], wl[lk][1] - wf[fk][1])


# (4) 重なり区間: 2人が縦に重なる（箱が横にも縦にも大きく重なる）・片方が隠れている（1人しか取れない）・
# 手首の信頼度が低いコマでは、手首の距離で手のつなぎを読めない（左右の手を取り違える。820f0461 の冒頭は
# 2人が縦に重なって始まり、右手×右手が左右逆に読まれ、その後の「持ち替え」も読み違いの続きになっていた）。
# そのコマの計測値は採らず、2人が分かれて見える区間の hold を前後から引き継ぐ:
#   先頭の重なり区間 … 直後の明瞭な区間の hold をさかのぼって入れる / 末尾 … 直前の明瞭な区間から引き継ぐ
#   途中 … 直前と直後の明瞭な区間の hold が同じときだけ入れる（違えば持ち替えたかもしれないので空）
# 引き継いだコマは推定（estimated）。HOLD_OCCLUSION_FILL=False（環境変数 MOTION_LAB_HOLD_FILL=0）で無効
HOLD_OCCLUSION_FILL = os.environ.get("MOTION_LAB_HOLD_FILL", "1") != "0"
HOLD_OVERLAP_X = 0.6        # 2人の箱の横の重なり（狭い方の幅に対する割合）がこれ以上
HOLD_OVERLAP_Y = 0.6        # かつ縦の重なり（低い方の高さに対する割合）がこれ以上で「重なり」
HOLD_WRIST_CONF = 0.3       # どちらかの人の両手首の信頼度がともにこれ未満なら、手首が見えていない
HOLD_FILL_MAX_SEC = 3.0     # これより長い重なり区間は推定しない（長く隠れた間の持ち替えは分からない）
HOLD_FILL_LOOK_SEC = 0.6    # 明瞭な区間の hold は、重なり区間の境目からこの秒数の多数決で決める
HOLD_FILL_OVERWRITE = os.environ.get("MOTION_LAB_HOLD_OVERWRITE", "1") != "0"  # 重なり区間の計測値を捨てて推定で置き換える
# 補うのは映像の先頭・末尾の重なり区間だけ。途中の重なり（CBL の交差の瞬間など）は、補うと正解表の hold が
# 当たらなくなった（全区間で補うと 男の手 12/13 → 8/13）。途中は手首の計測がむしろ当たる
HOLD_FILL_EDGES_ONLY = os.environ.get("MOTION_LAB_HOLD_EDGES_ONLY", "1") != "0"


def _box_overlap(a, b):
    """2つの箱の (横の重なり, 縦の重なり)。それぞれ小さい方の幅/高さに対する割合"""
    ox = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    oy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    w = max(1e-6, min(a[2] - a[0], b[2] - b[0]))
    h = max(1e-6, min(a[3] - a[1], b[3] - b[1]))
    return ox / w, oy / h


def hold_unclear(df, leader_pid):
    """このコマは手のつなぎを手首の距離から読めないか（相方が隠れている・縦に重なっている・手首が見えない）"""
    by_pid = {p.get("pid"): p for p in df["kept"] if p.get("pid") is not None}
    if leader_pid not in by_pid or (1 - leader_pid) not in by_pid:
        return True
    a, b = by_pid[leader_pid], by_pid[1 - leader_pid]
    ox, oy = _box_overlap(a["bbox"], b["bbox"])
    if ox >= HOLD_OVERLAP_X and oy >= HOLD_OVERLAP_Y:
        return True
    for p in (a, b):
        k = p.get("kps")
        if k and len(k) > 10 and max(k[9][2], k[10][2]) < HOLD_WRIST_CONF:
            return True
    return False


HOLD_FILL_MIN_VOTES = 2     # 引き継ぐ hold の票がこれ未満なら補わない
HOLD_FILL_MIN_SHARE = 0.5   # 最多の hold が票の半分を超えないとき（左右の読みが割れている）は補わない。割れたまま補うと誤った推定を出す


def _majority_label(labels):
    votes = {}
    for x in labels:
        if x is not None:
            votes[x] = votes.get(x, 0) + 1
    if not votes:
        return None
    best = max(votes, key=lambda k: votes[k])
    if votes[best] < HOLD_FILL_MIN_VOTES or votes[best] / sum(votes.values()) <= HOLD_FILL_MIN_SHARE:
        return None
    return best


def fill_unclear_holds(draw_frames, leader_pid, labels):
    """重なり区間の hold を前後の明瞭な区間から引き継ぐ。戻り値: (labels, estimated)"""
    n = len(draw_frames)
    unclear = [hold_unclear(df, leader_pid) for df in draw_frames]
    out = list(labels)
    est = [False] * n
    i = 0
    while i < n:
        if not unclear[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and unclear[j + 1]:
            j += 1
        if HOLD_FILL_EDGES_ONLY and i > 0 and j < n - 1:
            i = j + 1   # 途中の重なり（CBL の交差など）は手首の計測が当たるので触らない
            continue
        t0, t1 = draw_frames[i]["t"], draw_frames[j]["t"]
        # 区間の長さは、前後の明瞭なコマの時刻までで測る（端のコマ1つぶん含める）
        t_prev = draw_frames[i - 1]["t"] if i > 0 else t0
        t_next = draw_frames[j + 1]["t"] if j + 1 < n else t1
        if t_next - t_prev <= HOLD_FILL_MAX_SEC + 1e-6:
            prev_labels = [labels[k] for k in range(i - 1, -1, -1)
                           if not unclear[k] and t_prev - draw_frames[k]["t"] <= HOLD_FILL_LOOK_SEC]
            next_labels = [labels[k] for k in range(j + 1, n)
                           if not unclear[k] and draw_frames[k]["t"] - t_next <= HOLD_FILL_LOOK_SEC]
            prev_l = _majority_label(prev_labels) if i > 0 else None
            next_l = _majority_label(next_labels) if j + 1 < n else None
            if i == 0:
                fill = next_l
            elif j == n - 1:
                fill = prev_l
            else:
                fill = prev_l if prev_l == next_l else None
            for k in range(i, j + 1):
                if fill is not None:
                    out[k], est[k] = fill, True
                elif HOLD_FILL_OVERWRITE:
                    out[k] = None
        elif HOLD_FILL_OVERWRITE:
            for k in range(i, j + 1):
                out[k] = None
        i = j + 1
    return out, est


_HOLD_CACHE = {}


def hold_frame_table(draw_frames, leader_pid):
    """コマごとの hold ラベル（"L-R" 等 or None）の表。追跡・引き継ぎの設定を反映（draw_frames ごとに 1 回）"""
    return _hold_table(draw_frames, leader_pid)[0]


def hold_frame_estimated(draw_frames, leader_pid):
    """コマごとの「この hold は重なり区間の推定か」の表（hold_frame_table と同じ長さの bool のリスト）"""
    return _hold_table(draw_frames, leader_pid)[1]


def _hold_table(draw_frames, leader_pid):
    key = (id(draw_frames), len(draw_frames), leader_pid, HOLD_SIDE_BY_FACING, HOLD_FACING_WINDOW,
           HOLD_TRACK_WRISTS, HOLD_CARRY, HOLD_TRACK_GATE, HOLD_TRACK_SWAP_RATIO, HOLD_CARRY_DIST,
           HOLD_CARRY_NEED_OPPOSITE, HOLD_CARRY_MAX_GAP, HOLD_TRACK_MAX_GAP, HOLD_OCCLUSION_FILL, HOLD_FILL_OVERWRITE,
           HOLD_OVERLAP_X, HOLD_OVERLAP_Y, HOLD_WRIST_CONF, HOLD_FILL_MAX_SEC, HOLD_FILL_LOOK_SEC, HOLD_FILL_EDGES_ONLY,
           draw_frames[0]["kept"][0].get("pid") if draw_frames and draw_frames[0]["kept"] else None)
    if key in _HOLD_CACHE:
        return _HOLD_CACHE[key]
    fac = _facing_tables(draw_frames, leader_pid)
    n = len(draw_frames)
    fpid = 1 - leader_pid
    tracked = None
    if HOLD_TRACK_WRISTS:
        tracked = {pid: _tracked_wrists(draw_frames, pid, None if fac is None else fac.get(pid)) for pid in (leader_pid, fpid)}
    best = []     # (pair, dist) or None
    readable = []
    wr = []
    for i, df in enumerate(draw_frames):
        w = None if tracked is None else {pid: tracked[pid][i] for pid in tracked}
        if w is not None and (w[leader_pid] is None or w[fpid] is None):
            w = None
        wr.append(w)
        b = nearest_hold_pair(df, leader_pid, _facing_at(fac, i), w)
        best.append(b)
        ok = b is not None and b[1] < HOLD_DIST
        if ok and HOLD_CARRY:
            by_pid = {p.get("pid"): p for p in df["kept"] if p.get("pid") is not None}
            fl = person_facing(by_pid[leader_pid])
            ff = person_facing(by_pid[fpid])
            if fl is None or ff is None:
                ok = False
            elif HOLD_CARRY_NEED_OPPOSITE and fl == ff:
                ok = False
        readable.append(ok)
    labels = [b[0] if b is not None and b[1] < HOLD_DIST else None for b in best]
    if HOLD_CARRY:
        # 読めるコマの label を、手首が近いまま続く限り前後へ引き継ぐ
        def wrists_at(i):
            if wr[i] is not None:
                return wr[i][leader_pid], wr[i][fpid]
            by_pid = {p.get("pid"): p for p in draw_frames[i]["kept"] if p.get("pid") is not None}
            if leader_pid not in by_pid or fpid not in by_pid:
                return None, None
            return (hold_wrists(by_pid[leader_pid], None if fac is None else fac[leader_pid].get(i)),
                    hold_wrists(by_pid[fpid], None if fac is None else fac[fpid].get(i)))
        carried = list(labels)
        for rng in (range(n), range(n - 1, -1, -1)):
            cur, miss = None, 0
            for i in rng:
                if readable[i]:
                    cur, miss = labels[i], 0
                    continue
                if cur is None:
                    continue
                wl, wf = wrists_at(i)
                d = _pair_dist(wl, wf, cur)
                if d is not None and d < HOLD_CARRY_DIST:
                    carried[i] = cur  # 読めないコマ自身の投票は使わない
                    miss = 0
                else:
                    miss += 1
                    if miss > HOLD_CARRY_MAX_GAP:
                        cur = None
        labels = carried
    est = [False] * n
    if HOLD_OCCLUSION_FILL and n:
        labels, est = fill_unclear_holds(draw_frames, leader_pid, labels)
    _HOLD_CACHE.clear()
    _HOLD_CACHE[key] = (labels, est)
    return _HOLD_CACHE[key]


def hold_label_jp(pair):
    jp = {"L": "左手", "R": "右手"}
    lk, fk = pair.split("-")
    return f"リーダー{jp[lk]}×フォロワー{jp[fk]}"


def build_hold_timeline(draw_frames, leader_pid):
    """全編のホールド（手のつなぎ）区間: [{from, to, hold}]

    技の瞬間だけでなく「技と技の間でどう手を持ち替えたか」を Claude が
    レポートの連鎖記述に使う。1サンプルの欠落（オクルージョン等）は無視して繋ぐ。
    重なり区間（2人が重なる・片方が隠れる）を前後から補った区間には estimated: [from, to]（補った秒の範囲）を付ける。
    その範囲の手は計測でなく推定（AI は「この区間の手は推定」と読む）
    """
    if leader_pid is None:
        return []
    samples = []  # (t, pair or None, 推定か)
    table, est = _hold_table(draw_frames, leader_pid)
    for i, df in enumerate(draw_frames):
        samples.append((df["t"], table[i], est[i]))

    segs = []
    cur, start, last_t, miss = None, None, None, 0
    est_span = None
    def flush():
        if cur is not None and start is not None and last_t - start >= HOLD_SEG_MIN_SEC:
            seg = {"from": round(start, 2), "to": round(last_t, 2), "hold": hold_label_jp(cur)}
            if est_span is not None:
                seg["estimated"] = [round(est_span[0], 2), round(est_span[1], 2)]
            segs.append(seg)
    for t, p, e in samples:
        if p == cur:
            last_t, miss = t, 0
            if e:
                est_span = [t, t] if est_span is None else [est_span[0], t]
        elif p is None and miss < HOLD_MISS_TOLERANCE:
            miss += 1  # 手首の取りこぼし（頭上・オクルージョン）は少しの間なら区間を切らない
        else:
            flush()
            cur, start, last_t, miss = p, t, t, 0
            est_span = [t, t] if e else None
    flush()
    return [s for s in segs]


HOLD_UNCLEAR_MIN_SEC = 0.3  # holdUnclear に載せる区間の最小長（1コマの点滅は載せない）


def build_hold_unclear(draw_frames, leader_pid):
    """手首から手のつなぎを読めない区間 [{from, to}]（2人が縦に重なる・片方が隠れる・手首が見えない）。
    AI が「この区間の hold は信用できない（計測でなく推定）」と分かるように summary に出す"""
    if leader_pid is None:
        return []
    spans, start, last = [], None, None
    for df in draw_frames:
        if hold_unclear(df, leader_pid):
            if start is None:
                start = df["t"]
            last = df["t"]
        elif start is not None:
            if last - start >= HOLD_UNCLEAR_MIN_SEC:
                spans.append({"from": round(start, 2), "to": round(last, 2)})
            start = None
    if start is not None and last - start >= HOLD_UNCLEAR_MIN_SEC:
        spans.append({"from": round(start, 2), "to": round(last, 2)})
    return spans


def hold_is_estimated(draw_frames, t_center, leader_pid):
    """detect_hold の投票に使うコマの過半数が、重なり区間の推定か"""
    if leader_pid is None:
        return False
    table, est = _hold_table(draw_frames, leader_pid)
    used = [est[i] for i, df in enumerate(draw_frames)
            if abs(df["t"] - t_center) <= HOLD_WINDOW_SEC and table[i] is not None]
    return bool(used) and sum(used) * 2 > len(used)


def detect_hold(draw_frames, t_center, leader_pid):
    """イベント時刻近傍での手のつなぎを推定する。

    リーダーとフォロワーの手首4ペア（L-L, L-R, R-L, R-R）の距離を
    近傍フレームで測り、最頻の最近接ペアが HOLD_DIST 未満なら
    「リーダー◯手×フォロワー◯手」を返す。取れなければ None。
    2Dの重なりでも距離が縮むため確定情報ではない（Claude がキーフレームで検証する前提の候補）
    """
    if leader_pid is None:
        return None
    votes = {}
    table = hold_frame_table(draw_frames, leader_pid)
    for i, df in enumerate(draw_frames):
        if abs(df["t"] - t_center) > HOLD_WINDOW_SEC:
            continue
        if table[i] is not None:
            votes[table[i]] = votes.get(table[i], 0) + 1
    if not votes:
        return None
    return hold_label_jp(max(votes, key=lambda k: votes[k]))


def detect_events(draw_frames, leader_pid):
    """全イベントを時刻順で返す: [{t, type, by, rotations?, hold?}]

    リーダーのターンは detect_leader_turns（反転ペアごと、向きの揃ったものだけ）で拾う。
    リーダーの「随伴回転」を棄却する2つのフィルタ（いずれも実測で誤検出を確認済み）:
    - CBL 近傍: リーダーは CBL のリード動作で体を半回転させて戻す（CBLの一部でありターンではない）
    - フォロワーのターン近傍: フォロワーを回すとき、リーダーの上体も連られて回る
    フォロワーのターンは CBL 中でも本物（クロスボディ・インサイドターン）なので常に残す。
    リーダーの単独ターン（フック ターン等）は近傍に何も無ければ検出される
    """
    cbl_times = detect_cbl(draw_frames)
    events = [{"t": round(t - CBL_TIME_SHIFT_SEC, 2), "tCross": t, "type": "CBL", "by": "pair",
               "hold": detect_hold(draw_frames, t, leader_pid),
               "pass": detect_pass_side(draw_frames, t, leader_pid),
               "handRaise": detect_hand_raise(draw_frames, t, leader_pid)}
              for t in cbl_times]
    for e in events:
        if e["hold"] is not None and hold_is_estimated(draw_frames, e["tCross"], leader_pid):
            e["holdEstimated"] = True  # 手のつなぎは重なり区間の前後からの推定（計測ではない）

    spans = {pid: detect_turns(draw_frames, pid, with_span=True, cbl_times=cbl_times) for pid in (0, 1)}
    turns = {pid: [(t, r) for t, r, _, _ in spans[pid]] for pid in (0, 1)}
    half = set()
    if TURN_CBL_HALF_DROP and leader_pid is not None:
        m = TURN_CBL_HALF_MARGIN
        half = {t for t, _, a, b, n in detect_turns(draw_frames, 1 - leader_pid, with_span="count", cbl_times=cbl_times)
                if n <= 2 and any(a - m <= c <= b + m for c in cbl_times)}
        if not TURN_CBL_HALF_KEEP_SUPPRESS:
            spans[1 - leader_pid] = [s for s in spans[1 - leader_pid] if s[0] not in half]
            turns[1 - leader_pid] = [(t, r) for t, r, _, _ in spans[1 - leader_pid]]
    leader_spins = {}
    if leader_pid is not None:
        follower_turn_times = [t for t, _ in turns[1 - leader_pid]]
        follower_turn_dirs = {}
        if LEADER_COUNTER_ROT_KEEP:
            ps = detect_turns(draw_frames, 1 - leader_pid, with_span="pair", cbl_times=cbl_times)
            for k, (t, _, a, b) in enumerate(ps):
                if t not in follower_turn_times:
                    continue
                span = (a, b, ps[k - 1][3] if k else float("-inf"),
                        ps[k + 1][2] if k + 1 < len(ps) else float("inf")) if SPIN_USE_TURN_SPAN else None
                net = (spin_hint(draw_frames, 1 - leader_pid, t, span) or {}).get("netDeg", 0)
                follower_turn_dirs[t] = (net > 0) - (net < 0)
        lt = detect_leader_turns(draw_frames, leader_pid, cbl_times, follower_turn_times,
                                 [(a, b) for _, _, a, b in spans[1 - leader_pid]], with_span=True,
                                 follower_turn_dirs=follower_turn_dirs)
        turns[leader_pid] = [(t, r) for t, r, _, _, _ in lt]
        leader_spins = {t: s for t, _, s, _, _ in lt}
        rot_spans = {leader_pid: {t: (a, b) for t, _, _, a, b in lt}}
    else:
        rot_spans = {}

    spin_spans = {0: {}, 1: {}}  # pid -> {ターン時刻: spin_hint の span}
    for pid in (0, 1):
        ps = detect_turns(draw_frames, pid, with_span="pair", cbl_times=cbl_times)
        if pid not in rot_spans:
            rot_spans[pid] = {t: (a, b) for t, _, a, b in ps}
        if SPIN_USE_TURN_SPAN:
            for k, (t, _, a, b) in enumerate(ps):
                prev_end = ps[k - 1][3] if k else float("-inf")
                next_start = ps[k + 1][2] if k + 1 < len(ps) else float("inf")
                spin_spans[pid][t] = (a, b, prev_end, next_start)
    for pid in (0, 1):
        if leader_pid is None:
            by = "unknown"
        else:
            by = "leader" if pid == leader_pid else "follower"
        for t, rotations in turns[pid]:
            if by == "follower" and t in half:
                continue  # CBL の通過の半回転（随伴フィルタには残す）
            spin =leader_spins[t] if by == "leader" else spin_hint(draw_frames, pid, t, spin_spans[pid].get(t))
            ev = {"t": t, "type": "Turn", "by": by, "rotations": rotations,
                  "hold": detect_hold(draw_frames, t, leader_pid), "spin": spin}
            if ev["hold"] is not None and hold_is_estimated(draw_frames, t, leader_pid):
                ev["holdEstimated"] = True
            if t in rot_spans.get(pid, {}):
                set_turn_span(ev, *rot_spans[pid][t], source="flips10fps")
            events.append(ev)
    events.sort(key=lambda e: e["t"])
    return events


PASS_HALF_MIN_SEC = 0.25   # CBL の通過からターンの回り始め（span.from）までがこれ未満なら、通過は回転の範囲に入っている
PASS_HALF_MAX_SEC = 0.65   # これより空くと別の技（CBL のあと一拍置いてから回る）。ほぼ 1 拍 = 通過してから回り出すまで


def apply_cbl_pass_half(events):
    """CBL に続いて回るフォロワーのターンへ、通過の½回転を足す（回転数の決まり。docs/salsa-knowledge/on2-timing-and-terms.md
    §5・§8-4、正解表 README の「回転数の決まり」: CBL＋インサイド = 1½）。

    ターンの回転の範囲（span）は最初の向きの反転から始まるので、通過の½は範囲に入らず、CBL の通過から 0.25〜0.65 秒後に
    回り出すターンは全て½少なく数えていた（README 34）。足すのは rotations と spin の最初の run。何度呼んでも足すのは 1 回
    （passHalf が付く）。refine_turns_dense が span を取り直したあとでも呼べる（spin を作り直すと passHalf は外れる）"""
    cbls = [e.get("tCross", e["t"]) for e in events if e.get("type") == "CBL"]
    for e in events:
        if e.get("type") != "Turn" or e.get("by") != "follower" or e.get("passHalf"):
            continue
        sp = e.get("span") if isinstance(e.get("span"), dict) else None
        start = sp["from"] if sp else e["t"]
        if not any(PASS_HALF_MIN_SEC <= start - c <= PASS_HALF_MAX_SEC for c in cbls):
            continue
        e["passHalf"] = 0.5
        e["rotations"] = (e.get("rotations") or 1) + 0.5
        spin = e.get("spin")
        if isinstance(spin, dict):
            if spin.get("runs"):
                spin["runs"] = [dict(r) for r in spin["runs"]]
                spin["runs"][0]["turns"] += 0.5
            elif spin.get("seq"):
                runs = _spin_runs(spin["seq"])
                if runs:
                    runs[0]["turns"] += 0.5
                    spin["runs"] = runs
    return events


def set_turn_span(e, t_from, t_to, source):
    """ターンのイベントに回転の範囲（最初〜最後の向きの反転）と、その真ん中 tMid を書く。
    t は回り始め（女性: 最初の反転、男: 最初の 1 回転の中点）のまま。振付シートの行の割り当て・カードはカウントの
    回り始めを使う。正解表の t は回転の真ん中に付けてあるので、採点（eval_ground_truth の --match=mid）は tMid で
    対応を取る（README 28）"""
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (t_from, t_to)) or t_to < t_from:
        return e
    e["span"] = {"from": round(t_from, 2), "to": round(t_to, 2), "source": source}
    e["tMid"] = round((t_from + t_to) / 2, 2)
    return e


def draw_debug(frame, mask_roi, roi, kept, rejected, leader_pid, event_labels=()):
    """デバッグ動画用（2パス目）: ROI枠（金）を描画し、採用ペアを外見クラスタの
    ロール（Leader=青 / Follower=ピンク）で塗り分ける。
    ロール不明フレームは緑、背景の除外候補は赤。検出イベントは黄色ラベルで焼き込む"""
    h, w = frame.shape[:2]
    vis = apply_roi_mask(frame, mask_roi) if mask_roi is not None else frame.copy()
    if roi is not None:
        cv2.rectangle(vis, (int(roi[0] * w), int(roi[1] * h)), (int(roi[2] * w), int(roi[3] * h)), (0, 200, 255), 2)

    for li, label in enumerate(event_labels):
        y = int(h * 0.12) + li * 44
        cv2.putText(vis, label, (14, y), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 7)
        cv2.putText(vis, label, (14, y), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 255, 255), 3)

    persons = []
    for p in kept:
        if leader_pid is None or p.get("pid") is None:
            persons.append((p, COLOR_NEUTRAL, ""))
        elif p["pid"] == leader_pid:
            persons.append((p, COLOR_LEADER, "L"))
        else:
            persons.append((p, COLOR_FOLLOWER, "F"))

    for p, color, tag in persons + [(p, COLOR_REJECTED, "") for p in rejected]:
        b = p["bbox"]
        cv2.rectangle(vis, (int(b[0] * w), int(b[1] * h)), (int(b[2] * w), int(b[3] * h)), color, 2)
        label = (f"{tag} SHR {p['shr2d']:.2f}" if p.get("shr2d") is not None else f"{tag} shoulders").strip()
        cv2.putText(vis, label, (int(b[0] * w), max(12, int(b[1] * h) - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 2)
    return vis


EVENT_LABEL_SEC = 1.2  # イベントラベルを表示し続ける秒数


def render_debug_video(video_path, debug_video_path, draw_frames, leader_pid, effective_fps, events=()):
    """2パス目: 動画を再読して計測済みの描画データで色を塗る（推論なし・デコードのみ）"""
    by_idx = {df["frameIdx"]: df for df in draw_frames}
    cap = cv2.VideoCapture(video_path)
    writer = None
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        df = by_idx.get(frame_idx)
        if df is not None:
            if writer is None:
                h0, w0 = frame.shape[:2]
                writer = cv2.VideoWriter(
                    debug_video_path, cv2.VideoWriter_fourcc(*"mp4v"),
                    max(1.0, effective_fps), (w0, h0),
                )
            labels = []
            for e in events:
                if not (e["t"] <= df["t"] <= e["t"] + EVENT_LABEL_SEC):
                    continue
                label = e["type"].upper()
                if e.get("rotations", 1) > 1:
                    label += f" x{e['rotations']}"
                if e["by"] != "pair":
                    label += f" ({e['by']})"
                labels.append(label)
            writer.write(draw_debug(frame, df["maskRoi"], df["roi"], df["kept"], df["rejected"], leader_pid, labels))
        frame_idx += 1
    cap.release()
    if writer is not None:
        writer.release()


def assign_slots(persons, prev_slots):
    """
    検出された人物（最大2）を前フレームの腰位置との Nearest Neighbor で
    スロット 0/1 に割り当てる。戻り値は [slot0の計測 or None, slot1の計測 or None]
    """
    slots = [None, None]
    if not persons:
        return slots
    if prev_slots[0] is None and prev_slots[1] is None:
        # 初回: hipX の小さい方（画面左）を slot0 に
        ordered = sorted(persons, key=lambda p: p["hipX"])
        for i, p in enumerate(ordered[:2]):
            slots[i] = p
        return slots

    def dist(p, s):
        if s is None:
            return 0.5  # 空スロットへの割り当てコスト（中立）
        return math.hypot(p["hipX"] - s["hipX"], p["hipY"] - s["hipY"])

    if len(persons) == 1:
        p = persons[0]
        target = 0 if dist(p, prev_slots[0]) <= dist(p, prev_slots[1]) else 1
        slots[target] = p
    else:
        a, b = persons[0], persons[1]
        direct = dist(a, prev_slots[0]) + dist(b, prev_slots[1])
        swapped = dist(a, prev_slots[1]) + dist(b, prev_slots[0])
        if direct <= swapped:
            slots[0], slots[1] = a, b
        else:
            slots[0], slots[1] = b, a
    return slots


def moving_average(values, window):
    out = []
    acc = 0.0
    buf = []
    for v in values:
        buf.append(v)
        acc += v
        if len(buf) > window:
            acc -= buf.pop(0)
        out.append(acc / len(buf))
    return out


def extract_contested(frames, effective_fps):
    """
    contested 区間を抽出する:
      (a) 平滑化したSHR差 < SHR_DIFF_THRESHOLD が CONTESTED_MIN_SEC 以上続く区間
      (b) オクルージョン率 > 50% の区間（同じ最小長）
    frames: [{t, shrDiff or None, occluded}, ...]
    """
    # SHR差が取れないフレームは直前値で補間（区間検出の連続性のため）
    diffs = []
    last = SHR_DIFF_THRESHOLD * 2  # 初期値は「拮抗していない」扱い
    for f in frames:
        if f["shrDiff"] is not None:
            last = f["shrDiff"]
        diffs.append(last)
    smooth = moving_average(diffs, SMOOTH_WINDOW)

    min_frames = int(CONTESTED_MIN_SEC * effective_fps)
    segments = []

    def flush(start_idx, end_idx, reason):
        if end_idx - start_idx + 1 >= min_frames:
            segments.append({
                "from": round(frames[start_idx]["t"], 2),
                "to": round(frames[end_idx]["t"], 2),
                "reason": reason,
            })

    # (a) SHR拮抗
    run_start = None
    for i, d in enumerate(smooth):
        if d < SHR_DIFF_THRESHOLD:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                flush(run_start, i - 1, f"shr_diff<{SHR_DIFF_THRESHOLD}")
                run_start = None
    if run_start is not None:
        flush(run_start, len(smooth) - 1, f"shr_diff<{SHR_DIFF_THRESHOLD}")

    # (b) オクルージョン連続
    run_start = None
    for i, f in enumerate(frames):
        if f["occluded"]:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                flush(run_start, i - 1, "occlusion")
                run_start = None
    if run_start is not None:
        flush(run_start, len(frames) - 1, "occlusion")

    # 重複マージはせず長い順に上限まで（切り捨ては呼び出し元で記録）
    segments.sort(key=lambda s: s["to"] - s["from"], reverse=True)
    dropped = max(0, len(segments) - MAX_CONTESTED)
    kept = sorted(segments[:MAX_CONTESTED], key=lambda s: s["from"])
    return kept, dropped


# コマの時刻は動画のタイムスタンプ（PTS、cap.get(CAP_PROP_POS_MSEC)）で取る（2026-10-05）。以前は frame_idx / fps で、
# 可変フレームレート（画面録画・SNS から落とした動画）では本当の時刻から最大 1 秒ずれていた。正解表 6 本のうち 5 本が可変で、
# 「コマ番号 / 平均 fps − PTS」は 1230b3d5 で 0 → +1.0 秒（20〜40 秒）→ 0（140 秒）、2fda2815 で +0.25 → −0.5、
# 8c312c6d で +0.2 → −0.7、bb0efcb9 で +0.34 → −0.8、screenrec で +0.35 → +0.1（img1884 の .mov だけ等間隔）。
# 正解表（再生した時刻）・音声の拍・キーフレームの切り出し・refine_turns_dense（どれも PTS）と食い違い、1230b3d5 の
# 「CV の入れ替わりが正解より約 1 秒遅れる」の正体がこれだった。README 26
# 時刻の取り方は frame_time.py にまとめた（analyze_rotation・refine_events・refine_turns_dense と共通。README 27）。
# 下の 2 つはこのモジュールの値（評価のスクリプトが ap.FRAME_TIME_* を書き換える）を frame_time に渡す
FRAME_TIME_PTS = frame_time.FRAME_TIME_PTS
# 画面録画は 60fps の時間軸にコマが 1〜3 枠おきに不規則に並ぶので、4 コマおきに間引いたコマの PTS の間隔は 0.067〜0.2 秒と
# ばらつく。検出の秒の閾値（反転の連なりの間隔・冷却など）は等間隔の時刻で合わせてあるので、PTS そのものではなく
# 「コマ番号 / fps」に、前後 FRAME_TIME_SMOOTH_SEC 秒の（PTS − コマ番号 / fps）の中央値を足した時刻を使う
# （ゆっくり溜まるずれだけ直し、コマごとの揺れは入れない）。0 = PTS そのもの
FRAME_TIME_SMOOTH_SEC = frame_time.FRAME_TIME_SMOOTH_SEC


def pts_offsets(pts, fps, smooth_sec=None):
    """コマごとの PTS（秒）の並び → コマごとの時刻（秒）。frame_time.pts_offsets（smooth_sec の既定はこのモジュールの値）"""
    return frame_time.pts_offsets(pts, fps, FRAME_TIME_SMOOTH_SEC if smooth_sec is None else smooth_sec)


def frame_clock(video_path, fps):
    """動画を 1 回なめてコマ番号 ↔ 時刻の時計（frame_time.FrameClock）を作る。無効・PTS が取れなければ コマ番号 / fps"""
    return frame_time.FrameClock.from_video(video_path, fps, enabled=FRAME_TIME_PTS, smooth_sec=FRAME_TIME_SMOOTH_SEC)


def frame_time_map(video_path, fps):
    """コマごとの時刻の並び（frame_clock の times）。FRAME_TIME_PTS が無効・PTS が取れなければ None"""
    return frame_clock(video_path, fps).times


def main():
    # フラグ（--key=value）と位置引数を分離
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = dict(a.split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    if len(positional) not in (3, 4, 5):
        print("Usage: analyze_pair.py <video_path> <yolo_model_path> <output_json_path> "
              "[debug_video_path] [skeleton_video_path] [--leader-hint=<left|right>@<sec>]", file=sys.stderr)
        sys.exit(1)

    video_path, model_path, output_path = positional[0], positional[1], positional[2]
    debug_video_path = positional[3] if len(positional) >= 4 and positional[3] != "-" else None
    skeleton_video_path = positional[4] if len(positional) == 5 else None
    leader_hint = flags.get("--leader-hint")  # Claude アンカー（例: right@5.00）

    model = YOLO(model_path)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = max(1, round(fps / TARGET_FPS))
    effective_fps = fps / frame_interval
    clock = frame_clock(video_path, fps)  # コマごとの時刻（PTS。可変フレームレート対策。README 26・27）

    frame_idx = 0
    sampled = 0
    prev_slots = [None, None]
    person_frames = []   # persons 配列（出力用）
    contest_frames = []  # contested 抽出用の軽量列
    # スロット別サマリ集計（参考情報。同一性リークがあり得るため verdict には使わない）
    clean_stats = [{"sum": 0.0, "sumsq": 0.0, "n": 0} for _ in range(2)]
    all_stats = [{"sum": 0.0, "sumsq": 0.0, "n": 0} for _ in range(2)]
    # verdict 用: フレーム内の SHR 高い側 / 低い側の集計（人物追跡に依存しない）
    # 各要素: {"high": shr, "low": shr, "highSide": "left"|"right", "t": sec}
    pair_clean = []
    pair_all = []
    # ROIマスク状態
    roi = None          # (x0,y0,x1,y1) 正規化。None=全画面
    roi_miss = 0        # ROI内で誰も検出できなかった連続回数
    roi_masked_frames = 0
    roi_resets = 0
    edge_clipped_frames = 0  # 見切れにより verdict から除外したペアフレーム数
    typical_area = None  # ペアの典型bbox面積（観客フィルタの基準。小さい方のダンサーのEMA）
    duplicate_frames = 0  # 同じ人への二重検出が見つかったコマ数
    draw_frames = []    # デバッグ動画用の描画データ（2パス目で色を塗る）

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_interval != 0:
            frame_idx += 1
            continue

        t_sec = clock.time(frame_idx)

        # ROIマスク: 前フレームのペア位置の外側を塗りつぶして背景人物を視野から排除
        mask_roi = roi  # デバッグ動画の2パス目で同じマスクを再現するために控える
        work = apply_roi_mask(frame, roi) if roi is not None else frame
        if roi is not None:
            roi_masked_frames += 1

        candidates = detect_persons(model, work)
        # 同じ人への二重検出（面積上位 2 人を 1 人が占めて相手が外れる）。既定では数えるだけ
        deduped, duplicates = suppress_duplicates(candidates, frame.shape[1] / frame.shape[0])
        duplicate_frames += 1 if duplicates else 0
        if DEDUP_DUPLICATES:
            candidates = deduped
        else:
            duplicates = []
        # 観客フィルタ: ペアの典型体格より明らかに小さい人物は候補にすら入れない。
        # 片方のダンサーが完全に隠れた瞬間に、面積上位2人ルールで鏡の撮影者等が
        # 「2人目」に昇格してしまう問題への対策（骨格人形動画に観客が急に出現した実測）
        if typical_area is not None:
            spectators = [c for c in candidates if c["bboxArea"] < SPECTATOR_AREA_RATIO * typical_area]
            candidates = [c for c in candidates if c not in spectators]
        else:
            spectators = []
        persons = pick_main_pair(candidates)  # 背景の第三者を弾く（ROI内に紛れた場合の保険）
        rejected = spectators + duplicates + [c for c in candidates if c not in persons]
        if len(persons) == 2:
            smaller = min(p["bboxArea"] for p in persons)
            typical_area = smaller if typical_area is None \
                else (1 - SPECTATOR_AREA_EMA) * typical_area + SPECTATOR_AREA_EMA * smaller

        # ROI更新:
        #  - 2人検出: ペアのbbox合併+マージンで追従
        #  - 1人検出: オクルージョン中の可能性が高い。マージンを広げて維持（全画面に戻すと
        #    背景人物が「2人目」として拾われる汚染が起きるため戻さない）
        #  - 0人が2回連続: ペアを見失ったとみなし全画面へフォールバック
        if len(persons) >= 2:
            roi = roi_from_persons(persons, ROI_MARGIN)
            roi_miss = 0
        elif len(persons) == 1:
            roi = roi_from_persons(persons, ROI_MARGIN * 2)
            roi_miss = 0
        else:
            roi_miss += 1
            if roi is not None and roi_miss >= 2:
                roi = None
                roi_resets += 1

        slots = assign_slots(persons, prev_slots)
        # 検出できたスロットのみ prev を更新（欠けたスロットは位置を保持して復帰を待つ）
        for i in range(2):
            if slots[i] is not None:
                prev_slots[i] = slots[i]

        # 外見ID・イベント検出・デバッグ描画で共用する追跡レコード（デバッグ動画の有無に関わらず常時記録）
        draw_frames.append({
            "frameIdx": frame_idx,
            "t": t_sec,
            "maskRoi": mask_roi,  # このフレームの検出に実際に使ったマスク
            "roi": roi,           # 検出結果で更新した後のROI（次フレームで使われる枠）
            "kept": [{"bbox": p["bbox"], "shr2d": p["shr2d"], "hipX": p["hipX"],
                      "shDx": p["shDx"], "wrists": p["wrists"], "edgeClipped": p["edgeClipped"],
                      "shoulderW": p["shoulderW"], "bboxHpx": p["bboxHpx"],  # リーダークラスタ判定用
                      "kps": p["kps"],  # 骨格人形レンダリング用
                      # 肩だけで計測した人（腰が画面の下に切れている）の印と推した胴の長さ。全身の人には付けない
                      **({k: p[k] for k in ("torso", "torsoN")} if shoulders_only(p) else {}),
                      "hist": torso_hist(frame, p["bbox"]),  # 外見ID用（マスク前の生フレームから）
                      # 部位ごとの色・体の寸法（resolve_identity_joint 用。tracks.json には書かない）
                      "app": appearance_regions(frame, p, frame.shape[1] / frame.shape[0]) if IDENTITY_JOINT else None}
                     for p in persons],
            "rejected": [{"bbox": p["bbox"], "shr2d": p["shr2d"]} for p in rejected],
        })

        both = slots[0] is not None and slots[1] is not None
        occluded = False
        if both:
            d = math.hypot(slots[0]["hipX"] - slots[1]["hipX"], slots[0]["hipY"] - slots[1]["hipY"])
            occluded = d < OCCLUSION_DIST
        elif len(persons) == 1 and prev_slots[0] is not None and prev_slots[1] is not None:
            occluded = True  # 2人いたはずが1人しか検出できない＝重なりの可能性

        z_front = -1
        if both:
            z_front = 0 if slots[0]["shoulderW"] >= slots[1]["shoulderW"] else 1

        # どちらかが画面端で見切れているフレームは SHR 計測が信用できないため
        # verdict 母集団・拮抗判定から外す（shrDiff=None は直前値補間される）
        edge_clipped = both and (slots[0]["edgeClipped"] or slots[1]["edgeClipped"])
        if edge_clipped:
            edge_clipped_frames += 1

        shr_diff = None
        # 肩だけの人（腰が画面の外）は SHR が無いので verdict・拮抗の母集団に入れない
        has_shr = both and slots[0]["shr2d"] is not None and slots[1]["shr2d"] is not None
        if has_shr and not edge_clipped:
            shr_diff = abs(slots[0]["shr2d"] - slots[1]["shr2d"])
            hi, lo = (slots[0], slots[1]) if slots[0]["shr2d"] >= slots[1]["shr2d"] else (slots[1], slots[0])
            pair = {
                "high": hi["shr2d"],
                "low": lo["shr2d"],
                "highSide": "left" if hi["hipX"] < lo["hipX"] else "right",
                "t": t_sec,
            }
            pair_all.append(pair)
            if not occluded:
                pair_clean.append(pair)
        for i in range(2):
            if slots[i] is not None and slots[i]["shr2d"] is not None:
                all_stats[i]["sum"] += slots[i]["shr2d"]
                all_stats[i]["sumsq"] += slots[i]["shr2d"] ** 2
                all_stats[i]["n"] += 1
                # 密着姿勢・見切れでは肩・腰の計測が崩れるためクリーン集計から除外
                if not occluded and not slots[i]["edgeClipped"]:
                    clean_stats[i]["sum"] += slots[i]["shr2d"]
                    clean_stats[i]["sumsq"] += slots[i]["shr2d"] ** 2
                    clean_stats[i]["n"] += 1

        person_frames.append({
            "t": round(t_sec, 3),
            "slots": [
                ({**{k: slots[i][k] for k in ("hipX", "hipY", "shr2d")}, "occluded": occluded}
                 if slots[i] is not None else None)
                for i in range(2)
            ],
            "zFront": z_front,
        })
        contest_frames.append({"t": t_sec, "shrDiff": shr_diff, "occluded": occluded})

        sampled += 1
        frame_idx += 1

    cap.release()

    # 外見IDの割り当て → 技イベント検出（Turn/CBL）+ ホールドタイムライン（デバッグ動画の有無に関わらず実行）
    leader_pid = assign_appearance_ids(draw_frames) if draw_frames else None

    # Claude アンカーによるリーダー上書き（併用方針: 写真で間違えようがない意味判断は
    # Claude が先に1回だけ行い、CVはそれを基準に計測する。ヒントが無い/壊れている場合は
    # 上の中央値多数決がそのまま使われる）
    if leader_hint and draw_frames:
        leader_pid = leader_from_hint(draw_frames, leader_pid, leader_hint)

    events = detect_events(draw_frames, leader_pid) if draw_frames else []
    if events:
        events = refine_turns_dense(video_path, model, draw_frames, events, leader_pid, clock=clock)
    events = apply_cbl_pass_half(events)
    hold_timeline = build_hold_timeline(draw_frames, leader_pid) if draw_frames else []
    hold_unclear_spans = build_hold_unclear(draw_frames, leader_pid) if draw_frames else []

    # デバッグ動画（2パス目）: 全編の計測を踏まえたロールで色を塗り、イベントラベルを焼き込む
    if debug_video_path is not None and draw_frames:
        render_debug_video(video_path, debug_video_path, draw_frames, leader_pid, effective_fps, events)

    # 骨格人形動画: 実写なしで踊りを再現（Leader=青 / Follower=ピンク）
    if skeleton_video_path is not None and draw_frames:
        render_skeleton_video(skeleton_video_path, draw_frames, leader_pid, effective_fps, events)

    # サマリ
    def slot_summary(s):
        if s["n"] == 0:
            return {"shrMean": None, "shrStd": None, "samples": 0}
        mean = s["sum"] / s["n"]
        var = max(0.0, s["sumsq"] / s["n"] - mean ** 2)
        return {"shrMean": round(mean, 4), "shrStd": round(math.sqrt(var), 4), "samples": s["n"]}

    # スロット別サマリ（参考情報のみ。同一性リークがあり得るため verdict には使わない）
    clean0, clean1 = slot_summary(clean_stats[0]), slot_summary(clean_stats[1])
    all0, all1 = slot_summary(all_stats[0]), slot_summary(all_stats[1])
    sum0 = {**clean0, "samplesAll": all0["samples"]}
    sum1 = {**clean1, "samplesAll": all1["samples"]}

    # verdict: フレーム内 high/low の分離（人物追跡に依存しない）。クリーン優先、不足時フォールバック
    use_clean = len(pair_clean) >= MIN_CLEAN_SAMPLES
    pairs = pair_clean if use_clean else pair_all
    basis = "clean" if use_clean else "all_frames_fallback"

    if pairs:
        high_mean = sum(p["high"] for p in pairs) / len(pairs)
        low_mean = sum(p["low"] for p in pairs) / len(pairs)
        separation = high_mean - low_mean
        leader_exists = separation >= SHR_DIFF_THRESHOLD
        # 開始時に SHR 高い側がどちらにいたか（最初の5ペアフレームの多数決）
        first = pairs[:5]
        left_votes = sum(1 for p in first if p["highSide"] == "left")
        leader_at_start = {
            "side": "left" if left_votes * 2 > len(first) else "right",
            "t": round(first[0]["t"], 2),
        }
        # high側が同じ側に居続けた割合（1に近い＝交差が少なく位置でも追える。参考指標）
        left_ratio = sum(1 for p in pairs if p["highSide"] == "left") / len(pairs)
        verdict = {
            "leaderExists": leader_exists,
            "separation": round(separation, 4),
            "highMean": round(high_mean, 4),
            "lowMean": round(low_mean, 4),
            "confidence": round(min(0.95, 0.5 + separation * 5), 2) if leader_exists else 0.5,
            "basis": basis,
            "leaderAtStart": leader_at_start,
            "highSideConsistency": round(max(left_ratio, 1 - left_ratio), 3),
        }
    else:
        verdict = {
            "leaderExists": False, "separation": None, "highMean": None, "lowMean": None,
            "confidence": 0.0, "basis": basis, "leaderAtStart": None, "highSideConsistency": None,
        }

    # 機械可読の信頼度指標（P2/UI が「ルールベースが当てになるか」を即判断できる）
    reliability = {
        "cleanPairFrames": len(pair_clean),
        "allPairFrames": len(pair_all),
        "cleanRatio": round(len(pair_clean) / len(pair_all), 3) if pair_all else 0.0,
        "roiMaskedFrames": roi_masked_frames,
        "roiResets": roi_resets,
        "edgeClippedPairFrames": edge_clipped_frames,
        "duplicateFrames": duplicate_frames,  # 同じ人への二重検出が見つかったコマ数（DEDUP_DUPLICATES で除く）
    }

    contested, dropped = extract_contested(contest_frames, effective_fps)
    # 全体拮抗（分離が閾値未満）なら、区間に関係なく全編が判定困難であることを明示
    if not verdict["leaderExists"] and pairs:
        if not contested:
            total_t = contest_frames[-1]["t"] if contest_frames else 0.0
            contested = [{"from": 0.0, "to": round(total_t, 2), "reason": "shr_separation<threshold"}]

    # tracks.json: 解析済みの「原盤」（骨格+人物ID+イベント）。これがあれば以降の
    # 技検出ルールの調整・骨格動画の再生成・新検出器の遡及適用は YOLO を回さず数秒で済む
    # （重い知覚は動画1本につき1回だけ、という方針。ユーザー発案）。
    # 出力名は measurements パスから派生（measurements.json → measurements.tracks.json）→
    # 複数動画を同一ディレクトリで解析しても衝突しない
    tracks_path = os.path.splitext(os.path.abspath(output_path))[0] + ".tracks.json"
    frame_clock_name = "pts" if clock.is_pts else "index"
    with open(tracks_path, "w") as f:
        json.dump({
            "version": 1,
            "video": os.path.basename(video_path),
            "fps": fps,
            "frameClock": frame_clock_name,
            "sampledFps": round(effective_fps, 2),
            "leaderPid": leader_pid,
            # events/holdTimeline も原盤に同梱（コメントの「骨格+人物ID+イベント」を満たす）。
            # これで analyze_skill.py が tracks.json 単体で上手さ指標を計算できる
            "events": events,
            "holdTimeline": hold_timeline,
            "frames": [
                {k: v for k, v in df.items() if k != "kept"} | {
                    "kept": [{k: v for k, v in p.items() if k not in ("hist", "app")} for p in df["kept"]],
                }
                for df in draw_frames
            ],
        }, f)

    with open(output_path, "w") as f:
        json.dump({
            "detector": "yolov8-pose",
            "shrMode": "2d",
            "fps": fps,
            "sampledFps": round(effective_fps, 2),
            "totalFrames": frame_idx,
            "sampledFrames": sampled,
            "persons": person_frames,
            "frameClock": frame_clock_name,
            "summary": {
                # 時刻の時計: "pts" = 動画のタイムスタンプ（README 26）/ "index" = コマ番号 / fps（PTS が取れない動画・
                # 2026-10-05 より前のジョブには無い）。normalize_routine の偶然の門（SWAP_MIN_Z2）は "pts" のときだけ（README 27）
                "frameClock": frame_clock_name,
                "slot0": sum0,
                "slot1": sum1,
                "verdictByRule": verdict,
                "reliability": reliability,
                "contested": contested,
                "contestedDropped": dropped,
                # 技イベント候補（ルールベース検出。採用可否は P2 の Claude が裁定）
                "events": events,
                # 手のつなぎの全編タイムライン（技間の持ち替えを連鎖記述に使う）
                "holdTimeline": hold_timeline,
                # 2人が重なる・片方が隠れる等で、手首から手のつなぎを読めない区間（この間の hold は信用しない）
                "holdUnclear": hold_unclear_spans,
            },
        }, f)

    print(
        f"done: {sampled}/{frame_idx} frames sampled, "
        f"pairFrames clean={reliability['cleanPairFrames']}/all={reliability['allPairFrames']}, "
        f"verdict={verdict}, contested={len(contested)} (+{dropped} dropped), "
        f"events={events}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
