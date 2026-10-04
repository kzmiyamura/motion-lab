#!/usr/bin/env python3
"""
analyze_pair.py の 10fps の本計測の後で、左右の入れ替わり（CBL）とターンの前後だけを 25〜30fps で骨格を取り直し、
イベントの時刻・回転を細かく決め直す（measurements.json の summary.events と tracks.json の events を書き換える）。

なぜ: 10fps の CV の入れ替わり（detect_cbl）は「入れ替わった後に2人とも見えた最初のコマ」なので、本当の通過より
遅れ、その遅れが区間ごとに 0〜1 秒揺れる（1230b3d5 / ジョブ 581ef6a2 の正解表で、正解の通過→CV の入れ替わりの
中央値が 0〜40 秒で 0.76 秒・40〜80 秒で 0.05 秒。docs/salsa-knowledge/README.md 反映済み 7）。無音の動画では
この入れ替わりに 8 カウントの格子を当てるので、揺れがそのままカウントの 1〜2 拍のずれになる。

やること（イベントごとの窓だけ。窓が重なれば 1 回だけ推論する）:
  - CBL: 窓 = [前の側で最後に2人とも見えた 10fps のコマ − 0.15 秒（少なくとも t − PRE、最大 t − PRE_MAX）, t + POST]。
    2人の腰の X の並び（pid は analyze_pair と同じ服の色の追跡 + 窓ごとの錨）が前の側で最後に読めたコマ A と、
    新しい側で最初に読めたコマ B を 25〜30fps で決め直し、通過の時刻を A と B の中点（隠れていた区間の真ん中）にする。
    元の時刻は tCoarse に残す
  - ターン: 窓 = [spin.from（無ければ t）− 0.4, spin.to（無ければ t + 1）+ 0.4]。肩の左右の並び（shDx を本人の
    肩幅で割った cos）と顔の向き（鼻と耳。sin の符号）から体の向きの角度を出してつなぎ（unwrap）、
    回り始め・向き直り・回る向き・回転数を heading に書く（analyze_pair の spin は残す）
  人物は analyze_pair と同じ検出（YOLOv8s-pose・ROI マスク・観客の体格門番・面積上位2人）と同じ追跡
  （track_appearance。錨 = 窓の近くの 10fps のコマで重なっていない2人の服の色の平均）で決め、10fps のコマと
  pid が食い違う窓（idAgree < ID_MIN_AGREE）は書き換えない。

結果（2026-10-04、出していない。jobWorker では REFINE_EVENTS=1 のときだけ動く）:
  - 1230b3d5（581ef6a2）: 取り直せた入れ替わり 24/50 件で、正解の通過からの遅れは中央値 +0.40 → +0.25 秒に縮んだが
    ばらつき（標準偏差）は 0.46 → 0.55 秒で減らない。区間ごとの遅れの中央値（0〜40 秒 0.7 秒・40〜80 秒 0.06 秒）も
    そのまま → 遅れの揺れは 10fps の間引きではなく、撮影の角度（2D の腰の交差と本当の通過のずれ）から来ている。
    振付シートの行は SWAP_BEAT を振り直しても .967/.968/.897/.914 → 最良で .967/.968/.872/.897
  - ターンの向き（下の heading）: 正解表 4 本 23 件で 17/23 → 16/23（肩の左右に頼らない版も同じ 16/23）、
    回転数の誤差 .375 → .458。右回りを左と出す 5 件は 27fps でも同じ向きに出る
  - 時間: 1230b3d5（156 秒）で CBL 50 窓・ターン 41 窓 3115 コマ、2 スレッド・優先度低で 610 秒

全体の追加時間は --budget-sec（既定 REFINE_BUDGET_SEC）で打ち切る（CBL を先に、時刻順に処理し、残りは元のまま）。
何度実行しても同じ（tCoarse があればそれを元の時刻として使う）。

Usage: python refine_events.py <video_path> <yolo_model_path> <measurements.json> [--tracks=<tracks.json>]
         [--fps=27] [--budget-sec=240] [--threads=N] [--low-priority] [--only=cbl|turn]
"""
import json
import math
import os
import sys
import time

REFINE_FPS = 27.0          # 取り直す fps（元動画がこれ以下なら全フレーム）
REFINE_BUDGET_SEC = 240.0  # 追加時間の上限（秒）
CBL_PRE_SEC = 1.2          # 入れ替わりの窓: t の前（少なくとも）
CBL_PRE_MAX_SEC = 2.0      # 前の側で最後に見えたコマまで広げるときの上限
CBL_POST_SEC = 0.4         # t の後（新しい側が続くことを確かめる分）
TURN_PAD_SEC = 0.4         # ターンの窓: spin.from〜to の前後
TURN_MAX_SEC = 4.5         # ターンの窓の長さの上限
MIN_DX = 0.02              # 腰の X 差（正規化）がこれ未満は重なっていて左右を読まない
ID_MIN_AGREE = 0.6         # 10fps のコマとの pid の一致率がこれ未満の窓は書き換えない
ANCHOR_NEAR_SEC = 3.0      # 窓の錨に使う 10fps のコマを探す範囲
ANCHOR_MAX_FRAMES = 8
ROI_MARGIN_MUL = 1.5       # ROI = 近くの 10fps のコマの2人の bbox の合併 + analyze_pair の余白 × これ
HEADING_JUMP_MAX = 120.0   # 1 コマでこれより大きく向きが飛んだサンプルは読み違いとして捨てる
HEADING_REVERSE_DEG = 90.0  # 回る向きが変わったとみなす戻りの角度
HEADING_USE_LABELS = os.environ.get("REFINE_HEADING_LABELS") == "1"   # 評価用: cos の符号に COCO の肩の左右を使う
APPLY_HEADING = os.environ.get("REFINE_APPLY_HEADING") == "1"   # spin / rotations を取り直した値に置き換える（既定は書かない。正解表で悪化）
HEADING_MOVE_DEG = 45.0   # 回り始め = 最初の向きからこれ以上離れる直前、向き直り = 最後の向きからこれ以内に入った所


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def parse_args(argv):
    pos = [a for a in argv if not a.startswith("--")]
    flags = {}
    for a in argv:
        if a.startswith("--"):
            k, _, v = a[2:].partition("=")
            flags[k] = v if v else True
    return pos, flags


# ---------------------------------------------------------------- 窓の計画（純粋関数）

def pair_series(frames, size_ratio=0.7, size_win=3.0):
    """10fps の tracks から (t, hipX[pid0] − hipX[pid1])。背の縮んだコマ（別人の取り違え）は除く（detect_cbl と同じ）"""
    heights = {0: [], 1: []}
    for f in frames:
        for p in f.get("kept", []):
            if p.get("pid") in heights and p.get("bbox"):
                heights[p["pid"]].append((f["t"], p["bbox"][3] - p["bbox"][1]))
    out = []
    for f in frames:
        by = {p.get("pid"): p for p in f.get("kept", []) if p.get("pid") in (0, 1)}
        if 0 not in by or 1 not in by:
            continue
        ok = True
        for k in (0, 1):
            b = by[k].get("bbox")
            hs = sorted(h for t, h in heights[k] if abs(t - f["t"]) <= size_win)
            if b and hs and (b[3] - b[1]) < size_ratio * hs[len(hs) // 2]:
                ok = False
        if ok:
            out.append((f["t"], by[0]["hipX"] - by[1]["hipX"]))
    return out


def last_old_before(series, t, old_sign, min_dx=MIN_DX):
    """t より前で、old_sign 側に読めた最後の時刻（無ければ None）"""
    best = None
    for tt, d in series:
        if tt >= t - 1e-6:
            break
        if abs(d) >= min_dx and (d > 0) == (old_sign > 0):
            best = tt
    return best


def old_sign_at(series, t):
    """t の直前の 10fps のペアのコマの並びの符号（入れ替わる前の側）"""
    prev = [d for tt, d in series if tt < t - 1e-6 and abs(d) >= MIN_DX]
    if not prev:
        return None
    return 1 if prev[-1] > 0 else -1


def plan_windows(events, coarse_series):
    """イベントごとの窓 [(kind, index, w0, w1, extra)]。CBL を先に、それぞれ時刻順"""
    cbl, turn = [], []
    for i, e in enumerate(events):
        if not isinstance(e, dict) or not _num(e.get("t")):
            continue
        # 元の 10fps の腰の交差の時刻: 取り直し済みなら tCoarse、analyze_pair が通過に寄せた t なら tCross
        t = e["tCoarse"] if _num(e.get("tCoarse")) else e["tCross"] if _num(e.get("tCross")) else e["t"]
        if e.get("type") == "CBL":
            sign = old_sign_at(coarse_series, t)
            a = last_old_before(coarse_series, t, sign) if sign else None
            # 前の側で最後に見えた 10fps のコマより前は 10fps で側が分かっているので取り直さない（時間の節約）。
            # 分からなければ t − CBL_PRE_SEC から
            w0 = a - 0.15 if a is not None else t - CBL_PRE_SEC
            w0 = max(w0, t - CBL_PRE_MAX_SEC, 0.0)
            cbl.append(("cbl", i, w0, t + CBL_POST_SEC, {"t": t, "oldSign": sign, "lastOldCoarse": a}))
        elif e.get("type") == "Turn" and e.get("by") in ("leader", "follower"):
            sp = e.get("spinCoarse") or e.get("spin") or {}
            a = sp.get("from") if _num(sp.get("from")) else t
            b = sp.get("to") if _num(sp.get("to")) else t + 1.0
            w0 = max(0.0, min(a, t) - TURN_PAD_SEC)
            w1 = min(max(b, t + 1.0) + TURN_PAD_SEC, w0 + TURN_MAX_SEC)
            turn.append(("turn", i, w0, w1, {"t": t}))
    cbl.sort(key=lambda w: w[2])
    turn.sort(key=lambda w: w[2])
    return cbl + turn


def merge_intervals(wins):
    """窓の [w0, w1] を重なりでまとめる（推論は 1 フレーム 1 回）"""
    iv = sorted((w[2], w[3]) for w in wins)
    out = []
    for a, b in iv:
        if out and a <= out[-1][1] + 1e-6:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def pick_indices(fps, target_fps, t0, t1):
    """[t0, t1] の中で使うフレーム番号（target_fps 相当。元が target 以下なら全部）"""
    i0, i1 = max(0, int(math.ceil(t0 * fps))), int(math.floor(t1 * fps))
    if fps <= target_fps + 0.5:
        return list(range(i0, i1 + 1))
    out, last = [], None
    for i in range(i0, i1 + 1):
        k = int(math.floor(i * target_fps / fps))
        if k != last:
            out.append(i)
            last = k
    return out


# ---------------------------------------------------------------- 入れ替わりの時刻（純粋関数）

def refine_crossing(dense, t_coarse, old_sign, last_old_coarse=None, min_dx=MIN_DX, post=CBL_POST_SEC):
    """密な (t, d) 列（d = hipX[pid0] − hipX[pid1]、2人とも見えたコマだけ）から通過の時刻を決める。
    A = t_coarse 以前で old 側に読めた最後のコマ、B = A の後で新しい側に読めた最初のコマ。
    通過 = (A + B) / 2（隠れていた区間の真ん中）。窓に old 側が無ければ 10fps の最後の old のコマを A に使う。
    戻り値 {t, lastOld, firstNew, gap, basis} か None（決められない）"""
    if old_sign is None:
        return None
    pts = sorted((t, d) for t, d in dense if abs(d) >= min_dx)
    a = None
    for t, d in pts:
        if t > t_coarse + 0.05:
            break
        if (d > 0) == (old_sign > 0):
            a = t
    basis = "dense"
    if a is None:
        if last_old_coarse is None:
            return None
        a, basis = last_old_coarse, "coarseOld"
    b = next((t for t, d in pts if t > a and (d > 0) != (old_sign > 0)), None)
    if b is None or b > t_coarse + post:
        return None
    return {"t": round((a + b) / 2, 3), "lastOld": round(a, 3), "firstNew": round(b, 3),
            "gap": round(b - a, 3), "basis": basis}


# ---------------------------------------------------------------- 体の向きの角度（純粋関数）

def heading_series(samples, width):
    """[(t, shDx, face, front)] → [(t, 角度°)]（unwrap 済み）。
    角度: 0 = カメラを向く、+90 = 顔が画面左、180 = 背中、270 = 顔が画面右。増える向き = 上から見て時計回り = 右回り
    （analyze_pair.spin_hint と同じ決まり）。
    |cos| = |shDx| / 肩幅。cos の符号は COCO の左右の肩の並びでは決めない（背中を向くと左右の肩の付け方が入れ替わり、
    右回りを左回りと読む。正解表で向きの誤り 6 件が全部「右を左」だった）: front（顔が見える = +1、見えない = −1、
    分からない = 0）で決める。sin の符号 = −顔の向き（鼻が耳より画面右なら +1）。決まらない成分は、回っている勢いで
    先を読んで近い方を取る（背中側では「180° を越えた」と「戻った」が cos だけでは区別できない）。
    front を省いた 3 要素のサンプルは従来どおり shDx の符号を cos の符号に使う"""
    out = []
    prev = None
    vel = 0.0   # 角速度（°/秒）
    for smp in samples:
        t, dx, face = smp[0], smp[1], smp[2]
        front = smp[3] if len(smp) > 3 else None
        if not width or width <= 0:
            continue
        c = max(-1.0, min(1.0, dx / width))
        if front is not None:
            c = abs(c) if front > 0 else -abs(c) if front < 0 else abs(c)
        s = math.sqrt(max(0.0, 1 - c * c))
        cs = [c] if (front is None or front != 0) else [c, -c]
        ss = [-face * s] if face else [s, -s]
        cands = [math.degrees(math.atan2(y, x)) for x in cs for y in ss]
        if prev is None:
            if len(cands) > 1 and not (front is None and abs(c) >= 0.9) and not (front and abs(c) >= 0.9):
                continue  # 最初のコマは向きが 1 つに決まるまで待つ
            phi = cands[0]
        else:
            dt = t - out[-1][0]
            pred = prev + vel * dt

            def unwrap(a):
                return pred + ((a - pred + 180) % 360 - 180)
            phi = min((unwrap(a) for a in cands), key=lambda a: abs(a - pred))
            if abs(phi - prev) > HEADING_JUMP_MAX:
                continue
            if dt > 0:
                vel = 0.5 * vel + 0.5 * (phi - prev) / dt
        out.append((t, phi))
        prev = phi
    return out


def heading_summary(series):
    """unwrap した角度の列から {netDeg, dir, turns, runs, from, to}。runs は戻りが HEADING_REVERSE_DEG を超えたら分ける"""
    if len(series) < 3:
        return None
    phis = [p for _, p in series]
    runs = []   # [dir, 始まりの角度, 極値]
    start = phis[0]
    cur_dir, ext = 0, phis[0]
    seg_start = phis[0]
    for p in phis[1:]:
        if cur_dir == 0:
            if abs(p - seg_start) >= HEADING_REVERSE_DEG / 2:
                cur_dir = 1 if p > seg_start else -1
                ext = p
            continue
        if (p - ext) * cur_dir > 0:
            ext = p
        elif abs(p - ext) >= HEADING_REVERSE_DEG:
            runs.append((cur_dir, seg_start, ext))
            seg_start, cur_dir, ext = ext, -cur_dir, p
    if cur_dir != 0:
        runs.append((cur_dir, seg_start, ext))
    net = phis[-1] - start
    # 回り始め / 向き直り
    t_from = series[0][0]
    for (t, p) in series:
        if abs(p - start) > HEADING_MOVE_DEG:
            break
        t_from = t
    end = phis[-1]
    t_to = series[-1][0]
    for (t, p) in reversed(series):
        if abs(p - end) > HEADING_MOVE_DEG:
            break
        t_to = t
    out_runs = [{"dir": "right" if d > 0 else "left", "turns": round(abs(e - s) / 180) / 2}
                for d, s, e in runs]
    out_runs = [r for r in out_runs if r["turns"] > 0]
    main = max(out_runs, key=lambda r: r["turns"]) if out_runs else None
    return {
        "netDeg": round(net), "dir": main["dir"] if main else None,
        "turns": round(sum(r["turns"] for r in out_runs if main and r["dir"] == main["dir"]) * 2) / 2 if main else 0,
        "runs": out_runs, "from": round(t_from, 2), "to": round(t_to, 2),
    }


# ---------------------------------------------------------------- 実行（YOLO）

def set_low_priority():
    """Windows: 自プロセスを「通常以下」に。他 OS は nice"""
    try:
        if os.name == "nt":
            import ctypes
            k = ctypes.windll.kernel32
            k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
        else:
            os.nice(5)
    except Exception:  # noqa: BLE001
        pass


DUMP = []   # --dump: ターンの窓の骨格（向きの読み方を YOLO を回さずに試すため）


def face_front(p, hi=0.6, lo=0.25):
    """顔（鼻・両目）が見えていれば +1（カメラ側を向く）、見えなければ −1（背中）、どちらとも言えなければ 0。
    COCO の左右の肩の付け方に頼らない前後の手がかり"""
    k = p.get("kps")
    if not k:
        return 0
    v = sorted((k[i][2] for i in (0, 1, 2)), reverse=True)
    m = (v[0] + v[1]) / 2
    return 1 if m >= hi else -1 if m <= lo else 0


def _bbox_iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


class Coarse:
    """10fps の tracks.json の引き出し"""

    def __init__(self, frames):
        self.frames = frames
        self.ts = [f["t"] for f in frames]
        self.by_idx = {f.get("frameIdx"): f for f in frames if f.get("frameIdx") is not None}

    def near(self, t, win):
        import bisect
        i = bisect.bisect_left(self.ts, t - win)
        out = []
        while i < len(self.frames) and self.ts[i] <= t + win:
            out.append(self.frames[i])
            i += 1
        return out

    def roi(self, t, margin):
        boxes = [p["bbox"] for f in self.near(t, 0.25) for p in f.get("kept", []) if p.get("pid") in (0, 1) and p.get("bbox")]
        if not boxes:
            return None
        return (max(0.0, min(b[0] for b in boxes) - margin), max(0.0, min(b[1] for b in boxes) - margin),
                min(1.0, max(b[2] for b in boxes) + margin), min(1.0, max(b[3] for b in boxes) + margin))

    def typical_area(self, t):
        areas = []
        for f in self.near(t, 3.0):
            ks = [p for p in f.get("kept", []) if p.get("pid") in (0, 1) and p.get("bbox")]
            if len(ks) == 2:
                areas.append(min((p["bbox"][2] - p["bbox"][0]) * (p["bbox"][3] - p["bbox"][1]) for p in ks))
        if not areas:
            return None
        areas.sort()
        return areas[len(areas) // 2]

    def clean_anchor_frames(self, w0, w1, iou_max):
        """窓の近くで2人が重なっていない 10fps のコマ（錨用）。窓に近い順に最大 ANCHOR_MAX_FRAMES"""
        cands = []
        for f in self.near((w0 + w1) / 2, (w1 - w0) / 2 + ANCHOR_NEAR_SEC):
            ks = {p.get("pid"): p for p in f.get("kept", []) if p.get("pid") in (0, 1) and p.get("bbox")}
            if 0 in ks and 1 in ks and _bbox_iou(ks[0]["bbox"], ks[1]["bbox"]) < iou_max:
                d = 0.0 if w0 <= f["t"] <= w1 else min(abs(f["t"] - w0), abs(f["t"] - w1))
                cands.append((d, f))
        cands.sort(key=lambda x: x[0])
        return [f for _, f in cands[:ANCHOR_MAX_FRAMES]]


def run(video_path, model_path, meas_path, tracks_path, target_fps, budget, only=None):
    import cv2
    import numpy as np
    import analyze_pair as ap

    t_start = time.time()
    with open(meas_path, encoding="utf-8") as f:
        meas = json.load(f)
    summary = meas.setdefault("summary", {})
    events = summary.get("events") or []
    tracks = None
    if tracks_path and os.path.exists(tracks_path):
        with open(tracks_path, encoding="utf-8") as f:
            tracks = json.load(f)
    info = {"version": 1, "fps": None, "budgetSec": budget, "windows": 0, "framesInferred": 0,
            "refinedCBL": 0, "refinedTurns": 0, "skipped": [], "seconds": 0.0}
    if not tracks or tracks.get("leaderPid") not in (0, 1) or not events:
        info["skipped"].append("no tracks / leader / events")
        return meas, tracks, info
    coarse = Coarse(tracks.get("frames") or [])
    cseries = pair_series(coarse.frames)
    wins = plan_windows(events, cseries)
    if only == "cbl":
        wins = [w for w in wins if w[0] == "cbl"]
    elif only == "turn":
        wins = [w for w in wins if w[0] == "turn"]

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        info["skipped"].append("video")
        return meas, tracks, info
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.release()
    info["fps"] = round(min(fps, target_fps), 2)
    from ultralytics import YOLO
    model = YOLO(model_path)

    dense = {}        # frameIdx -> {"t", "kept"}
    anchor_hist = {}  # frameIdx -> {pid: hist}
    anchor_frames = {}
    margin = ap.ROI_MARGIN * ROI_MARGIN_MUL

    def frames_needed(group):
        """推論するフレーム（窓の和集合を target_fps で + 10fps のコマと同じ番号）と、錨の色だけ取るコマ"""
        need = {}
        for a, b in merge_intervals(group):
            for i in pick_indices(fps, target_fps, a, b):
                need[i] = "detect"
        for w in group:
            # 10fps のコマと同じ番号のフレームは必ず推論する（pid の一致を確かめる）
            for f in coarse.near((w[2] + w[3]) / 2, (w[3] - w[2]) / 2):
                if f.get("frameIdx") is not None:
                    need[f["frameIdx"]] = "detect"
            for f in coarse.clean_anchor_frames(w[2], w[3], ap.ANCHOR_CLEAN_IOU):
                if f.get("frameIdx") is not None:
                    anchor_frames[f["frameIdx"]] = f
                    need.setdefault(f["frameIdx"], "hist")
        return {k: v for k, v in need.items() if k not in dense and not (v == "hist" and k in anchor_hist)}

    def process(need):
        """動画を頭から順に読み（要らないフレームは grab だけ）、need のフレームを推論する。予算を超えたら False"""
        if not need:
            return True
        cap = cv2.VideoCapture(video_path)
        last = max(need)
        idx = 0
        while idx <= last:
            kind = need.get(idx)
            if kind is None:
                if not cap.grab():
                    break
                idx += 1
                continue
            ok, frame = cap.read()
            if not ok:
                break
            t = idx / fps
            if kind == "detect":
                if time.time() - t_start > budget:
                    cap.release()
                    return False
                roi = coarse.roi(t, margin)
                work = ap.apply_roi_mask(frame, roi) if roi is not None else frame
                cands = ap.detect_persons(model, work)
                ta = coarse.typical_area(t)
                if ta:
                    cands = [c for c in cands if c["bboxArea"] >= ap.SPECTATOR_AREA_RATIO * ta]
                persons = ap.pick_main_pair(cands)
                for p in persons:
                    p["hist"] = ap.torso_hist(frame, p["bbox"])
                dense[idx] = {"frameIdx": idx, "t": t, "kept": persons}
                info["framesInferred"] += 1
            if idx in anchor_frames and idx not in anchor_hist:
                f = anchor_frames[idx]
                anchor_hist[idx] = {p["pid"]: ap.torso_hist(frame, p["bbox"]) for p in f["kept"] if p.get("pid") in (0, 1)}
            idx += 1
        cap.release()
        return True

    # CBL の窓を先に（格子に効く）、残りの予算でターンの窓
    for group in ([w for w in wins if w[0] == "cbl"], [w for w in wins if w[0] == "turn"]):
        if not process(frames_needed(group)):
            info["skipped"].append("budget")
            break

    leader = tracks["leaderPid"]
    for kind, i, w0, w1, extra in wins:
        e = events[i]
        frames = [dense[k] for k in sorted(dense) if w0 - 1e-6 <= dense[k]["t"] <= w1 + 1e-6]
        if len(frames) < 4:
            continue
        info["windows"] += 1
        # 窓の錨: 近くの重なっていない 10fps のコマの服の色の平均（analyze_pair の anchor_refs と同じ考え）
        acc = ([], [])
        for f in coarse.clean_anchor_frames(w0, w1, ap.ANCHOR_CLEAN_IOU):
            h = anchor_hist.get(f.get("frameIdx"))
            if h and h.get(0) is not None and h.get(1) is not None:
                acc[0].append(h[0])
                acc[1].append(h[1])
        if not acc[0]:
            info["skipped"].append(f"{kind}@{extra['t']}: no anchor")
            continue
        anchor = [np.mean(acc[0], axis=0), np.mean(acc[1], axis=0)]
        win_frames = [{"frameIdx": f["frameIdx"], "t": f["t"], "kept": [dict(p) for p in f["kept"]]} for f in frames]
        ap.track_appearance(win_frames, anchor, ap.ANCHOR_WEIGHT)
        # 10fps のコマとの pid の一致（bbox の IoU で対応づける）
        agree = n = 0
        for f in win_frames:
            cf = coarse.by_idx.get(f["frameIdx"])
            if not cf:
                continue
            for cp in cf.get("kept", []):
                if cp.get("pid") not in (0, 1):
                    continue
                best = max(f["kept"], key=lambda p: _bbox_iou(p["bbox"], cp["bbox"]), default=None)
                if best is None or _bbox_iou(best["bbox"], cp["bbox"]) < 0.5 or best.get("pid") is None:
                    continue
                n += 1
                agree += best["pid"] == cp["pid"]
        id_agree = agree / n if n else None
        if id_agree is not None and id_agree < ID_MIN_AGREE:
            info["skipped"].append(f"{kind}@{extra['t']}: idAgree {id_agree:.2f}")
            continue

        if kind == "cbl":
            heights = {0: [], 1: []}
            for f in coarse.near(extra["t"], 3.0):
                for p in f.get("kept", []):
                    if p.get("pid") in heights and p.get("bbox"):
                        heights[p["pid"]].append(p["bbox"][3] - p["bbox"][1])
            med = {k: sorted(v)[len(v) // 2] if v else None for k, v in heights.items()}
            series = []
            for f in win_frames:
                by = {p.get("pid"): p for p in f["kept"] if p.get("pid") in (0, 1)}
                if 0 not in by or 1 not in by:
                    continue
                if any(med[k] and (by[k]["bbox"][3] - by[k]["bbox"][1]) < 0.7 * med[k] for k in (0, 1)):
                    continue
                series.append((f["t"], by[0]["hipX"] - by[1]["hipX"]))
            r = refine_crossing(series, extra["t"], extra["oldSign"], extra["lastOldCoarse"])
            if r is None:
                continue
            e["tCoarse"] = extra["t"]
            e["t"] = round(r["t"], 2)
            if "tCross" in e:  # 取り直した通過の時刻を交差の時刻としても使う（normalize_routine は SWAP_BEAT_REFINED で読む）
                e["tCross"] = e["t"]
            e["swapRefine"] = {**r, "idAgree": None if id_agree is None else round(id_agree, 2),
                               "fps": info["fps"], "window": [round(w0, 2), round(w1, 2)]}
            info["refinedCBL"] += 1
        else:
            pid = leader if e.get("by") == "leader" else 1 - leader
            samples, widths = [], []
            for f in win_frames:
                p = next((q for q in f["kept"] if q.get("pid") == pid), None)
                if p is None:
                    continue
                widths.append(abs(p["shDx"]))
                samples.append((f["t"], p["shDx"], ap.face_side(p)) if HEADING_USE_LABELS
                               else (f["t"], p["shDx"], ap.face_side(p), face_front(p)))
            for f in coarse.near(extra["t"], 4.0):
                for p in f.get("kept", []):
                    if p.get("pid") == pid:
                        widths.append(abs(p.get("shDx", 0.0)))
            if len(samples) < 6 or not widths:
                continue
            widths.sort()
            width = widths[int(0.9 * (len(widths) - 1))]
            DUMP.append({"i": i, "t": extra["t"], "by": e.get("by"), "width": width, "window": [w0, w1],
                         "frames": [{"t": f["t"], "p": next(({k: q[k] for k in ("shDx", "kps", "bbox")}
                                                              for q in f["kept"] if q.get("pid") == pid), None)}
                                    for f in win_frames]})
            hs = heading_summary(heading_series(samples, width))
            if hs is None:
                continue
            e["heading"] = {**hs, "idAgree": None if id_agree is None else round(id_agree, 2),
                            "fps": info["fps"], "samples": len(samples), "window": [round(w0, 2), round(w1, 2)]}
            info["refinedTurns"] += 1
            if APPLY_HEADING and hs["runs"]:
                # 回る向き・回転数を取り直した値に置き換える（元は spinCoarse / rotationsCoarse）
                if "spinCoarse" not in e:
                    e["spinCoarse"] = e.get("spin")
                    e["rotationsCoarse"] = e.get("rotations")
                e["spin"] = {"runs": hs["runs"], "netDeg": hs["netDeg"], "from": hs["from"], "to": hs["to"],
                             "source": "heading"}
                total = sum(r["turns"] for r in hs["runs"])
                e["rotations"] = max(1, int(math.floor(total + 0.5)))
    info["seconds"] = round(time.time() - t_start, 1)
    summary["eventRefine"] = info
    if tracks is not None:
        tracks["events"] = events
    return meas, tracks, info


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def main():
    pos, flags = parse_args(sys.argv[1:])
    if len(pos) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    if flags.get("threads"):
        import torch
        torch.set_num_threads(int(flags["threads"]))
    if flags.get("low-priority"):
        set_low_priority()
    video_path, model_path, meas_path = pos
    tracks_path = flags.get("tracks") or os.path.splitext(meas_path)[0] + ".tracks.json"
    fps = float(flags.get("fps") or REFINE_FPS)
    budget = float(flags.get("budget-sec") or os.environ.get("REFINE_BUDGET_SEC") or REFINE_BUDGET_SEC)
    only = flags.get("only") if flags.get("only") in ("cbl", "turn") else None
    meas, tracks, info = run(video_path, model_path, meas_path, tracks_path, fps, budget, only)
    out = flags.get("out") or meas_path
    write_json(out, meas)
    if flags.get("dump"):
        write_json(flags["dump"], DUMP)
    if tracks is not None and not flags.get("out"):
        write_json(tracks_path, tracks)
    print(f"refine: cbl={info['refinedCBL']} turns={info['refinedTurns']} windows={info['windows']} "
          f"frames={info['framesInferred']} fps={info['fps']} {info['seconds']}s skipped={info['skipped'][:6]}",
          file=sys.stderr)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
