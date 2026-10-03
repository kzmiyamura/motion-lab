#!/usr/bin/env python3
"""
振付シート用に、result.json の routine.moves の技1つにつき1枚、2人の周りを切り取った連続コマ画像を作る。

アプリの「振付シート」は 1行 = 1技 で、文章の代わりにこの画像を見せる。
技の区間は [start, 次の技の start]（routine は頭から隙間なく並ぶ前提）。次の技が無い・start が
前後しているときは counts × 拍間隔（routine.bpm → measurements の beatGrid → 既定値の順）で決める。
切り取り範囲と描画は make_report_frames.py（pair_box / build_sheet）をそのまま使う。

書き出し:
  <out_dir>/<NN>_<start>.jpg   NN = 技の番号（1始まり）
  <out_dir>/index.json         {"version": 1, "moves": [{"index", "start", "end", "url"}]}
                               index は routine.moves の 0 始まりの位置。画像が作れなかった技は載せない
何度実行しても同じ結果になる（out_dir 内の古い jpg は消してから書く）。

Usage: python make_move_frames.py <video_path> <tracks.json> <result.json> <measurements.json> <out_dir> <url_prefix>
  url_prefix: index.json に書く画像URLの前置き（例: /analysis-output/<jobId>/out/move_frames）
"""
import glob
import json
import os
import sys

import cv2

from make_report_frames import build_sheet, pair_box

DEFAULT_BEAT_SEC = 60 / 170   # サルサの標準的なテンポ（routineClip.ts の BASE_BPM と同じ）
MIN_SPAN_SEC = 1.0
MAX_SPAN_SEC = 12.0


def beat_interval(routine, summary):
    """1拍の秒数。routine.bpm → beatGrid.beatIntervalSec → beatGrid.bpm → 既定値"""
    bpm = (routine or {}).get("bpm")
    if isinstance(bpm, (int, float)) and 40 <= bpm <= 260:
        return 60.0 / bpm
    grid = (summary or {}).get("beatGrid") or {}
    sec = grid.get("beatIntervalSec")
    if isinstance(sec, (int, float)) and 0.15 <= sec <= 1.5:
        return float(sec)
    gbpm = grid.get("bpm")
    if isinstance(gbpm, (int, float)) and 40 <= gbpm <= 260:
        return 60.0 / gbpm
    return DEFAULT_BEAT_SEC


def move_windows(moves, beat_sec, duration=None):
    """各技の (開始秒, 終了秒)。start が無い・動画の外の技は None"""
    out = []
    for k, mv in enumerate(moves):
        t0 = mv.get("start")
        if not isinstance(t0, (int, float)) or t0 < 0 or (duration is not None and t0 >= duration):
            out.append(None)
            continue
        counts = mv.get("counts")
        if not isinstance(counts, (int, float)) or counts <= 0:
            counts = 8
        nxt = None
        for later in moves[k + 1:]:
            s = later.get("start")
            if isinstance(s, (int, float)) and s > t0 and (duration is None or s < duration):
                nxt = s
                break
        t1 = nxt if nxt is not None else t0 + counts * beat_sec
        t1 = min(max(t1, t0 + MIN_SPAN_SEC), t0 + MAX_SPAN_SEC)
        if duration is not None:
            t1 = min(t1, duration)
        out.append((float(t0), float(t1)))
    return out


def frame_times(t0, t1, counts):
    """技の区間から取るコマの時刻。8カウントまでは5コマ、それより長い技は6コマ。
    最後のコマは次の技の頭と重ならないよう少し手前にする"""
    n = 5 if (counts or 8) <= 8 else 6
    end = max(t0, t1 - 0.05)
    return [t0 + (end - t0) * k / (n - 1) for k in range(n)]


def main():
    if len(sys.argv) < 7:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    video_path, tracks_path, result_path, meas_path, out_dir, url_prefix = sys.argv[1:7]

    with open(result_path, encoding="utf-8") as f:
        routine = (json.load(f) or {}).get("routine") or {}
    moves = routine.get("moves") or []
    if not moves:
        print("no routine.moves; nothing to do", file=sys.stderr)
        return

    summary = {}
    if os.path.exists(meas_path):
        with open(meas_path, encoding="utf-8") as f:
            summary = (json.load(f) or {}).get("summary") or {}
    frames = []
    if os.path.exists(tracks_path):
        with open(tracks_path, encoding="utf-8") as f:
            frames = json.load(f).get("frames", [])

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    duration = (cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / fps or None

    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, "*.jpg")):
        os.remove(old)

    entries = []
    windows = move_windows(moves, beat_interval(routine, summary), duration)
    for i, (mv, win) in enumerate(zip(moves, windows)):
        if win is None:
            continue
        t0, t1 = win
        sheet = build_sheet(cap, pair_box(frames, t0, t1), frame_times(t0, t1, mv.get("counts")))
        if sheet is None:
            continue
        name = f"{i + 1:02d}_{t0:05.1f}.jpg"
        cv2.imwrite(os.path.join(out_dir, name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 78])
        entries.append({
            "index": i, "start": round(t0, 2), "end": round(t1, 2),
            "url": f"{url_prefix.rstrip('/')}/{name}",
        })
    cap.release()

    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "moves": entries}, f, ensure_ascii=False, indent=1)
    print(f"done: {len(entries)}/{len(moves)} moves", file=sys.stderr)


if __name__ == "__main__":
    main()
