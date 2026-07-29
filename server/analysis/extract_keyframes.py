#!/usr/bin/env python3
"""
動画の指定時刻のフレームを JPEG として書き出す（contested 区間のキーフレーム用）。
長辺 960px にリサイズし、Claude に渡す画像トークンを節約する。

OpenCV のみで完結させる（ffmpeg サブプロセスより依存が単純で、
analyze_pair.py と同じ環境で必ず動く）。

Usage: python extract_keyframes.py <video_path> <out_dir> <t1> [<t2> ...]
出力ファイル名: <秒を0埋め6桁+小数1桁>_contested.jpg（例: 000034.2_contested.jpg）
"""
import os
import sys
import cv2

MAX_LONG_EDGE = 960


def main():
    if len(sys.argv) < 4:
        print("Usage: extract_keyframes.py <video_path> <out_dir> <t1> [<t2> ...]", file=sys.stderr)
        sys.exit(1)

    video_path = sys.argv[1]
    out_dir = sys.argv[2]
    times = [float(t) for t in sys.argv[3:]]

    os.makedirs(out_dir, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    written = 0
    for t in sorted(times):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            print(f"warn: no frame at t={t}", file=sys.stderr)
            continue
        h, w = frame.shape[:2]
        long_edge = max(h, w)
        if long_edge > MAX_LONG_EDGE:
            scale = MAX_LONG_EDGE / long_edge
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
        name = f"{t:08.1f}_contested.jpg".replace(" ", "0")
        cv2.imwrite(os.path.join(out_dir, name), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        written += 1

    cap.release()
    print(f"done: {written}/{len(times)} keyframes", file=sys.stderr)


if __name__ == "__main__":
    main()
