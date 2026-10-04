#!/usr/bin/env python3
"""
保存済みジョブの技イベント（measurements.json の summary.events / holdTimeline）を、tracks.json（骨格の原盤）から
今の analyze_pair のロジックで作り直す。YOLO の 10fps 計測はやり直さない。

--video と --model を渡すと、ジョブと同じくターンの区間だけ全フレームで YOLO をかけ直して spin を取り直す
（analyze_pair.refine_turns_dense。ジョブの本計測と同じ events になる。ターン 1 件あたり数秒〜十数秒）。
渡さなければ 10fps の tracks だけで数え直す（数秒）。

書き換えるもの: measurements.json の summary.events・summary.holdTimeline（元の events は summary.eventsPrev に
1 回目だけ残す）と、tracks.json の events・holdTimeline。summary.eventsUpdate に作り直した印を付ける。
refine_events.py で取り直したもの（summary.eventRefine）は消える（取り直しは既定で無効）。

--retrack（--video が要る）: 人物 ID（pid）を今の assign_appearance_ids で付け直してから作り直す。tracks.json は外見の
ヒストグラムを持たないので、各コマを動画から読み直して付け直す（YOLO は回さない。動画を 1 回読むだけ）。
男の pid は元の tracks に合わせる。付け直す前の tracks.json は measurements.tracks.prev.json に 1 回目だけ残す。

Usage: python update_events.py <measurements.json> [--tracks=<tracks.json>] [--video=<path> [--model=<yolo.pt>] [--retrack]]
       [--out=<別の measurements.json に書く> [--tracks-out=<別の tracks.json に書く>]]
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_pair as ap  # noqa: E402


def retrack(tracks, video_path):
    """tracks.json の人物 ID（pid）を、今の assign_appearance_ids で付け直す（YOLO は回さない）。
    tracks.json は外見ヒストグラム（hist）を持たないので、各コマ（frameIdx）を動画から読み直して torso_hist を付け直す。
    男の pid は元の tracks の男（コマごとの一致が多い方）に合わせる（Claude のアンカーで決めた男女を保つ）。
    戻り値は (同じ pid のまま, 入れ替わった) のコマ×人の数"""
    import cv2
    want = {f["frameIdx"]: f for f in tracks["frames"] if "frameIdx" in f}
    if not want:
        return None
    cap = cv2.VideoCapture(video_path)
    idx, last = 0, max(want)
    while idx <= last:
        ok, frame = cap.read()
        if not ok:
            break
        f = want.get(idx)
        if f is not None:
            for p in f["kept"]:
                p["hist"] = ap.torso_hist(frame, p["bbox"])
        idx += 1
    cap.release()
    saved = [p.get("pid") for f in tracks["frames"] for p in f["kept"]]
    ap.assign_appearance_ids(tracks["frames"])
    new = [p.get("pid") for f in tracks["frames"] for p in f["kept"]]
    same = sum(1 for a, b in zip(saved, new) if a is not None and a == b)
    swapped = sum(1 for a, b in zip(saved, new) if a is not None and b is not None and a != b)
    old = tracks["leaderPid"]
    if old in (0, 1):
        tracks["leaderPid"] = old if same >= swapped else 1 - old
    for f in tracks["frames"]:
        for p in f["kept"]:
            p.pop("hist", None)
    return same, swapped


def main():
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    flags = {a[2:] for a in sys.argv[1:] if a.startswith("--") and "=" not in a}
    if len(pos) != 1:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    meas_path = pos[0]
    tracks_path = opts.get("tracks") or re.sub(r"\.json$", ".tracks.json", meas_path)
    out_path = opts.get("out") or meas_path
    t0 = time.time()
    with open(meas_path, encoding="utf-8") as f:
        meas = json.load(f)
    with open(tracks_path, encoding="utf-8") as f:
        tracks = json.load(f)
    retracked = None
    if "retrack" in flags and opts.get("video"):
        retracked = retrack(tracks, opts["video"])
        print(f"retracked pids: same {retracked[0]} swapped {retracked[1]}" if retracked else "retrack skipped (no frameIdx)",
              file=sys.stderr)
    frames, leader_pid = tracks["frames"], tracks["leaderPid"]
    events = ap.detect_events(frames, leader_pid) if frames else []
    dense = bool(opts.get("video") and opts.get("model"))
    if events and dense:
        from ultralytics import YOLO
        events = ap.refine_turns_dense(opts["video"], YOLO(opts["model"]), frames, events, leader_pid)
    holds = ap.build_hold_timeline(frames, leader_pid)

    summary = meas.setdefault("summary", {})
    summary.setdefault("eventsPrev", summary.get("events") or [])
    summary["events"] = events
    summary["holdTimeline"] = holds
    summary.pop("eventRefine", None)
    summary["eventsUpdate"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "dense": dense, "count": len(events),
                               "retracked": retracked is not None}
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meas, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    tracks_out = opts.get("tracks-out") or (tracks_path if out_path == meas_path else None)
    if tracks_out:
        if retracked is not None and tracks_out == tracks_path:
            prev = re.sub(r"\.json$", ".prev.json", tracks_path)
            if not os.path.exists(prev):
                os.replace(tracks_path, prev)   # 付け直す前の原盤を 1 回目だけ残す
        tracks["events"] = events
        tracks["holdTimeline"] = holds
        tmp = tracks_out + ".tmp"
        with open(tmp, "w") as f:
            json.dump(tracks, f)
        os.replace(tmp, tracks_out)
    kinds = {}
    for e in events:
        k = f"{e['type']}/{e.get('by')}"
        kinds[k] = kinds.get(k, 0) + 1
    print(f"events updated in {time.time() - t0:.1f}s (dense={dense}): {len(summary['eventsPrev'])} -> {len(events)} {kinds}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
