#!/usr/bin/env python3
"""
技イベントごとに、連続フレームを時刻付きで並べた一覧画像（ストリップ）を書き出す。

入り・最中・出口の3枚（0.6秒間隔）では、ターン中の体の向きの変化が追えず、回転の向き・回転数・
手のつなぎを読み違えていた（9/23 の人手校正で実測）。0.1秒刻みで並べると、正面→横顔→背中の
変化を1枚ずつ追えるので、回る向きと回転数が読める。

OpenCV のみ（extract_keyframes.py と同じ環境で動く）。

Usage: python make_strips.py <video_path> <out_dir> <t>:<label>[:<from>:<to>] [...]
  各イベント時刻 t について [t-PRE_SEC, t+POST_SEC] を STEP_SEC 刻みで切り出す。
  from/to を指定すると、その範囲も含むように広げる（連続ターンが長いとき。最大 MAX_SPAN_SEC）。
出力ファイル名: <秒を0埋め6桁+小数1桁>_<label>_strip.jpg（例: 000038.6_turn_strip.jpg）
  21コマを超える区間は _strip_2.jpg, _strip_3.jpg … に続きを書く
"""
import math
import os
import sys

import cv2
import numpy as np

PRE_SEC = 0.4
POST_SEC = 1.6
STEP_SEC = 0.1
MAX_SPAN_SEC = 5.0
SHEET_MAX_TILES = 21
SHEET_MAX_W = 1800
LABEL_H = 34


def build_sheet(frames, times):
    """フレーム列を時刻ラベル付きのグリッドに並べる"""
    h, w = frames[0].shape[:2]
    portrait = h >= w
    cols = 7 if portrait else 5
    tile_w = SHEET_MAX_W // cols
    tile_h = int(round(h * tile_w / w))
    rows = math.ceil(len(frames) / cols)
    sheet = np.full((rows * tile_h, cols * tile_w, 3), 255, np.uint8)
    for i, (f, t) in enumerate(zip(frames, times)):
        tile = cv2.resize(f, (tile_w, tile_h))
        cv2.rectangle(tile, (0, 0), (int(tile_w * 0.42), LABEL_H), (0, 0, 0), -1)
        cv2.putText(tile, f"{t:.2f}", (6, LABEL_H - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 235, 255), 2, cv2.LINE_AA)
        r, c = divmod(i, cols)
        sheet[r * tile_h:(r + 1) * tile_h, c * tile_w:(c + 1) * tile_w] = tile
    return sheet


def read_window(cap, fps, t_from, t_to):
    """[t_from, t_to] を STEP_SEC 刻みで読む。先頭へ1回だけシークし、以降は順読みで最寄りフレームを拾う"""
    targets = []
    t = t_from
    while t <= t_to + 1e-6:
        targets.append(round(t, 2))
        t += STEP_SEC
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t_from - 0.05) * 1000)
    frames, times = [], []
    k = 0
    while k < len(targets):
        ret, frame = cap.read()
        if not ret:
            break
        cur = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        # このフレームが目標時刻を越えたら採用（半フレーム手前から許容）
        while k < len(targets) and cur >= targets[k] - 0.5 / fps:
            frames.append(frame)
            times.append(targets[k])
            k += 1
    return frames, times


def main():
    if len(sys.argv) < 4:
        print("Usage: make_strips.py <video_path> <out_dir> <t>:<label> [...]", file=sys.stderr)
        sys.exit(1)
    video_path, out_dir = sys.argv[1], sys.argv[2]
    specs = []
    for arg in sys.argv[3:]:
        parts = arg.split(":")
        t = float(parts[0])
        t_from, t_to = max(0.0, t - PRE_SEC), t + POST_SEC
        if len(parts) >= 4:
            t_from = max(0.0, min(t_from, float(parts[2])))
            t_to = min(max(t_to, float(parts[3])), t_from + MAX_SPAN_SEC)
        specs.append((t, parts[1], t_from, t_to))
    os.makedirs(out_dir, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    written = 0
    for t, label, t_from, t_to in sorted(specs):
        frames, times = read_window(cap, fps, t_from, t_to)
        if not frames:
            print(f"warn: no frames around t={t}", file=sys.stderr)
            continue
        # 長い区間は1枚に詰めるとコマが小さくて読めないので、SHEET_MAX_TILES コマずつ別の画像に分ける
        for part, i in enumerate(range(0, len(frames), SHEET_MAX_TILES), start=1):
            suffix = "" if part == 1 else f"_{part}"
            name = f"{t:08.1f}_{label}_strip{suffix}.jpg".replace(" ", "0")
            sheet = build_sheet(frames[i:i + SHEET_MAX_TILES], times[i:i + SHEET_MAX_TILES])
            cv2.imwrite(os.path.join(out_dir, name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
        written += 1

    cap.release()
    print(f"done: {written}/{len(specs)} strips", file=sys.stderr)


if __name__ == "__main__":
    main()
