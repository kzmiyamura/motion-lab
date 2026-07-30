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
import sys
import json
import math
import cv2
import numpy as np
from ultralytics import YOLO

# COCO 17 keypoints
LEFT_SHOULDER = 5
RIGHT_SHOULDER = 6
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


def measure_person(box_xyxyn, kps_xy, kps_conf, det_conf, frame_w, frame_h):
    """1人分の検出結果から計測値を返す。肩・腰が低信頼なら None

    位置系（hipX/hipY/bbox）は正規化座標（既存の閾値・ROIロジックと互換）、
    幅系（肩幅・腰幅）はピクセル座標（比を取るので単位は相殺される）
    """
    need = (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP)
    if any(kps_conf[i] < KP_CONF for i in need):
        return None
    sl, sr = kps_xy[LEFT_SHOULDER], kps_xy[RIGHT_SHOULDER]
    hl, hr = kps_xy[LEFT_HIP], kps_xy[RIGHT_HIP]
    shoulder_w = float(np.linalg.norm(sl - sr))
    hip_w = float(np.linalg.norm(hl - hr))
    if hip_w < 1.0:  # 1px 未満は計測不能
        return None
    x0, y0, x1, y1 = (float(v) for v in box_xyxyn)
    return {
        "hipX": round(float(hl[0] + hr[0]) / 2 / frame_w, 4),
        "hipY": round(float(hl[1] + hr[1]) / 2 / frame_h, 4),
        "shr2d": round(shoulder_w / hip_w, 4),
        "shoulderW": round(shoulder_w, 1),
        # 左肩と右肩の画面X差（正規化・符号付き）。符号 = 体の向き（正面/背面）の指標。
        # ターン検出は「この符号の反転回数」で行う（幅の収縮より直接的）
        "shDx": round(float(sl[0] - sr[0]) / frame_w, 4),
        "bboxHpx": round((y1 - y0) * frame_h, 1),
        "bboxArea": round((x1 - x0) * (y1 - y0), 5),
        "bbox": (x0, y0, x1, y1),
        "conf": round(float(det_conf), 3),
        # 画面左右端で体が見切れていると肩・腰が切れて SHR が崩れる（検証動画の冒頭で
        # 男性が右端に見切れて SHR 0.73 に潰れ、leaderAtStart を誤らせた実績あり）。
        # 追跡・ROI には使うが verdict 母集団からは除外する
        "edgeClipped": x0 <= EDGE_MARGIN or x1 >= 1.0 - EDGE_MARGIN,
    }


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
            persons.append(m)
    return persons


def pick_main_pair(persons):
    """検出候補から bbox 面積の大きい上位2人（＝カメラ手前のダンサーペア）を選ぶ。

    背景の鏡・通行人など小さく写る第三者を弾く。3人目が主ペアと同等サイズの
    場合は選別できないが、その場合はスロットNNトラッキングの連続性に委ねる。
    """
    if len(persons) <= 2:
        return persons
    return sorted(persons, key=lambda p: p["bboxArea"], reverse=True)[:2]


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


def torso_hist(frame, bbox):
    """人物 bbox 上部の HSV 色ヒストグラム（正規化済み64次元）を返す。

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
    hist = cv2.calcHist([hsv], [0, 1], None, [8, 8], [0, 180, 0, 256])
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return hist.flatten()


def hist_dist(a, b):
    return float(np.abs(a - b).sum())


def assign_appearance_ids(draw_frames):
    """外見（色ヒストグラム）で全検出を2人分のクラスタに分け、Leader クラスタを決める。

    - 各フレームの検出を、リファレンスヒストグラム（EMA更新）との距離で
      人物ID 0/1 に割り当てる（2人同時のときはペア割り当てコストの小さい方）
    - Leader は「クラスタ単位の SHR 平均」が高い方（フレーム単位の勝負ではないので
      横向きの一瞬に色が乗っ取られない）
    - 各 kept エントリに "pid" を書き込み、Leader の pid を返す（判定不能なら None）
    """
    refs = [None, None]
    for df in draw_frames:
        ks = [p for p in df["kept"] if p.get("hist") is not None]
        if refs[0] is None:
            if len(ks) == 2:
                refs[0], refs[1] = ks[0]["hist"].copy(), ks[1]["hist"].copy()
                ks[0]["pid"], ks[1]["pid"] = 0, 1
            continue
        if len(ks) == 2:
            direct = hist_dist(ks[0]["hist"], refs[0]) + hist_dist(ks[1]["hist"], refs[1])
            swapped = hist_dist(ks[0]["hist"], refs[1]) + hist_dist(ks[1]["hist"], refs[0])
            pids = (0, 1) if direct <= swapped else (1, 0)
        elif len(ks) == 1:
            pids = (0,) if hist_dist(ks[0]["hist"], refs[0]) <= hist_dist(ks[0]["hist"], refs[1]) else (1,)
        else:
            continue
        for p, pid in zip(ks, pids):
            p["pid"] = pid
            refs[pid] = (1.0 - APPEARANCE_EMA) * refs[pid] + APPEARANCE_EMA * p["hist"]

    # Leader クラスタ = クリーンなペアフレームでの SHR 平均が高い方
    sums = {0: [0.0, 0], 1: [0.0, 0]}
    for df in draw_frames:
        ks = [p for p in df["kept"] if p.get("pid") is not None]
        if len(ks) == 2 and ks[0]["pid"] != ks[1]["pid"] and not any(p["edgeClipped"] for p in ks):
            for p in ks:
                sums[p["pid"]][0] += p["shr2d"]
                sums[p["pid"]][1] += 1
    if sums[0][1] == 0 or sums[1][1] == 0:
        return None
    return 0 if sums[0][0] / sums[0][1] >= sums[1][0] / sums[1][1] else 1


# --- 技イベント検出（ロードマップ②: Turn / CBL のタイムスタンプ候補） ---
# ブラウザ版 usePoseEstimation.ts の runPatternDetection() を、オフライン+外見ID前提で強化移植。
# あくまで「候補」であり誤検出があり得る。最終的な採用可否・命名は P2 の Claude が裁定する

TURN_FLIP_WINDOW = 1.5     # この秒数以内に向き反転が2回 = 一回転（360°）
TURN_FLIP_MARGIN = 0.015   # 左右肩のX分離がこれ未満（真横向き）は向き不定として無視
TURN_SWEEP_MIN = 0.04      # 反転の前後で要求する肩分離の振り幅（しっかり正面/背面まで回ったこと）
TURN_PRE_SEC = 1.0         # 1回目の反転前にこの秒数以内で旧向きの振り幅があること
CBL_MIN_SEP = 0.08         # 交差前後で必要な左右分離（正規化X。ジッタの往復を弾く）
CBL_WINDOW_SEC = 2.0       # 交差の前後この秒数内に十分な分離があること
CBL_PIVOT_SUPPRESS_SEC = 1.2  # CBLの±この秒数内のリーダーのターンはCBLのピボット動作として棄却
EVENT_COOLDOWN_SEC = 2.5   # 同種イベントの最小間隔


def detect_turns(draw_frames, pid):
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

    events = []
    last_event = -1e9
    i = 0
    while i + 1 < len(flips):
        (t1, sign_before), (t2, _) = flips[i], flips[i + 1]
        if (
            t2 - t1 <= TURN_FLIP_WINDOW
            and t1 - last_event > EVENT_COOLDOWN_SEC
            and sweep_ok(t1 - TURN_PRE_SEC, t1, sign_before)   # 反転前: 旧向きでしっかり見えていた
            and sweep_ok(t1, t2, -sign_before)                 # 反転間: 背面までしっかり回った
        ):
            events.append(round(t1, 2))
            last_event = t1
            i += 2  # 使った反転ペアはスキップ（1回転=2反転を重複カウントしない）
        else:
            i += 1
    return events


def detect_cbl(draw_frames):
    """CBL（クロスボディリード）候補時刻を返す。

    CBL の定義そのものである「2人の左右位置の入れ替わり」を検出する。
    腰X差の符号反転のうち、交差の前後 CBL_WINDOW_SEC 以内に十分な分離
    （CBL_MIN_SEP 以上）が両側にあるものだけを採用（密着中のジッタを弾く）
    """
    pair = []  # (t, hipX[pid0] - hipX[pid1])
    for df in draw_frames:
        by_pid = {p.get("pid"): p for p in df["kept"] if p.get("pid") is not None}
        if 0 in by_pid and 1 in by_pid:
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
        if ok_before and ok_after and t_cur - last_event > EVENT_COOLDOWN_SEC:
            events.append(round(t_cur, 2))
            last_event = t_cur
    return events


def detect_events(draw_frames, leader_pid):
    """全イベントを時刻順で返す: [{t, type, by}]

    リーダーの「随伴回転」を棄却する2つのフィルタ（いずれも実測で誤検出を確認済み）:
    - CBL 近傍: リーダーは CBL のリード動作で体を半回転させて戻す（CBLの一部でありターンではない）
    - フォロワーのターン近傍: フォロワーを回すとき、リーダーの上体も連られて回る
    フォロワーのターンは CBL 中でも本物（クロスボディ・インサイドターン）なので常に残す。
    リーダーの単独ターン（フック ターン等）は近傍に何も無ければ検出される
    """
    cbl_times = detect_cbl(draw_frames)
    events = [{"t": t, "type": "CBL", "by": "pair"} for t in cbl_times]

    turns = {0: detect_turns(draw_frames, 0), 1: detect_turns(draw_frames, 1)}
    follower_pid = None if leader_pid is None else 1 - leader_pid
    follower_turns = turns.get(follower_pid, []) if follower_pid is not None else []

    for pid in (0, 1):
        if leader_pid is None:
            by = "unknown"
        else:
            by = "leader" if pid == leader_pid else "follower"
        for t in turns[pid]:
            if by == "leader" and any(abs(t - ct) <= CBL_PIVOT_SUPPRESS_SEC for ct in cbl_times):
                continue
            if by == "leader" and any(abs(t - ft) <= CBL_PIVOT_SUPPRESS_SEC for ft in follower_turns):
                continue
            events.append({"t": t, "type": "Turn", "by": by})
    events.sort(key=lambda e: e["t"])
    return events


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
        label = f"{tag} SHR {p['shr2d']:.2f}".strip()
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
            labels = [f"{e['type'].upper()} ({e['by']})" if e["by"] != "pair" else e["type"].upper()
                      for e in events if e["t"] <= df["t"] <= e["t"] + EVENT_LABEL_SEC]
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


def main():
    if len(sys.argv) not in (4, 5):
        print("Usage: analyze_pair.py <video_path> <yolo_model_path> <output_json_path> [debug_video_path]", file=sys.stderr)
        sys.exit(1)

    video_path, model_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]
    debug_video_path = sys.argv[4] if len(sys.argv) == 5 else None

    model = YOLO(model_path)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = max(1, round(fps / TARGET_FPS))
    effective_fps = fps / frame_interval

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
    draw_frames = []    # デバッグ動画用の描画データ（2パス目で色を塗る）

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_interval != 0:
            frame_idx += 1
            continue

        t_sec = frame_idx / fps

        # ROIマスク: 前フレームのペア位置の外側を塗りつぶして背景人物を視野から排除
        mask_roi = roi  # デバッグ動画の2パス目で同じマスクを再現するために控える
        work = apply_roi_mask(frame, roi) if roi is not None else frame
        if roi is not None:
            roi_masked_frames += 1

        candidates = detect_persons(model, work)
        persons = pick_main_pair(candidates)  # 背景の第三者を弾く（ROI内に紛れた場合の保険）
        rejected = [c for c in candidates if c not in persons]

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
                      "shDx": p["shDx"], "edgeClipped": p["edgeClipped"],
                      "hist": torso_hist(frame, p["bbox"])}  # 外見ID用（マスク前の生フレームから）
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
        if both and not edge_clipped:
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
            if slots[i] is not None:
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

    # 外見IDの割り当て → 技イベント検出（Turn/CBL。デバッグ動画の有無に関わらず実行）
    leader_pid = assign_appearance_ids(draw_frames) if draw_frames else None
    events = detect_events(draw_frames, leader_pid) if draw_frames else []

    # デバッグ動画（2パス目）: 全編の計測を踏まえたロールで色を塗り、イベントラベルを焼き込む
    if debug_video_path is not None and draw_frames:
        render_debug_video(video_path, debug_video_path, draw_frames, leader_pid, effective_fps, events)

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
    }

    contested, dropped = extract_contested(contest_frames, effective_fps)
    # 全体拮抗（分離が閾値未満）なら、区間に関係なく全編が判定困難であることを明示
    if not verdict["leaderExists"] and pairs:
        if not contested:
            total_t = contest_frames[-1]["t"] if contest_frames else 0.0
            contested = [{"from": 0.0, "to": round(total_t, 2), "reason": "shr_separation<threshold"}]

    with open(output_path, "w") as f:
        json.dump({
            "detector": "yolov8-pose",
            "shrMode": "2d",
            "fps": fps,
            "sampledFps": round(effective_fps, 2),
            "totalFrames": frame_idx,
            "sampledFrames": sampled,
            "persons": person_frames,
            "summary": {
                "slot0": sum0,
                "slot1": sum1,
                "verdictByRule": verdict,
                "reliability": reliability,
                "contested": contested,
                "contestedDropped": dropped,
                # 技イベント候補（ルールベース検出。採用可否は P2 の Claude が裁定）
                "events": events,
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
