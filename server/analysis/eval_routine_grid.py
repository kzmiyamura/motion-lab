#!/usr/bin/env python3
"""
振付シート（result.json の routine.moves）が正解表（ground_truth/*.json）とどれだけ合っているかを測る。

normalize_routine.py が 8 カウントの格子に揃えた行（カード）を、正解の出来事の時刻で引いて確かめる:
  cbl          正解の CBL（optional でない kind=cbl）の時刻を覆う行が CBL 系か（再現率）
  swap         正解の入れ替わり全部（optional でない cbl + swap）について同じこと
  swapAll      optional も含めた入れ替わり全部について同じこと（参考）
  cblRows      CBL 系の行のうち、その行の時間内に正解の入れ替わり（optional 含む）があるものの割合（適合率）
  rowAgree     評価範囲の各行で「CBL 系か」と「正解の入れ替わりがあるか」が一致した割合
  turn         正解の女性ターンの時刻を覆う行にターンがあるか
  phase        正解の入れ替わりが、覆う行の 8 カウントの何拍目に来たか。On2 の CBL なら 5 前後（女が 5 で通る）
               （in57 = 5〜7 拍目に入った割合、R = 位相の集まり具合 0〜1）
  cvPhase      CV の入れ替わり（measurements.json の CBL イベント）について同じこと + CBL 系の行に入った数

Usage:
  python eval_routine_grid.py <result.json> <ground_truth.json> [measurements.json] [--raw] [--json out.json]
    --raw  正規化前の routine.rawMoves を採点する（Claude が書いたままの行）
"""
import argparse
import cmath
import json
import math
import sys

CBL_TYPES = {"cbl", "cbl_inside_turn", "cbl_outside_turn", "reverse_cbl"}
TURN_TYPES = {"right_turn", "left_turn", "inside_turn", "outside_turn", "cbl_inside_turn", "cbl_outside_turn", "copa"}


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def rows_with_end(moves, beat):
    """行に終わりの時刻を付ける（次の行の頭。最後の行は counts 分）"""
    ms = sorted((m for m in moves if isinstance(m, dict) and _num(m.get("start"))), key=lambda m: m["start"])
    out = []
    for i, m in enumerate(ms):
        c = m.get("counts") if _num(m.get("counts")) and m.get("counts") > 0 else 8
        end = ms[i + 1]["start"] if i + 1 < len(ms) else m["start"] + c * beat
        out.append((m["start"], max(end, m["start"] + 1e-6), m))
    return out


def covering(rows, t):
    for r in rows:
        if r[0] <= t < r[1]:
            return r
    return None


def is_cbl(m):
    return m.get("move") in CBL_TYPES


def has_turn(m):
    t = m.get("turn")
    if isinstance(t, dict) and t.get("by") in ("follower", "both") and (not _num(t.get("rotations")) or t["rotations"] > 0):
        return True
    return m.get("move") in TURN_TYPES


class Ratio:
    def __init__(self):
        self.hit = self.n = 0

    def add(self, ok):
        self.n += 1
        self.hit += bool(ok)

    def as_dict(self):
        return {"hit": self.hit, "n": self.n, "acc": round(self.hit / self.n, 3) if self.n else None}


def phase_stats(rows, times, beat):
    """各時刻が覆う行の 8 カウントの何拍目か（0 始まりの拍位置）を集める"""
    pos = []
    for t in times:
        r = covering(rows, t)
        if r is None:
            continue
        pos.append(((t - r[0]) / beat) % 8)
    if not pos:
        return {"n": 0, "in57": None, "R": None, "meanCount": None, "hist": [0] * 8}
    z = sum(cmath.exp(2j * math.pi * p / 8) for p in pos) / len(pos)
    mean_beat = (cmath.phase(z) / (2 * math.pi) * 8) % 8
    hist = [0] * 8
    for p in pos:
        hist[int(p) % 8] += 1
    return {
        "n": len(pos),
        "in57": round(sum(1 for p in pos if 4 <= p < 7) / len(pos), 3),
        "R": round(abs(z), 3),
        "meanCount": round(mean_beat + 1, 2),   # 1 始まりのカウント（5.5 = 5 と 6 の間）
        "hist": hist,                            # カウント 1〜8 に入った数
    }


def evaluate(moves, gt, beat, cv_swaps=None):
    lo, hi = gt.get("evalRange") or (float("-inf"), float("inf"))
    rows = rows_with_end(moves, beat)
    in_range = lambda t: lo <= t <= hi  # noqa: E731
    cbl = [c for c in gt.get("cbl", []) if in_range(c["t"])]
    res = {"cbl": Ratio(), "swap": Ratio(), "swapAll": Ratio(), "cblRows": Ratio(), "rowAgree": Ratio(), "turn": Ratio()}
    for c in cbl:
        r = covering(rows, c["t"])
        ok = r is not None and is_cbl(r[2])
        res["swapAll"].add(ok)
        if c.get("optional"):
            continue
        res["swap"].add(ok)
        if c.get("kind") == "cbl":
            res["cbl"].add(ok)
    for s, e, m in rows:
        if s >= hi or e <= lo:
            continue
        has = any(s <= c["t"] < e for c in cbl)
        if is_cbl(m):
            res["cblRows"].add(has)
        res["rowAgree"].add(is_cbl(m) == has)
    for tr in gt.get("turns", []):
        if tr.get("by") != "follower" or not in_range(tr["t"]):
            continue
        r = covering(rows, tr["t"])
        res["turn"].add(r is not None and has_turn(r[2]))
    out = {k: v.as_dict() for k, v in res.items()}
    out["rows"] = sum(1 for s, e, _ in rows if s < hi and e > lo)
    out["phase"] = phase_stats(rows, [c["t"] for c in cbl], beat)
    if cv_swaps is not None:
        cvs = [t for t in cv_swaps if in_range(t)]
        out["cvPhase"] = phase_stats(rows, cvs, beat)
        out["cvPhase"]["inCblRow"] = sum(1 for t in cvs if (covering(rows, t) or (0, 0, {}))[2].get("move") in CBL_TYPES)
    return out


def cv_swaps_from(meas):
    ev = ((meas or {}).get("summary") or {}).get("events") or []
    return [e["t"] for e in ev if e.get("type") == "CBL" and _num(e.get("t"))]


def fmt(d):
    def r(k):
        x = d[k]
        return f"{x['hit']}/{x['n']} = {x['acc']}"
    lines = [
        f"  rows      {d['rows']}",
        f"  cbl       {r('cbl')}   （正解 CBL を覆う行が CBL 系）",
        f"  swap      {r('swap')}   swapAll {r('swapAll')}",
        f"  cblRows   {r('cblRows')}   （CBL 系の行に正解の入れ替わりがある）",
        f"  rowAgree  {r('rowAgree')}",
        f"  turn      {r('turn')}",
    ]
    for k in ("phase", "cvPhase"):
        p = d.get(k)
        if p:
            extra = f"  inCblRow={p['inCblRow']}" if "inCblRow" in p else ""
            lines.append(f"  {k:9s} n={p['n']} in57={p['in57']} R={p['R']} meanCount={p['meanCount']} hist={p['hist']}{extra}")
    return "\n".join(lines)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("result")
    a.add_argument("gt")
    a.add_argument("measurements", nargs="?")
    a.add_argument("--raw", action="store_true", help="routine.rawMoves を採点する")
    a.add_argument("--json", help="指標を JSON で書き出す")
    args = a.parse_args()
    with open(args.result, encoding="utf-8") as f:
        result = json.load(f)
    with open(args.gt, encoding="utf-8") as f:
        gt = json.load(f)
    meas = None
    if args.measurements:
        with open(args.measurements, encoding="utf-8") as f:
            meas = json.load(f)
    routine = result.get("routine") or {}
    moves = routine.get("rawMoves") if args.raw and routine.get("rawMoves") else routine.get("moves") or []
    grid = routine.get("grid") or {}
    beat = grid.get("beatSec") if _num(grid.get("beatSec")) else 60 / (routine.get("bpm") or 170)
    out = evaluate(moves, gt, beat, cv_swaps_from(meas) if meas else None)
    out["grid"] = grid
    print(f"grid={grid}")
    print(fmt(out))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
