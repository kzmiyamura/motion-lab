#!/usr/bin/env python3
"""
tracks.json（解析済み骨格原盤）から、YOLO を回さずに技イベント検出・ホールドタイムライン・
骨格人形動画を再生成する。

analyze_pair.py の重い知覚（YOLO 検出 ≈ 動画長の3倍）は動画1本につき1回だけ実行し、
以降の技検出ルールの調整・新検出器の追加・骨格動画の再生成はこのスクリプトで数秒で回す。
過去の全動画への遡及適用（新しい技の検出器を追加したら原盤を一括再処理）もこれで行う。

Usage: python reprocess_tracks.py <tracks_json> <output_events_json> [skeleton_video_path]
"""
import sys
import json
import time
import analyze_pair as ap


def main():
    if len(sys.argv) not in (3, 4):
        print("Usage: reprocess_tracks.py <tracks_json> <output_events_json> [skeleton_video_path]", file=sys.stderr)
        sys.exit(1)
    tracks_path, out_path = sys.argv[1], sys.argv[2]
    skeleton_path = sys.argv[3] if len(sys.argv) == 4 else None

    t0 = time.time()
    with open(tracks_path) as f:
        tracks = json.load(f)
    draw_frames = tracks["frames"]
    leader_pid = tracks["leaderPid"]

    events = ap.detect_events(draw_frames, leader_pid)
    holds = ap.build_hold_timeline(draw_frames, leader_pid)

    with open(out_path, "w") as f:
        json.dump({"leaderPid": leader_pid, "events": events, "holdTimeline": holds}, f, ensure_ascii=False)

    if skeleton_path:
        ap.render_skeleton_video(skeleton_path, draw_frames, leader_pid, tracks["sampledFps"], events)

    print(f"reprocessed in {time.time() - t0:.2f}s: events={len(events)} holds={len(holds)}"
          f"{' + skeleton video' if skeleton_path else ''}", file=sys.stderr)


if __name__ == "__main__":
    main()
