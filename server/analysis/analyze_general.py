#!/usr/bin/env python3
"""
種目を問わない汎用計測（preset: general）。
YOLOv8-pose で約 10fps に間引き、映っている人ごとの骨格の時系列と、動きの大きさの時系列を書く。
動きの山を優先 + 山の無い区間を等間隔で埋めて、動画の長さに応じた枚数（30 秒で約 18 枚、上限 MAX_KEYFRAMES）のキーフレーム JPEG も書き出す。
人物の追跡は、見失った人を 2 秒覚えて位置・大きさ・服の色・骨格の形で付け直す。主な人物は summary.mainPersons に分ける。
サルサ専用の判定（リーダー・ターン・ペア）は一切入れない。何を見るかは指示書（spec.md）が決める。

Usage: python analyze_general.py <video_path> <model_path> <measurements_json_path> <keyframes_dir>

出力 measurements.json:
  {pipeline: "general", video: {fps, durationSec, width, height, sampleFps},
   summary: {personCount, persons: [{id, frames, firstT, lastT, meanSpeed, maxSpeed}],
             mainPersons: [{id, coverage, meanHeight, firstT, lastT, gaps: [{from, to}]}], minorPersonIds: [id],
             motion: {mean, max, peaks: [{t, v}], mountains: [{from, to, peakT}]},
             keyframes: [{t, file, reason}], events: []},
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
MAX_KEYFRAMES = 24      # 上限（実際の枚数は動画の長さで決まる: keyframe_budget）
MIN_KEYFRAMES = 8
KEYFRAMES_PER_SEC = 0.6  # 30 秒で 18 枚
KEYFRAME_MIN_GAP = 0.8  # キーフレーム同士の最小間隔（秒）
PEAK_MIN_GAP = 1.2      # 動きの山同士の最小間隔（秒）。近い山は 1 つにまとめる
PEAK_SHARE = 0.65       # キーフレームのうち動きのピークに割り当てる割合
MOUNTAIN_K = 0.5        # 「山」= 動きが 平均 + MOUNTAIN_K × 標準偏差 を超えている連続区間
TRACK_MAX_DIST = 0.25   # 追跡: 前のコマの中心からこの距離（正規化）以内なら同じ人
TRACK_MAX_GAP = 20      # 追跡: この数のコマ（2 秒）見えなくなるまでは覚えていて付け直す
TRACK_GAP_DRIFT = 0.012  # 見失っている間、探す半径を 1 コマあたりこれだけ広げる
TRACK_MAX_RADIUS = 0.45
SIZE_RATIO_MAX = 1.9    # 付け直し: 高さの比がこれを超える相手は別人
HIST_MAX = 0.9          # 付け直し: 服の色ヒストグラムの L1 距離（0〜2）がこれを超える相手は別人
HIST_EMA = 0.05         # 色ヒストグラムの更新の重み（遅く: 隠れている間に相手の色が混ざらないように）
W_HIST, W_SIZE, W_SHAPE = 6.0, 0.5, 6.0
STITCH_MAX_GAP = 60     # 2 パス目: 断片同士をつなぐのは、この数のコマ（6 秒）以内の途切れまで
STITCH_RADIUS = 0.3
STITCH_SIZE_RATIO = 1.6
STITCH_HIST_MAX = 0.8   # 断片の平均色同士の L1 距離の上限
SPEED_MAX_GAP = 5       # 動きの大きさを出すのは、この数のコマ以内に見えていた人だけ
MAIN_MIN_COVERAGE = 0.25  # 主な人物: 動画の長さに対する映っていた割合の下限
MAIN_MIN_SIZE = 0.55      # 主な人物: 一番大きい人（候補の中）の高さに対する割合の下限
MAIN_MAX = 4
MAX_LONG_EDGE = 960
SMOOTH = 3              # 動きの時系列の移動平均窓（コマ）
LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP = 5, 6, 11, 12


# ---- 純粋な関数（tests/test_analyze_general.py で検証） ----

def bbox_center(b):
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


def hist_l1(a, b):
    """色ヒストグラム同士の L1 距離（0〜2）。どちらか無ければ None"""
    if a is None or b is None:
        return None
    return float(sum(abs(x - y) for x, y in zip(a, b)))


def body_shape(kps, bbox):
    """骨格の形の記述子（向き・距離に比較的不変な比）: (肩幅 / bbox 高さ, 胴の長さ / bbox 高さ)。取れなければ None"""
    bh = bbox[3] - bbox[1]
    if bh <= 1e-4:
        return None
    pts = [kps[i] for i in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP)]
    if any(p[2] < KP_CONF for p in pts):
        return None
    sw = math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])
    torso = math.hypot((pts[0][0] + pts[1][0]) / 2 - (pts[2][0] + pts[3][0]) / 2,
                       (pts[0][1] + pts[1][1]) / 2 - (pts[2][1] + pts[3][1]) / 2)
    return (sw / bh, torso / bh)


def match_cost(t, d, gap, max_dist=TRACK_MAX_DIST):
    """生きている軌跡 t と検出 d の付け替えコスト（小さいほど同じ人らしい）。付けられない相手は None。
    位置: 見失った時間ぶん探す半径を広げる。大きさ: 高さの比。色: 服の色ヒストグラム。形: 肩幅・胴の長さの比。
    長く見失った（gap が大きい）相手は、色が取れていて遠いなら別人とする"""
    cx, cy = bbox_center(d["bbox"])
    dist = math.hypot(cx - t["center"][0], cy - t["center"][1])
    radius = min(TRACK_MAX_RADIUS, max_dist + TRACK_GAP_DRIFT * max(0, gap))
    if dist > radius:
        return None
    dh = max(1e-3, d["bbox"][3] - d["bbox"][1])
    th = max(1e-3, t.get("h") or dh)
    ratio = max(dh / th, th / dh)
    if ratio > SIZE_RATIO_MAX:
        return None
    cost = dist / radius + W_SIZE * math.log(ratio)
    hd = hist_l1(t.get("hist"), d.get("hist"))
    if hd is not None:
        if hd > HIST_MAX:
            return None
        cost += W_HIST * hd
    sa, sb = t.get("shape"), d.get("shape")
    if sa and sb:
        cost += W_SHAPE * (abs(sa[0] - sb[0]) / max(sa[0], sb[0]) + abs(sa[1] - sb[1]) / max(sa[1], sb[1]))
    return cost


def assign_tracks(tracks, dets, frame_no, next_id, max_dist=TRACK_MAX_DIST, max_gap=TRACK_MAX_GAP):
    """追跡: 検出を、生きている軌跡（見失って max_gap コマ以内）へコストの小さい順に貪欲に割り当てる。
    見失った人は max_gap コマ（既定 2 秒）覚えておき、位置・大きさ・服の色・骨格の形が合えば同じ id を付け直す。
    tracks: {id: {"center", "last", "h", "hist", "shape"}}（破壊的に更新）、
    dets: [{"bbox": [x0,y0,x1,y1], "hist": 色ヒストグラム（任意）, "kps": （任意）}]。
    戻り値 (ids, next_id): ids は dets と同じ並びの人物 ID。割り当てられない検出には新しい ID を振る"""
    alive = {i: t for i, t in tracks.items() if frame_no - t["last"] <= max_gap}
    pairs = []
    for di, d in enumerate(dets):
        if "shape" not in d:
            d["shape"] = body_shape(d["kps"], d["bbox"]) if d.get("kps") else None
        for tid, t in alive.items():
            c = match_cost(t, d, frame_no - t["last"], max_dist)
            if c is not None:
                pairs.append((c, di, tid))
    pairs.sort()
    ids = [None] * len(dets)
    used = set()
    for c, di, tid in pairs:
        if ids[di] is not None or tid in used:
            continue
        ids[di] = tid
        used.add(tid)
    for di, d in enumerate(dets):
        if ids[di] is None:
            ids[di] = next_id
            next_id += 1
        old = tracks.get(ids[di])
        hist = d.get("hist")
        if old is not None and old.get("hist") is not None and hist is not None:
            hist = [(1 - HIST_EMA) * a + HIST_EMA * b for a, b in zip(old["hist"], hist)]
        elif hist is None and old is not None:
            hist = old.get("hist")
        shape = d.get("shape") or (old.get("shape") if old else None)
        tracks[ids[di]] = {"center": bbox_center(d["bbox"]), "last": frame_no,
                           "h": d["bbox"][3] - d["bbox"][1], "hist": hist, "shape": shape}
    return ids, next_id


def tracklet_summary(rows):
    """追跡の断片（rows: [{f: コマ番号, center, h, hist, shape}]）の特徴: 時間範囲・両端の位置と大きさ・平均の色と形"""
    rows = sorted(rows, key=lambda r: r["f"])

    def mean_vec(vs):
        vs = [v for v in vs if v is not None]
        return [sum(c) / len(vs) for c in zip(*vs)] if vs else None

    return {"frames": {r["f"] for r in rows}, "first": rows[0]["f"], "last": rows[-1]["f"],
            "c0": rows[0]["center"], "c1": rows[-1]["center"],
            "h": sum(r["h"] for r in rows) / len(rows), "hist": mean_vec([r["hist"] for r in rows]),
            "shape": mean_vec([r["shape"] for r in rows]), "n": len(rows)}


def stitch_cost(a, b, max_gap=STITCH_MAX_GAP):
    """断片 a の後に断片 b が同じ人として続くコスト。同時に映っている（コマが重なる）・離れすぎ・色や大きさが違うは None"""
    if a["first"] > b["first"]:
        a, b = b, a
    if a["frames"] & b["frames"] or b["first"] <= a["last"]:
        return None
    gap = b["first"] - a["last"]
    if gap > max_gap:
        return None
    radius = min(0.7, STITCH_RADIUS + 0.02 * gap)
    dist = math.hypot(a["c1"][0] - b["c0"][0], a["c1"][1] - b["c0"][1])
    if dist > radius:
        return None
    ratio = max(a["h"] / b["h"], b["h"] / a["h"])
    if ratio > STITCH_SIZE_RATIO:
        return None
    cost = 0.5 * dist / radius + W_SIZE * math.log(ratio)
    hd = hist_l1(a["hist"], b["hist"])
    if hd is not None:
        if hd > STITCH_HIST_MAX:
            return None
        cost += W_HIST * hd
    if a["shape"] and b["shape"]:
        cost += W_SHAPE * sum(abs(x - y) / max(x, y, 1e-6) for x, y in zip(a["shape"], b["shape"]))
    return cost


def stitch_tracklets(feats, max_gap=STITCH_MAX_GAP):
    """追跡の断片をつなぎ直す（オンライン追跡のあとの 2 パス目）。
    feats: {id: [{f, center, h, hist, shape}]}。同じ人らしい断片（位置・大きさ・平均の服の色・骨格の形が合い、
    同時に映っていない）をコストの小さい順に貪欲に併合する。戻り値 {旧 id: 新 id}（新 id は併合した中で最小の旧 id）"""
    groups = {i: {"ids": [i], "s": tracklet_summary(rows)} for i, rows in feats.items() if rows}
    while True:
        best = None
        keys = sorted(groups)
        for x, i in enumerate(keys):
            for j in keys[x + 1:]:
                c = stitch_cost(groups[i]["s"], groups[j]["s"], max_gap)
                if c is not None and (best is None or c < best[0]):
                    best = (c, i, j)
        if best is None:
            break
        _, i, j = best
        rows = feats_rows(feats, groups[i]["ids"] + groups[j]["ids"])
        groups[i] = {"ids": groups[i]["ids"] + groups[j]["ids"], "s": tracklet_summary(rows)}
        del groups[j]
    return {old: g_id for g_id, g in groups.items() for old in g["ids"]}


def feats_rows(feats, ids):
    return [r for i in ids for r in feats[i]]


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


def pick_peaks(times, values, n, min_gap=PEAK_MIN_GAP, min_rel=0.0):
    """値の大きい局所最大から、時刻が min_gap 以上離れるものを大きい順に最大 n 個（近い山は大きい方に 1 つにまとまる）。
    min_rel > 0 なら、最大値の min_rel 倍に満たない小さな揺れは山と見なさない。時刻の昇順で返す"""
    if n <= 0 or len(values) == 0:
        return []
    floor = max(values) * min_rel
    cands = []
    for i, v in enumerate(values):
        left = values[i - 1] if i > 0 else -math.inf
        right = values[i + 1] if i + 1 < len(values) else -math.inf
        if v > 0 and v >= floor and v >= left and v >= right:
            cands.append((v, times[i]))
    cands.sort(key=lambda x: -x[0])
    chosen = []
    for v, t in cands:
        if all(abs(t - c[1]) >= min_gap for c in chosen):
            chosen.append((v, t))
        if len(chosen) >= n:
            break
    return sorted((t, v) for v, t in chosen)


def keyframe_budget(duration, per_sec=KEYFRAMES_PER_SEC, lo=MIN_KEYFRAMES, hi=MAX_KEYFRAMES, min_gap=KEYFRAME_MIN_GAP):
    """キーフレームの枚数: 動画の長さに比例（30 秒で 18 枚）、下限 lo・上限 hi、min_gap を守れる数まで"""
    if duration <= 0:
        return 0
    return max(1, min(hi, max(lo, round(duration * per_sec)), int(duration / min_gap) + 1))


def mountains(times, values, k=MOUNTAIN_K):
    """動きの「山」= 平均 + k × 標準偏差を超えている連続区間。[(from, to, peakT, peakV)] を時刻順に返す"""
    n = len(values)
    if n == 0:
        return []
    mean = sum(values) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / n)
    thr = mean + k * sd
    if max(values) <= 0 or thr <= 0:
        return []
    out, i = [], 0
    while i < n:
        if values[i] > thr:
            j = i
            while j + 1 < n and values[j + 1] > thr:
                j += 1
            m = max(range(i, j + 1), key=lambda x: values[x])
            out.append((times[i], times[j], times[m], values[m]))
            i = j + 1
        else:
            i += 1
    return out


def select_keyframe_times(duration, times, values, max_n=None, peak_share=PEAK_SHARE,
                          min_gap=KEYFRAME_MIN_GAP, peak_gap=PEAK_MIN_GAP):
    """キーフレームの時刻を選ぶ。枚数 max_n は既定で動画の長さに比例（keyframe_budget）。
    1. 動きの山を優先: 局所最大を大きい順に peak_gap 以上離して max_n × peak_share 個まで（近い山は 1 つにまとめる）。
       その後、山（平均 + k·σ を超える連続区間）のうち静止画が 1 枚も無いものには、その山の頂上を必ず足す
    2. 残りの枚数は等間隔（山の無い区間の一番空いているところの真ん中）で埋める
    [(t, "peak"|"even")] を時刻順に返す"""
    if duration <= 0:
        return []
    if max_n is None:
        max_n = keyframe_budget(duration, min_gap=min_gap)
    if max_n <= 0:
        return []
    peaks = pick_peaks(times, values, int(max_n * peak_share), peak_gap, min_rel=0.25)
    chosen = [round(t, 2) for t, _ in peaks]
    # 山ごとに 1 枚を保証（枚数の上限は max_n × 0.85 まで）
    for lo, hi, pt, _ in sorted(mountains(times, values), key=lambda m: -m[3]):
        if len(chosen) >= int(max_n * 0.85):
            break
        # 山の中、または頂上から peak_gap 以内に撮った 1 枚があれば、その山は写っている（近い山はまとめる）
        if any(lo <= c <= hi or abs(pt - c) < peak_gap for c in chosen):
            continue
        chosen.append(round(pt, 2))
    picks = {t: "peak" for t in chosen}
    # 等間隔: 一番長く空いている区間（端も含む）の真ん中に 1 枚ずつ
    while len(picks) < max_n:
        pts = [0.0] + sorted(picks) + [duration]
        a, b = max(zip(pts, pts[1:]), key=lambda ab: ab[1] - ab[0])
        if (b - a) / 2 < min_gap:
            break
        picks[round((a + b) / 2, 2)] = "even"
    return sorted((t, r) for t, r in picks.items() if 0 <= t <= duration)


# ---- 計測本体 ----

def keypoint_rows(kps_xy, kps_conf, w, h):
    return [[round(float(kps_xy[k][0]) / w, 3), round(float(kps_xy[k][1]) / h, 3), round(float(kps_conf[k]), 2)]
            for k in range(len(kps_xy))]


def find_gaps(ts, duration, min_gap=1.0):
    """映っていなかった区間 [{from, to}]（min_gap 秒以上。動画の頭・終わりの不在も含む）"""
    pts = [0.0] + list(ts) + [duration]
    return [{"from": round(a, 2), "to": round(b, 2)} for a, b in zip(pts, pts[1:]) if b - a >= min_gap]


def summarize_main_persons(stats, total_frames, duration):
    """主な人物を選ぶ。stats: [{id, frames, firstT, lastT, meanHeight, ts}]（ts は映っていた時刻の列）。
    主な人物 = 映っていた割合が MAIN_MIN_COVERAGE 以上で、候補の中で一番大きい人の MAIN_MIN_SIZE 倍以上の高さの id
    （画面の端の小さい人・鏡の像・通りすがりは外れる）。戻り値 (mainPersons, minorIds)。
    mainPersons: [{id, coverage, meanHeight, firstT, lastT, gaps}] を割合の大きい順に最大 MAIN_MAX 人。
    gaps は 1 秒以上映っていなかった区間 = id が途切れた・隠れた区間"""
    if not stats or total_frames <= 0:
        return [], []
    for s in stats:
        s["coverage"] = s["frames"] / total_frames
    cand = [s for s in stats if s["coverage"] >= MAIN_MIN_COVERAGE]
    if not cand:
        cand = sorted(stats, key=lambda s: -s["frames"] * s["meanHeight"])[:2]
    top_h = max(s["meanHeight"] for s in cand)
    main = [s for s in cand if s["meanHeight"] >= MAIN_MIN_SIZE * top_h]
    main = sorted(main, key=lambda s: -s["coverage"] * s["meanHeight"])[:MAIN_MAX]
    main_ids = {s["id"] for s in main}
    out = [{"id": s["id"], "coverage": round(s["coverage"], 3), "meanHeight": round(s["meanHeight"], 3),
            "firstT": s["firstT"], "lastT": s["lastT"], "gaps": find_gaps(s["ts"], duration)} for s in main]
    return out, [s["id"] for s in stats if s["id"] not in main_ids]


def color_hist(frame, bbox):
    """人物 bbox 上半分（服・肌）の HSV 色ヒストグラム（8×4×4 = 128 次元、L1 正規化の list）。小さすぎれば None。
    analyze_pair.torso_hist と同じ作りだが、あちらは ultralytics を import してしまうのでここに持つ"""
    import cv2
    h, w = frame.shape[:2]
    x0, x1 = int(max(0.0, bbox[0]) * w), int(min(1.0, bbox[2]) * w)
    y0 = int(max(0.0, bbox[1]) * h)
    y1 = int(min(1.0, bbox[1] + (bbox[3] - bbox[1]) * 0.6) * h)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    hsv = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return [round(float(v), 5) for v in hist.flatten()]


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
        bbox = [round(float(v), 3) for v in boxes[i]]
        out.append({"bbox": bbox, "kps": keypoint_rows(kps_xy[i], kps_conf[i], w, h), "hist": color_hist(frame, bbox)})
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

    # 1. 検出（YOLO は重いので、環境変数 GENERAL_DET_CACHE にパスがあれば検出結果を保存・再利用する。調整用）
    cache_path = os.environ.get("GENERAL_DET_CACHE")
    frames = None   # [(t, dets)]
    if cache_path and os.path.exists(cache_path):
        with open(cache_path) as f:
            frames = [(t, dets) for t, dets in json.load(f)]
    if frames is None:
        model = YOLO(model_path)
        frames = []
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % interval == 0:
                frames.append((float(clock.time(idx)), detect(model, frame)))
            idx += 1
        if cache_path:
            with open(cache_path, "w") as f:
                json.dump(frames, f)
    cap.release()

    # 2. 追跡（見失った人を 2 秒覚えて付け直す）と動きの大きさ
    tracks, next_id = {}, 0
    series = {}      # id -> [{t, bbox, kps, speed}]
    feats = {}       # id -> [{f, center, h, hist, shape}]（つなぎ直し用）
    motion_t, motion_raw = [], []
    last_t = 0.0
    sampled = 0
    for t, dets in frames:
        last_t = t
        ids, next_id = assign_tracks(tracks, dets, sampled, next_id)
        speeds = []
        for d, pid in zip(dets, ids):
            s = series.setdefault(pid, [])
            speed = None
            if s and t - s[-1]["t"] <= (SPEED_MAX_GAP + 1) / TARGET_FPS:
                speed = person_speed(s[-1]["kps"], d["kps"], t - s[-1]["t"], aspect)
            s.append({"t": round(t, 2), "bbox": d["bbox"], "kps": d["kps"],
                      "speed": round(speed, 3) if speed is not None else None})
            if speed is not None:
                speeds.append(speed)
            feats.setdefault(pid, []).append({"f": sampled, "center": bbox_center(d["bbox"]),
                                              "h": d["bbox"][3] - d["bbox"][1], "hist": d.get("hist"), "shape": d.get("shape")})
        motion_t.append(round(t, 2))
        motion_raw.append(sum(speeds) / len(speeds) if speeds else 0.0)
        sampled += 1

    # 2 パス目: 追跡の断片を、服の色・骨格の形・大きさ・位置が合うものどうしでつなぎ直す
    online_ids = len(series)
    remap = stitch_tracklets(feats)
    merged = {}
    for old, s in series.items():
        merged.setdefault(remap[old], []).extend(s)
    series = {k: sorted(v, key=lambda x: x["t"]) for k, v in sorted(merged.items())}

    duration = last_t
    motion_v = smooth(motion_raw)
    picks = select_keyframe_times(duration, motion_t, motion_v)
    keyframes = write_keyframes(video_path, kf_dir, picks)
    # 動きの山（peaks）= 静止画を撮った山の頂上。summary.motion.peaks の時刻には必ず keyframes がある
    vmap = dict(zip(motion_t, motion_v))
    peaks = [(t, vmap.get(t, 0.0)) for t, r in picks if r == "peak"]
    segs = [{"from": round(a, 2), "to": round(b, 2), "peakT": round(pt, 2)} for a, b, pt, _ in mountains(motion_t, motion_v)]

    persons_summary, stats = [], []
    for pid, s in sorted(series.items()):
        sp = [x["speed"] for x in s if x["speed"] is not None]
        persons_summary.append({
            "id": pid, "frames": len(s), "firstT": s[0]["t"], "lastT": s[-1]["t"],
            "meanSpeed": round(sum(sp) / len(sp), 3) if sp else None,
            "maxSpeed": round(max(sp), 3) if sp else None,
        })
        stats.append({"id": pid, "frames": len(s), "firstT": s[0]["t"], "lastT": s[-1]["t"], "ts": [x["t"] for x in s],
                      "meanHeight": sum(x["bbox"][3] - x["bbox"][1] for x in s) / len(s)})
    main_persons, minor_ids = summarize_main_persons(stats, sampled, duration)
    out = {
        "pipeline": "general",
        "video": {"fps": round(fps, 2), "durationSec": round(duration, 2), "width": width, "height": height,
                  "sampleFps": round(fps / interval, 2)},
        "summary": {
            "personCount": len(series),
            "persons": persons_summary,
            "mainPersons": main_persons,
            "minorPersonIds": minor_ids,
            "motion": {
                "mean": round(sum(motion_v) / len(motion_v), 3) if motion_v else 0.0,
                "max": round(max(motion_v), 3) if motion_v else 0.0,
                "peaks": [{"t": round(t, 2), "v": round(v, 3)} for t, v in peaks],
                "mountains": segs,
            },
            "keyframes": keyframes,
            "events": [],
        },
        "motion": [{"t": t, "v": round(v, 3)} for t, v in zip(motion_t, motion_v)],
        "persons": [{"id": pid, "track": s} for pid, s in sorted(series.items())],
    }
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"general: {sampled} frames, {len(series)} persons (online {online_ids}), main {[p['id'] for p in main_persons]}, "
          f"{len(keyframes)} keyframes", file=sys.stderr)


if __name__ == "__main__":
    main()
