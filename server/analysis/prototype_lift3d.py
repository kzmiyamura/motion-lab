#!/usr/bin/env python3
"""
2D原盤(tracks.json) → 3D姿勢 の実験プロトタイプ（ルート①: bbox切り出し + MediaPipe単人検出）。

■ なぜこれで3Dが取れるのか
YOLOv8-pose の COCO 17点は 2D 画像座標しか持たない（z が存在しない）。一方 MediaPipe の
Pose Landmarker は `pose_world_landmarks` として「腰中点を原点とするメートル単位の3D姿勢」を返す。
ペア解析で MediaPipe をやめたのは *全画面で2人を同時検出させると 4% しか成功しなかった* からで、
1人だけ写った画像に対する精度が悪いわけではない。そこで YOLO が既に出している信頼できる bbox で
1人ずつ切り出し、単人モードの MediaPipe を2回走らせる。多人数検出の失敗モードを丸ごと回避できる。

■ 座標系の変換（この実験の本体）
1) MediaPipe world landmarks:  原点=腰中点 / 単位=メートル / x=右 y=下 z=奥(小さいほどカメラに近い)
   → 画像座標と同じ向きに揃えた「カメラ基準」の右手系。
2) three.js:                   x=右 / y=上 / z=手前(カメラは +Z から -Z を見る) の右手系。
   → 変換は X軸まわり180度回転、すなわち (x, y, z) -> (x, -y, -z)。
     y と z の2軸を反転するので行列式は +1、つまり鏡像にならず手系が保たれる（ここを1軸だけ
     反転すると左右が反転した踊りになる — 実験で最も間違えやすい点）。

3) 体の「向き」だけでは2人を空間に置けない。world landmarks は腰原点の相対座標なので、
   2人の位置関係（特に前後＝奥行き）は別に復元する必要がある。ペアダンスでは CBL やターンの
   見え方をこの相対奥行きが決めるので手を抜けない。ここでは弱透視(weak perspective)で解く:

     各ボーンについて  px_per_m = (画像上のピクセル長) / (world landmark の XY 平面長)
     を求め、全ボーンの中央値を取る。world landmarks は既にカメラ基準の向きなので、その XY 成分は
     画像平面への正射影に対応する。よって回転・前後の傾きによる短縮(foreshortening)は分子と分母の
     両方に同じだけ効き、比は姿勢に依らず「スケールだけ」を表す。
     単一ボーン（例: 肩幅）で測ると横向きの瞬間に潰れて奥行きが暴れるが、中央値なら安定する。

     深度 Z = f / px_per_m,   横位置 X = (u - cx) * Z / f,   縦位置 Y = (v - cy) * Z / f
     （f = 焦点距離[px]。カメラ内部パラメータは動画に無いので水平画角から仮定する。
       f は場面全体のスケールと遠近の強さを決めるだけで、2人の *相対* 奥行きの順序は変えない）

出力: JSON（three.js 座標系・メートル）。frames[].persons[].root と .joints[33]

Usage:
  python prototype_lift3d.py <tracks.json> <video> <pose_landmarker_heavy.task> <out.json>
                             [--stride N] [--max-frames N] [--hfov 68]
"""
import sys
import json
import math
import argparse

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

# MediaPipe Pose 33点のうち、スケール推定に使う剛体的なボーン。
# 手先・顔は動きが速く誤差が大きいので使わない。
SCALE_BONES = [
    (11, 12),  # 肩幅
    (23, 24),  # 腰幅
    (11, 23), (12, 24),  # 胴の左右
    (23, 25), (24, 26),  # 大腿
    (25, 27), (26, 28),  # 下腿
    (11, 13), (12, 14),  # 上腕
    (13, 15), (14, 16),  # 前腕
]
VIS_MIN = 0.5          # このスコア未満の landmark はスケール推定から外す
CROP_MARGIN = 0.18     # bbox に対する上下左右のマージン比
CROP_MIN_SIDE = 256    # 切り出しが小さいと精度が落ちるので拡大する下限


def crop_person(frame, bbox, w, h):
    """正規化 bbox にマージンを付けて切り出す。(crop, x0, y0, scale) を返す"""
    x1, y1, x2, y2 = bbox
    bw, bh = (x2 - x1) * w, (y2 - y1) * h
    mx, my = bw * CROP_MARGIN, bh * CROP_MARGIN
    x0 = max(0, int(x1 * w - mx))
    y0 = max(0, int(y1 * h - my))
    x3 = min(w, int(x2 * w + mx))
    y3 = min(h, int(y2 * h + my))
    if x3 - x0 < 16 or y3 - y0 < 16:
        return None, 0, 0, 1.0
    crop = frame[y0:y3, x0:x3]
    # 小さすぎる切り出しは拡大してから推論（MediaPipe は入力解像度に敏感）
    scale = 1.0
    short = min(crop.shape[0], crop.shape[1])
    if short < CROP_MIN_SIDE:
        scale = CROP_MIN_SIDE / short
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
    return crop, x0, y0, scale


def estimate_scale(world, img_px):
    """px_per_m の中央値を返す。world=(33,3)[m], img_px=(33,2)[px]。
    不可視の点は NaN が入っている前提で、両端が有効なボーンだけを使う
    （NaN を 0 に潰すと「原点までの距離」という嘘のボーン長が混じって中央値を汚す）"""
    ratios = []
    for a, b in SCALE_BONES:
        if not (np.all(np.isfinite(world[a])) and np.all(np.isfinite(world[b]))
                and np.all(np.isfinite(img_px[a])) and np.all(np.isfinite(img_px[b]))):
            continue
        # world landmark の XY 平面長（= 画像平面への正射影の長さ・メートル）
        wxy = math.hypot(world[a][0] - world[b][0], world[a][1] - world[b][1])
        if wxy < 1e-3:
            continue
        ipx = math.hypot(img_px[a][0] - img_px[b][0], img_px[a][1] - img_px[b][1])
        if ipx < 2.0:
            continue
        ratios.append(ipx / wxy)
    if len(ratios) < 4:
        return None
    return float(np.median(ratios))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tracks")
    ap.add_argument("video")
    ap.add_argument("model")
    ap.add_argument("out")
    ap.add_argument("--stride", type=int, default=1, help="tracks のフレームを何個おきに処理するか")
    ap.add_argument("--max-frames", type=int, default=0, help="0 なら全部")
    ap.add_argument("--fps", type=float, default=0.0,
                    help="この fps まで密に取り直す。tracks の bbox を時間補間して間のフレームも "
                         "MediaPipe にかける。原盤は10.5fpsだが手首は1フレームで20cm以上飛ぶことがあり、"
                         "その速さは10.5fpsでは表現できない。0 で無効（原盤のフレームのみ）")
    ap.add_argument("--hfov", type=float, default=68.0, help="水平画角[度]。iPhone メインカメラの実測相当")
    args = ap.parse_args()

    tracks = json.load(open(args.tracks))
    frames = tracks["frames"]
    if args.stride > 1:
        frames = frames[:: args.stride]
    if args.max_frames:
        frames = frames[: args.max_frames]

    # want: 動画のフレーム番号 -> {"t": 秒, "persons": [{"pid", "bbox"}]}
    want = {}
    if args.fps <= 0:
        for f in frames:
            want[f["frameIdx"]] = {
                "t": f["t"],
                "persons": [{"pid": p["pid"], "bbox": p["bbox"]}
                            for p in f["kept"] if p.get("pid") is not None],
            }
    else:
        # 原盤の bbox を人物ごとの時系列にして、目標 fps の時刻へ線形補間する。
        # bbox は人の位置なので滑らかに動く量であり、この補間は安全（姿勢は補間していない —
        # 間のフレームは実際に MediaPipe にかけるので、動きは捏造ではなく新しい観測になる）。
        series = {}
        for f in frames:
            for p in f["kept"]:
                if p.get("pid") is None:
                    continue
                series.setdefault(p["pid"], []).append((f["t"], f["frameIdx"], p["bbox"]))
        vfps = float(tracks.get("fps") or 30.0)
        t_end = frames[-1]["t"]
        step = 1.0 / args.fps
        # 原盤のサンプル間隔より大きく開いた区間は補間しない（人物が居ない区間を埋めない）
        src_dt = 1.0 / float(tracks.get("sampledFps") or 10.0)
        max_gap = src_dt * 2.5
        t = 0.0
        while t <= t_end + 1e-6:
            fidx = int(round(t * vfps))
            persons = []
            for pid, arr in series.items():
                # t を挟む2サンプルを探す
                lo, hi = None, None
                for k in range(len(arr) - 1):
                    if arr[k][0] <= t <= arr[k + 1][0]:
                        lo, hi = arr[k], arr[k + 1]
                        break
                if lo is None:
                    if abs(arr[0][0] - t) < 1e-6:
                        persons.append({"pid": pid, "bbox": arr[0][2]})
                    continue
                if hi[0] - lo[0] > max_gap:
                    continue
                w = 0.0 if hi[0] == lo[0] else (t - lo[0]) / (hi[0] - lo[0])
                bb = [lo[2][i] * (1 - w) + hi[2][i] * w for i in range(4)]
                persons.append({"pid": pid, "bbox": bb})
            if persons and fidx not in want:
                want[fidx] = {"t": t, "persons": persons}
            t += step

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"failed to open video: {args.video}", file=sys.stderr)
        sys.exit(1)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    f_px = (W / 2.0) / math.tan(math.radians(args.hfov) / 2.0)
    cx, cy = W / 2.0, H / 2.0
    print(f"video {W}x{H}  f={f_px:.1f}px (hfov={args.hfov}deg)  frames to lift={len(want)}", file=sys.stderr)

    options = PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=args.model),
        running_mode=RunningMode.IMAGE,
        num_poses=1,
        min_pose_detection_confidence=0.3,
        min_pose_presence_confidence=0.3,
    )

    out_frames = []
    stats = {0: 0, 1: 0}
    attempts = {0: 0, 1: 0}
    frame_idx = 0
    done = 0

    with PoseLandmarker.create_from_options(options) as landmarker:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            df = want.get(frame_idx)
            if df is None:
                frame_idx += 1
                continue

            persons = []
            for p in df["persons"]:
                pid = p["pid"]
                attempts[pid] = attempts.get(pid, 0) + 1
                crop, x0, y0, s = crop_person(frame, p["bbox"], W, H)
                if crop is None:
                    continue
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                                  data=cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                res = landmarker.detect(mp_img)
                if not res.pose_world_landmarks or not res.pose_landmarks:
                    continue

                wl = res.pose_world_landmarks[0]
                il = res.pose_landmarks[0]
                ch, cw = crop.shape[0], crop.shape[1]
                # 切り出し内の正規化座標 → 元画像のピクセル座標へ戻す
                img_px = np.array([[x0 + lm.x * cw / s, y0 + lm.y * ch / s] for lm in il], dtype=np.float64)
                world = np.array([[lm.x, lm.y, lm.z] for lm in wl], dtype=np.float64)
                vis = np.array([lm.visibility for lm in il], dtype=np.float64)

                # 見えていない点はスケール推定から外す
                wm = world.copy()
                for i in range(len(vis)):
                    if vis[i] < VIS_MIN:
                        wm[i] = np.nan
                        img_px[i] = np.nan
                px_per_m = estimate_scale(wm, img_px)
                if px_per_m is None or px_per_m <= 1e-6:
                    continue

                depth = f_px / px_per_m  # メートル
                # 腰中点の画像座標（world landmarks の原点に対応する点）
                hip_u = (img_px[23][0] + img_px[24][0]) / 2.0
                hip_v = (img_px[23][1] + img_px[24][1]) / 2.0
                if not (np.isfinite(hip_u) and np.isfinite(hip_v)):
                    continue

                # --- 座標変換 ---
                # ピンホールで腰中点を3D空間へ。画像 v は下向き正なので three の Y は符号反転。
                root_x = (hip_u - cx) * depth / f_px
                root_y = -(hip_v - cy) * depth / f_px
                root_z = -depth  # カメラは原点から -Z を見る → 前方は負
                # 関節は腰原点の相対座標のまま、X軸まわり180度回転で three.js 系へ
                joints = [[float(p3[0]), float(-p3[1]), float(-p3[2])] for p3 in world]

                persons.append({
                    "pid": pid,
                    "root": [round(root_x, 4), round(root_y, 4), round(root_z, 4)],
                    "joints": [[round(v, 4) for v in j] for j in joints],
                    "vis": [round(float(v), 2) for v in vis],
                    "depthM": round(depth, 3),
                    "pxPerM": round(px_per_m, 1),
                    # 2D対応点も残す。f を後から推定し直して root を再計算できるようにするため
                    # （MediaPipe を回すのは高いので、知覚は1回・幾何は何度でも、の方針）
                    "img": [[round(float(q[0]), 1), round(float(q[1]), 1)] if np.isfinite(q[0]) else None
                            for q in img_px],
                    "hipUV": [round(hip_u, 1), round(hip_v, 1)],
                })
                stats[pid] = stats.get(pid, 0) + 1

            if persons:
                out_frames.append({"t": round(df["t"], 3), "frameIdx": frame_idx, "persons": persons})
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(want)} lifted", file=sys.stderr)
            frame_idx += 1

    cap.release()

    both = [f for f in out_frames if len(f["persons"]) == 2]
    seps = []
    for f in both:
        d = {p["pid"]: p["depthM"] for p in f["persons"]}
        seps.append(d[0] - d[1])

    json.dump({
        "version": 1,
        "source": args.tracks,
        "video": tracks.get("video"),
        "fps": tracks.get("fps"),
        # 密に取り直した場合は実際の間隔を書く（原盤の 10.5 を引き継ぐと後段の平滑化が
        # 時間窓を3倍に見誤る）
        "sampledFps": args.fps if args.fps > 0 else tracks.get("sampledFps"),
        "leaderPid": tracks.get("leaderPid"),
        "events": tracks.get("events"),
        "axes": "three.js: x=right y=up z=toward camera, meters, root=hip midpoint",
        "camera": {"width": W, "height": H, "fPx": round(f_px, 1), "hfovDeg": args.hfov},
        "frames": out_frames,
    }, open(args.out, "w"))

    print(
        f"done: lifted {len(out_frames)} frames, both-persons {len(both)}\n"
        f"  pid0 {stats.get(0,0)}/{attempts.get(0,0)}  pid1 {stats.get(1,0)}/{attempts.get(1,0)}\n"
        f"  depth median pid0={np.median([p['depthM'] for f in out_frames for p in f['persons'] if p['pid']==0]):.2f}m"
        f"  pid1={np.median([p['depthM'] for f in out_frames for p in f['persons'] if p['pid']==1]):.2f}m\n"
        f"  depth separation (pid0-pid1) median={np.median(seps) if seps else float('nan'):.3f}m"
        f"  std={np.std(seps) if seps else float('nan'):.3f}m",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
