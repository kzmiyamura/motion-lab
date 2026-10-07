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

--retime（--video が要る）: コマの時刻を動画のタイムスタンプ（PTS）に付け直してから作り直す（README 26。YOLO は回さない）。
--retrack（--video が要る）: 人物 ID（pid）を今の assign_appearance_ids で付け直してから作り直す。tracks.json は外見の
ヒストグラムを持たないので、各コマを動画から読み直して付け直す（YOLO は回さない。動画を 1 回読むだけ）。
男の pid は元の tracks に合わせる。付け直す前の tracks.json は measurements.tracks.prev.json に 1 回目だけ残す。

Usage: python update_events.py <measurements.json> [--tracks=<tracks.json>] [--video=<path> [--model=<yolo.pt>] [--retime] [--retrack]]
       [--out=<別の measurements.json に書く> [--tracks-out=<別の tracks.json に書く>]]
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_pair as ap  # noqa: E402


RETRACK_LEADER_SEC = 8.0   # 男の pid を元の tracks に合わせるとき、一致を数える冒頭の秒数（anchor_refs と同じ長さ）


def match_leader(frames, saved, old_leader):
    """付け直した pid（frames の kept[].pid）のうち、元の tracks（saved: コマごと・人ごとの元の pid）の男はどちらか。
    冒頭 RETRACK_LEADER_SEC 秒（2 人がそろった最初のコマから）で元の pid と一致が多いか入れ替わりが多いかを見る。
    戻り値は (全編で同じ pid, 全編で入れ替わった, 付け直し後の男の pid)"""
    same = swapped = early_same = early_swapped = 0
    t_first = next((f["t"] for f, s in zip(frames, saved) if sum(x is not None for x in s) == 2), None)
    for f, s in zip(frames, saved):
        early = t_first is not None and f["t"] <= t_first + RETRACK_LEADER_SEC
        for p, a in zip(f["kept"], s):
            b = p.get("pid")
            if a is None or b is None:
                continue
            same += a == b
            swapped += a != b
            if early:
                early_same += a == b
                early_swapped += a != b
    leader = old_leader
    if old_leader in (0, 1):
        leader = old_leader if early_same >= early_swapped else 1 - old_leader
    return same, swapped, leader


def retrack(tracks, video_path):
    """tracks.json の人物 ID（pid）を、今の assign_appearance_ids で付け直す（YOLO は回さない）。
    tracks.json は外見ヒストグラム（hist）を持たないので、各コマ（frameIdx）を動画から読み直して torso_hist を付け直す。
    男の pid は元の tracks の男に合わせる（Claude のアンカーで決めた男女を保つ）。合わせるのは冒頭 RETRACK_LEADER_SEC 秒の
    一致が多い方で、全編の多数決にはしない（古い追跡が途中で入れ替わったまま戻らなかった動画では、全編の多数決は
    入れ替わった後の人を男にしてしまう。1230b3d5 は 16 秒で入れ替わり、全編の一致は 10%、男の pid が全編逆になっていた）。
    戻り値は (同じ pid のまま, 入れ替わった) のコマ×人の数（全編）"""
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
            asp = frame.shape[1] / frame.shape[0]
            for p in f["kept"]:
                p["hist"] = ap.torso_hist(frame, p["bbox"])
                try:
                    # resolve_identity_joint が使う部位ごとの色。本計測と同じ入力にそろえる
                    p["app"] = ap.appearance_regions(frame, p, asp) if ap.IDENTITY_JOINT else None
                except (KeyError, IndexError, TypeError, ValueError):
                    p["app"] = None
        idx += 1
    cap.release()
    saved = [[p.get("pid") for p in f["kept"]] for f in tracks["frames"]]
    ap.assign_appearance_ids(tracks["frames"])
    same, swapped, tracks["leaderPid"] = match_leader(tracks["frames"], saved, tracks["leaderPid"])
    for f in tracks["frames"]:
        for p in f["kept"]:
            p.pop("hist", None)
            p.pop("app", None)
    return same, swapped


def retime(tracks, video_path):
    """tracks.json のコマの時刻 t を、今の analyze_pair と同じ動画のタイムスタンプ（frame_time_map、PTS をならしたもの）に
    付け直す。以前の解析は「コマ番号 / fps」で、可変フレームレートの動画では再生の時刻と最大 1 秒ずれていた（README 26）。
    戻り値は (付け直したコマ数, いちばん大きく動いた秒数)。PTS が取れなければ None"""
    tmap = ap.frame_time_map(video_path, tracks.get("fps") or 30.0)
    if not tmap:
        return None
    n, shift = 0, 0.0
    for f in tracks["frames"]:
        i = f.get("frameIdx")
        if isinstance(i, int) and 0 <= i < len(tmap):
            shift = max(shift, abs(tmap[i] - f["t"]))
            f["t"] = tmap[i]
            n += 1
    tracks["frameTime"] = "pts"
    return n, shift


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
    retimed = None
    if "retime" in flags and opts.get("video"):
        retimed = retime(tracks, opts["video"])
        print(f"retimed frames: {retimed[0]} (max shift {retimed[1]:.2f}s)" if retimed else "retime skipped (no PTS / frameIdx)",
              file=sys.stderr)
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
    events = ap.apply_cbl_pass_half(events)
    holds = ap.build_hold_timeline(frames, leader_pid)

    summary = meas.setdefault("summary", {})
    summary.setdefault("eventsPrev", summary.get("events") or [])
    summary["events"] = events
    summary["holdTimeline"] = holds
    summary["holdUnclear"] = ap.build_hold_unclear(frames, leader_pid)
    summary.pop("eventRefine", None)
    summary["eventsUpdate"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "dense": dense, "count": len(events),
                               "retracked": retracked is not None, "retimed": retimed is not None}
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meas, f)  # ASCII のまま（analyze_beats.py などは既定のエンコーディングで読む）
    os.replace(tmp, out_path)
    tracks_out = opts.get("tracks-out") or (tracks_path if out_path == meas_path else None)
    if tracks_out:
        if (retracked is not None or retimed is not None) and tracks_out == tracks_path:
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
