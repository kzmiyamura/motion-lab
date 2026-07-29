#!/usr/bin/env python3
"""
動画から MediaPipe Pose Landmarker (Heavy) で肩ラインの回転角度の
時系列を算出する。

肩ラインの向き（右肩から見た左肩の3D方向）を atan2(dz, dx) で角度化し、
フレーム間の差分を unwrap しながら積算することで、体の回転を
「一周で360度増減する連続値」として記録する。これにより後段（Node.js側）
で任意のA-B区間を切り出すだけで平均角速度・RPMを計算できる。

10fps 相当に間引いて処理する（CPU実機での所要時間を抑える。回転角の時系列は
10fps でも1回転あたり十数サンプル取れるため RPM 計測には十分。
ThinkCentre実機検証: フルfps処理は31.5秒動画に2分20秒＝実時間4.4倍かかっていた）。

出力: JSON { fps, totalFrames, detectedFrames, samples: [{t, angleDeg}, ...] }

Usage: python analyze_rotation.py <video_path> <model_path> <output_json_path>
"""
import sys
import json
import math
import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12

TARGET_FPS = 10.0  # 間引き後の実効fps


def main():
    if len(sys.argv) != 4:
        print("Usage: analyze_rotation.py <video_path> <model_path> <output_json_path>", file=sys.stderr)
        sys.exit(1)

    video_path, model_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

    options = PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=RunningMode.VIDEO,
        num_poses=1,
    )

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = max(1, round(fps / TARGET_FPS))
    frame_idx = 0
    samples = []
    prev_angle = None
    cumulative = 0.0
    detected_frames = 0

    with PoseLandmarker.create_from_options(options) as landmarker:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % frame_interval != 0:
                frame_idx += 1
                continue
            t_sec = frame_idx / fps
            t_ms = int(t_sec * 1000)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            result = landmarker.detect_for_video(mp_image, t_ms)

            if result.pose_landmarks:
                detected_frames += 1
                lm = result.pose_landmarks[0]
                l_sh, r_sh = lm[LEFT_SHOULDER], lm[RIGHT_SHOULDER]
                angle = math.degrees(math.atan2(r_sh.z - l_sh.z, r_sh.x - l_sh.x))
                if prev_angle is not None:
                    diff = angle - prev_angle
                    if diff > 180:
                        diff -= 360
                    elif diff < -180:
                        diff += 360
                    cumulative += diff
                prev_angle = angle
                samples.append({"t": round(t_sec, 4), "angleDeg": round(cumulative, 3)})

            frame_idx += 1

    cap.release()

    with open(output_path, "w") as f:
        json.dump({
            "fps": fps,
            "totalFrames": frame_idx,
            "detectedFrames": detected_frames,
            "samples": samples,
        }, f)

    print(f"done: {frame_idx} frames, {detected_frames} detected, fps={fps}", file=sys.stderr)


if __name__ == "__main__":
    main()
