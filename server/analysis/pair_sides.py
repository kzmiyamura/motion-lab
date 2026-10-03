#!/usr/bin/env python3
"""
主ペアの「女性が画面の左右どちらにいるか」の時系列と、左右が入れ替わった瞬間（通過）を tracks.json から読む。

normalize_routine.py（技ごとの開始・終了の立ち位置、パスの有無の整合チェック）と
make_move_frames.py（通過の瞬間のコマを選ぶ）が使う。

- tracks.json の frames[].kept[] は pid 0/1 が主ペアで、leaderPid がリーダー（男性）。pid は服の色で
  全編追跡しているので、CBL で交差しても入れ替わらない（analyze_pair.py）
- 2人とも写っているコマだけ使い、女性の腰が男性より画面右なら "right"
- 一瞬だけの逆向き（重なった瞬間の取り違え）は捨てる: 同じ向きが SETTLE_N コマ以上続いた区間（ラン）だけを信じる
- 通過 = 向きの違うランの境目。時刻は前のランの最後と次のランの最初の中点（交差の瞬間は片方が隠れて
  写らないことが多いので、隠れていた区間の真ん中を通過とみなす）

CV の入れ替わりイベント（summary.events の CBL）は「入れ替わった後に2人とも見えた最初のコマ」で、
1コマの取り違えでも出るので、立ち位置そのものはこちらで読む
"""
import json
import os

SETTLE_N = 2          # この数以上続いた向きだけを信じる（10fps で 0.2 秒）
MAX_GAP_SEC = 3.0     # ランの中でこれより長く2人がそろわなければ、別のランとして切る
MIN_DX = 0.03         # 腰の X 差（正規化）がこれ未満は重なっていて左右が読めない


def load_tracks(path):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) or None
    except (OSError, ValueError):
        return None


def _hip_x(p):
    x = p.get("hipX")
    if isinstance(x, (int, float)):
        return float(x)
    b = p.get("bbox")
    return (b[0] + b[2]) / 2 if b else None


def follower_series(tracks):
    """[(t, "left"|"right")] 女性の画面上の側（2人とも写っていて左右が読めるコマだけ）"""
    if not tracks:
        return []
    lp = tracks.get("leaderPid")
    if lp not in (0, 1):
        return []
    fp = 1 - lp
    out = []
    for f in tracks.get("frames") or []:
        ps = {p.get("pid"): p for p in f.get("kept") or []}
        if lp not in ps or fp not in ps:
            continue
        lx, fx = _hip_x(ps[lp]), _hip_x(ps[fp])
        if lx is None or fx is None or abs(fx - lx) < MIN_DX:
            continue
        out.append((float(f["t"]), "right" if fx > lx else "left"))
    return out


def settled_runs(series):
    """同じ側が SETTLE_N コマ以上続いた区間 [{side, from, to}]（時刻順）"""
    raw = []
    for t, s in series:
        if raw and raw[-1]["side"] == s and t - raw[-1]["to"] <= MAX_GAP_SEC:
            raw[-1]["to"] = t
            raw[-1]["n"] += 1
        else:
            raw.append({"side": s, "from": t, "to": t, "n": 1})
    runs = []
    for r in raw:
        if r["n"] < SETTLE_N:
            continue
        if runs and runs[-1]["side"] == r["side"] and r["from"] - runs[-1]["to"] <= MAX_GAP_SEC:
            runs[-1]["to"] = r["to"]       # 間の取り違えを飛ばしてつなぐ
            continue
        runs.append({"side": r["side"], "from": r["from"], "to": r["to"]})
    return runs


def crossings(runs):
    """左右が入れ替わった瞬間 [{t, from, to, hiddenFrom, hiddenTo}]（t = 隠れていた区間の中点）"""
    out = []
    for a, b in zip(runs, runs[1:]):
        if a["side"] == b["side"]:
            continue
        out.append({
            "t": round((a["to"] + b["from"]) / 2, 2), "from": a["side"], "to": b["side"],
            "hiddenFrom": round(a["to"], 2), "hiddenTo": round(b["from"], 2),
        })
    return out


def side_at(runs, t, max_dist=None):
    """t の時点の女性の側。ランの中ならその側、ランの間なら近い方のラン（max_dist 秒より遠ければ None）"""
    best = None
    for r in runs:
        if r["from"] <= t <= r["to"]:
            return r["side"]
        d = r["from"] - t if t < r["from"] else t - r["to"]
        if best is None or d < best[0]:
            best = (d, r["side"])
    if best is None or (max_dist is not None and best[0] > max_dist):
        return None
    return best[1]


def side_before(runs, t, max_dist=None):
    """t より前で最後に確かめられた側（t がランの中ならその側）"""
    prev = None
    for r in runs:
        if r["from"] <= t:
            prev = r
    if prev is None:
        return side_at(runs, t, max_dist)
    if max_dist is not None and t - prev["to"] > max_dist:
        return None
    return prev["side"]


def side_after(runs, t, max_dist=None):
    """t より後で最初に確かめられた側（t がランの中ならその側）"""
    for r in runs:
        if r["to"] >= t:
            if max_dist is not None and r["from"] - t > max_dist:
                return None
            return r["side"]
    return side_at(runs, t, max_dist)
