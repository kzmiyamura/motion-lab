#!/usr/bin/env python3
"""
種目を問わない汎用計測（preset: general）。
YOLOv8-pose で約 10fps に間引き、映っている人ごとの骨格の時系列と、動きの大きさの時系列を書く。
等間隔 + 動きのピークで最大 MAX_KEYFRAMES 枚のキーフレーム JPEG も書き出す。
サルサ専用の判定（リーダー・ターン・ペア）は一切入れない。何を見るかは指示書（spec.md）が決める。

Usage: python analyze_general.py <video_path> <model_path> <measurements_json_path> <keyframes_dir>

出力 measurements.json:
  {pipeline: "general", video: {fps, durationSec, width, height, sampleFps},
   summary: {personCount, persons: [{id, frames, firstT, lastT, meanSpeed, maxSpeed}],
             motion: {mean, max, peaks: [{t, v}]}, keyframes: [{t, file, reason}], events: []},
   motion: [{t, v}],                      # 全員の動きの大きさ（胴の長さ/秒、フレームごと）
   persons: [{id, track: [{t, bbox: [x0,y0,x1,y1], kps: [[x,y,conf]*17], speed}]}]}  # 座標は 0〜1 に正規化
`summary.events` は analyze_beats.py が読むので空配列で置く。
"""
import json
import math
import os
import sys

TARGET_FPS = 10.0       # 間引き後の実効 fps
BOX_CONF = 0.4          # 人物 bbox の最小信頼度
KP_CONF = 0.3           # 動きの計算に使う keypoint の最小信頼度
MAX_KEYFRAMES = 12
KEYFRAME_MIN_GAP = 0.8  # キーフレーム同士の最小間隔（秒）
PEAK_SHARE = 0.5        # キーフレームのうち動きのピークに割り当てる割合
TRACK_MAX_DIST = 0.25   # 追跡: 前のコマの中心からこの距離（正規化）以内なら同じ人
TRACK_MAX_GAP = 5       # 追跡: この数のコマ見えなくなったら別人扱い
MAX_LONG_EDGE = 960
SMOOTH = 3              # 動きの時系列の移動平均窓（コマ）
LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP = 5, 6, 11, 12


# ---- 純粋な関数（tests/test_analyze_general.py で検証） ----

def bbox_center(b):
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


def assign_tracks(tracks, dets, frame_no, next_id, max_dist=TRACK_MAX_DIST, max_gap=TRACK_MAX_GAP):
    """簡単な追跡: 検出（bbox 中心）を距離の近い順に、生きている軌跡へ貪欲に割り当てる。
    tracks: {id: {"center": (x, y), "last": frame_no}}（破壊的に更新）、dets: [{"bbox": [x0,y0,x1,y1]}]。
    戻り値 (ids, next_id): ids は dets と同じ並びの人物 ID。割り当てられない検出には新しい ID を振る"""
    alive = {i: t for i, t in tracks.items() if frame_no - t["last"] <= max_gap}
    pairs = []
    for di, d in enumerate(dets):
        cx, cy = bbox_center(d["bbox"])
        for tid, t in alive.items():
            dist = math.hypot(cx - t["center"][0], cy - t["center"][1])
            if dist <= max_dist:
                pairs.append((dist, di, tid))
    pairs.sort()
    ids = [None] * len(dets)
    used = set()
    for dist, di, tid in pairs:
        if ids[di] is not None or tid in used:
            continue
        ids[di] = tid
        used.add(tid)
    for di, d in enumerate(dets):
        if ids[di] is None:
            ids[di] = next_id
            next_id += 1
        tracks[ids[di]] = {"center": bbox_center(d["bbox"]), "last": frame_no}
    return ids, next_id


def torso_length(kps):
    """肩中点〜腰中点の距離（正規化座標）。取れなければ None"""
    pts = [kps[i] for i in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP)]
    if any(p[2] < KP_CONF for p in pts):
        return None
    sx = (pts[0][0] + pts[1][0]) / 2.0
    sy = (pts[0][1] + pts[1][1]) / 2.0
    hx = (pts[2][0] + pts[3][0]) / 2.0
    hy = (pts[2][1] + pts[3][1]) / 2.0
    d = math.hypot(sx - hx, sy - hy)
    return d if d > 1e-4 else None


def person_speed(prev, cur, dt, aspect=1.0):
    """2 コマ間の動きの大きさ = 信頼できる keypoint の平均移動量 / 胴の長さ / 秒。
    prev / cur は [[x, y, conf] * 17]（正規化）。aspect = 幅/高さ（x を縦の単位へ直す）。比べられなければ None"""
    if dt <= 0:
        return None
    torso = torso_length([[x * aspect, y, c] for x, y, c in cur]) or torso_length([[x * aspect, y, c] for x, y, c in prev])
    if torso is None:
        return None
    moves = []
    for (px, py, pc), (cx, cy, cc) in zip(prev, cur):
        if pc >= KP_CONF and cc >= KP_CONF:
            moves.append(math.hypot((cx - px) * aspect, cy - py))
    if len(moves) < 4:
        return None
    return sum(moves) / len(moves) / torso / dt


def smooth(values, window=SMOOTH):
    """中心移動平均（端は窓を縮める）"""
    n = len(values)
    if window <= 1 or n == 0:
        return list(values)
    half = window // 2
    out = []
    for i in range(n):
        seg = values[max(0, i - half): i + half + 1]
        out.append(sum(seg) / len(seg))
    return out


def pick_peaks(times, values, n, min_gap=KEYFRAME_MIN_GAP):
    """値の大きい局所最大から、時刻が min_gap 以上離れるものを大きい順に最大 n 個。時刻の昇順で返す"""
    if n <= 0 or len(values) == 0:
        return []
    cands = []
    for i, v in enumerate(values):
        left = values[i - 1] if i > 0 else -math.inf
        right = values[i + 1] if i + 1 < len(values) else -math.inf
        if v > 0 and v >= left and v >= right:
            cands.append((v, times[i]))
    cands.sort(key=lambda x: -x[0])
    chosen = []
    for v, t in cands:
        if all(abs(t - c[1]) >= min_gap for c in chosen):
            chosen.append((v, t))
        if len(chosen) >= n:
            break
    return sorted((t, v) for v, t in chosen)


def select_keyframe_times(duration, times, values, max_n=MAX_KEYFRAMES, peak_share=PEAK_SHARE, min_gap=KEYFRAME_MIN_GAP):
    """キーフレームの時刻を選ぶ: 動きのピーク（max_n × peak_share 個まで）+ 残りを等間隔。
    ピークと近すぎる等間隔の時刻は捨てて、空いた分は等間隔で埋める。[(t, "peak"|"even")] を時刻順に返す"""
    if duration <= 0 or max_n <= 0:
        return []
    peaks = pick_peaks(times, values, int(max_n * peak_share), min_gap)
    chosen = [(round(t, 2), "peak") for t, _ in peaks]

    def far_enough(t):
        return all(abs(t - c[0]) >= min_gap for c in chosen)

    want = max_n - len(chosen)
    # 等間隔は区間の中央を狙う（0 秒ちょうどと最終コマは避ける）。重なったら間隔の数を増やして探し直す
    for slots in range(want, want * 4 + 1):
        if slots <= 0:
            break
        cand = [(round(duration * (k + 0.5) / slots, 2), "even") for k in range(slots)]
        extra = [c for c in cand if far_enough(c[0])]
        # 等間隔同士も min_gap を守る
        keep = []
        for c in extra:
            if all(abs(c[0] - k[0]) >= min_gap for k in keep):
                keep.append(c)
        if len(keep) >= want or slots == want * 4:
            chosen += keep[:want] if len(keep) >= want else keep
            break
    chosen = [c for c in chosen if 0 <= c[0] <= duration]
    return sorted(chosen)


# ---- 計測本体 ----

def keypoint_rows(kps_xy, kps_conf, w, h):
    return [[round(float(kps_xy[k][0]) / w, 3), round(float(kps_xy[k][1]) / h, 3), round(float(kps_conf[k]), 2)]
            for k in range(len(kps_xy))]


def detect(model, frame):
    import numpy as np
    res = model(frame, verbose=False, conf=BOX_CONF)[0]
    if res.keypoints is None or res.boxes is None or len(res.boxes) == 0:
        return []
    h, w = frame.shape[:2]
    kps_xy = res.keypoints.xy.cpu().numpy()
    kps_conf = res.keypoints.conf
    kps_conf = kps_conf.cpu().numpy() if kps_conf is not None else np.zeros(kps_xy.shape[:2])
    boxes = res.boxes.xyxyn.cpu().numpy()
    out = []
    for i in range(len(boxes)):
        out.append({"bbox": [round(float(v), 3) for v in boxes[i]], "kps": keypoint_rows(kps_xy[i], kps_conf[i], w, h)})
    return out


def write_keyframes(video_path, out_dir, picks):
    import cv2
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from frame_time import grab_at
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    written = []
    for t, reason in picks:
        frame, _ = grab_at(cap, t)
        if frame is None:
            continue
        h, w = frame.shape[:2]
        if max(h, w) > MAX_LONG_EDGE:
            s = MAX_LONG_EDGE / max(h, w)
            frame = cv2.resize(frame, (int(w * s), int(h * s)))
        name = f"{t:08.1f}_{reason}.jpg".replace(" ", "0")
        cv2.imwrite(os.path.join(out_dir, name), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        written.append({"t": t, "file": name, "reason": reason})
    cap.release()
    return written


def main():
    if len(sys.argv) != 5:
        print("Usage: analyze_general.py <video_path> <model_path> <measurements_json_path> <keyframes_dir>", file=sys.stderr)
        sys.exit(1)
    video_path, model_path, out_path, kf_dir = sys.argv[1:5]

    import cv2
    from ultralytics import YOLO
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import frame_time

    model = YOLO(model_path)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    aspect = width / height if height else 1.0
    interval = max(1, round(fps / TARGET_FPS))
    clock = frame_time.FrameClock.from_video(video_path, fps)

    tracks, next_id = {}, 0
    series = {}      # id -> [{t, bbox, kps, speed}]
    motion_t, motion_raw = [], []
    idx = sampled = 0
    last_t = 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % interval != 0:
            idx += 1
            continue
        t = float(clock.time(idx))
        last_t = t
        dets = detect(model, frame)
        ids, next_id = assign_tracks(tracks, dets, sampled, next_id)
        speeds = []
        for d, pid in zip(dets, ids):
            s = series.setdefault(pid, [])
            speed = None
            if s and t - s[-1]["t"] <= (TRACK_MAX_GAP + 1) / TARGET_FPS:
                speed = person_speed(s[-1]["kps"], d["kps"], t - s[-1]["t"], aspect)
            s.append({"t": round(t, 2), "bbox": d["bbox"], "kps": d["kps"],
                      "speed": round(speed, 3) if speed is not None else None})
            if speed is not None:
                speeds.append(speed)
        motion_t.append(round(t, 2))
        motion_raw.append(sum(speeds) / len(speeds) if speeds else 0.0)
        sampled += 1
        idx += 1
    cap.release()

    duration = last_t
    motion_v = smooth(motion_raw)
    peaks = pick_peaks(motion_t, motion_v, MAX_KEYFRAMES)
    picks = select_keyframe_times(duration, motion_t, motion_v)
    keyframes = write_keyframes(video_path, kf_dir, picks)

    persons_summary = []
    for pid, s in sorted(series.items()):
        sp = [x["speed"] for x in s if x["speed"] is not None]
        persons_summary.append({
            "id": pid, "frames": len(s), "firstT": s[0]["t"], "lastT": s[-1]["t"],
            "meanSpeed": round(sum(sp) / len(sp), 3) if sp else None,
            "maxSpeed": round(max(sp), 3) if sp else None,
        })
    out = {
        "pipeline": "general",
        "video": {"fps": round(fps, 2), "durationSec": round(duration, 2), "width": width, "height": height,
                  "sampleFps": round(fps / interval, 2)},
        "summary": {
            "personCount": len(series),
            "persons": persons_summary,
            "motion": {
                "mean": round(sum(motion_v) / len(motion_v), 3) if motion_v else 0.0,
                "max": round(max(motion_v), 3) if motion_v else 0.0,
                "peaks": [{"t": round(t, 2), "v": round(v, 3)} for t, v in peaks],
            },
            "keyframes": keyframes,
            "events": [],
        },
        "motion": [{"t": t, "v": round(v, 3)} for t, v in zip(motion_t, motion_v)],
        "persons": [{"id": pid, "track": s} for pid, s in sorted(series.items())],
    }
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"general: {sampled} frames, {len(series)} persons, {len(keyframes)} keyframes", file=sys.stderr)


if __name__ == "__main__":
    main()
