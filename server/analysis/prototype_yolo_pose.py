#!/usr/bin/env python3
"""YOLO-pose 検出品質プロトタイプ: 同じサルサ動画で MediaPipe と比較する。

- 10fps 間引きで全フレーム処理
- 人物ごとの bbox + 17キーポイント（肩11,12 / 腰23,24 相当は COCO: 5,6=肩, 11,12=腰）
- 2人以上検出できたフレーム数をカウント
- デバッグ動画: bbox + 骨格 + SHR(2D) を描画
"""
import sys
import cv2
import numpy as np
from ultralytics import YOLO

TARGET_FPS = 10.0
CONF = 0.4

L_SH, R_SH, L_HIP, R_HIP = 5, 6, 11, 12  # COCO keypoints

def main():
    video_path, out_video = sys.argv[1], sys.argv[2]
    model = YOLO("yolov8s-pose.pt")  # small: nano より精度優先（CPUでも十分速い）

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    interval = max(1, round(fps / TARGET_FPS))
    eff_fps = fps / interval

    writer = None
    idx = 0
    sampled = 0
    frames_2p = 0
    frames_1p = 0
    frames_0p = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % interval != 0:
            idx += 1
            continue

        res = model(frame, verbose=False, conf=CONF)[0]
        persons = []
        if res.keypoints is not None and res.boxes is not None:
            for box, kps, conf in zip(res.boxes.xyxy.numpy(), res.keypoints.xy.numpy(), res.boxes.conf.numpy()):
                persons.append({"box": box, "kps": kps, "conf": float(conf)})
        # 面積上位2人
        persons.sort(key=lambda p: (p["box"][2]-p["box"][0])*(p["box"][3]-p["box"][1]), reverse=True)
        kept = persons[:2]
        rejected = persons[2:]

        n = len(kept)
        if n >= 2: frames_2p += 1
        elif n == 1: frames_1p += 1
        else: frames_0p += 1

        vis = frame.copy()
        for p, color in [(p, (0, 220, 0)) for p in kept] + [(p, (0, 0, 255)) for p in rejected]:
            b = p["box"].astype(int)
            cv2.rectangle(vis, (b[0], b[1]), (b[2], b[3]), color, 2)
            k = p["kps"]
            # SHR(2D): 肩幅/腰幅
            sw = np.linalg.norm(k[L_SH] - k[R_SH])
            hw = np.linalg.norm(k[L_HIP] - k[R_HIP])
            shr = sw / hw if hw > 1 else 0
            cv2.putText(vis, f"SHR2D {shr:.2f} c{p['conf']:.2f}", (b[0], max(14, b[1]-6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)
            for pt in k:
                if pt[0] > 0 or pt[1] > 0:
                    cv2.circle(vis, (int(pt[0]), int(pt[1])), 3, color, -1)

        if writer is None:
            h, w = frame.shape[:2]
            writer = cv2.VideoWriter(out_video, cv2.VideoWriter_fourcc(*"mp4v"), max(1.0, eff_fps), (w, h))
        writer.write(vis)
        sampled += 1
        idx += 1

    cap.release()
    if writer:
        writer.release()
    print(f"sampled={sampled}  2人検出={frames_2p} ({100*frames_2p//max(1,sampled)}%)  1人={frames_1p}  0人={frames_0p}")

if __name__ == "__main__":
    main()
