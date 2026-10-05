#!/usr/bin/env python3
"""
振付シート（result.json の routine.moves）を正解表の全動画でまとめて採点する（eval_routine_grid.py の複数動画版）。

各動画で routine の入った最新の done ジョブ（DB の analysis_jobs）を自動で選ぶ。`--job 名前=ジョブID` で個別に指定できる。
正解表の名前（ファイル名）と動画 ID の対応は、正解表の `job` / `outDir` からではなく DB の videos で引く
（正解表の job は tracks の採点用に古いジョブを指したままのことがあるため）。

指標（eval_routine_grid と同じ）: cbl / swap / cblRows / rowAgree / turn
追加:
  dir   正解の女性のターン（向きが分かるもの）を覆う行の turn.direction が正解の主な向きと合うか
        （行にターンが無い・向きが無いものは外れ。ターンの行かどうかは turn で測っている）
  rot   上の行のうち回転数が分かるものの、回転数の誤差の平均（|行の rotations − 正解の合計回転数|）
  side  正解の入れ替わり（optional でない）を覆う CBL 系の行で、その入れ替わりの前の側が正解の from と合うか。
        前の側 = sides.followerStart を、同じ行の中でこの入れ替わりより前にある正解の入れ替わり（optional 含む）の数だけ反転したもの
        （1 行に入れ替わりが 2 回ある行の 2 回目は逆の側から通る。2026-10-05 まではいつも followerStart と比べていて、2 回目は必ず外れていた）
  sideStart  上の旧い決まり（いつも sides.followerStart と比べる。前後比較用）
  count     正解の通過（入れ替わり）が覆う行のカウント 1.5〜3.5 に来た割合（カウント位相。eval_routine_grid.count_phase。
            bias = 通過の平均カウント − 2.5 の拍数。+ なら行の頭が遅い）
  turnPrec  女性のターンのある行のうち、正解の女性のターン（optional 含む）が入っている行の割合（turnsComplete の動画だけ）

Usage: python eval_routine_set.py [--job screenrec=<jobId> ...] [--jobs-dir <dir>] [--db <motionlab.db>] [--json out.json] [--verbose]
"""
import argparse
import glob
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from eval_routine_grid import evaluate, cv_swaps_from, rows_with_end, covering, is_cbl, has_turn, _num  # noqa: E402

SERVER = os.path.join(HERE, "..")
JOBS_DIR = os.path.join(os.environ.get("MOTION_LAB_STORAGE") or os.path.join(SERVER, "storage"), "analysis-jobs")
GT_DIR = os.path.join(HERE, "ground_truth")
# MOTION_LAB_DB: 別の場所の DB を読む（worktree から本体の DB を引く等。--db でも指定できる）
DB_PATH = os.environ.get("MOTION_LAB_DB") or os.path.join(SERVER, "data", "motionlab.db")

# 正解表の名前 → 動画 ID の先頭（名前が ID の先頭 8 桁でないもの）
NAME_TO_VIDEO = {"img1884": "d5e96a5b", "screenrec": "cb822fe5"}
FLIP_SIDE = {"left": "right", "right": "left"}


def main_dir(runs):
    known = [r for r in runs or [] if r.get("dir")]
    if not known:
        return None
    return max(known, key=lambda r: r.get("turns") or 0)["dir"]


def total_turns(runs):
    vals = [r.get("turns") for r in runs or []]
    if not vals or any(not _num(v) for v in vals):
        return None
    return sum(vals)


def latest_routine_job(db, video_prefix):
    rows = db.execute(
        "SELECT j.id FROM analysis_jobs j WHERE j.video_id LIKE ? AND j.status = 'done' ORDER BY j.created_at DESC",
        (video_prefix + "%",),
    ).fetchall()
    for (jid,) in rows:
        p = os.path.join(JOBS_DIR, jid, "out", "result.json")
        if os.path.exists(p):
            r = json.load(open(p, encoding="utf-8"))
            if (r.get("routine") or {}).get("moves"):
                return jid
    return None


def extra_checks(moves, gt, beat, verbose):
    lo, hi = gt.get("evalRange") or (float("-inf"), float("inf"))
    rows = rows_with_end(moves, beat)
    d = {"hit": 0, "n": 0}
    rot_err = []
    side = {"hit": 0, "n": 0}
    for tr in gt.get("turns", []):
        if tr.get("by") != "follower" or tr.get("optional") or not lo <= tr["t"] <= hi:
            continue
        gdir = main_dir(tr.get("runs"))
        r = covering(rows, tr["t"])
        turn = (r[2].get("turn") if r else None) or {}
        pdir = turn.get("direction")
        if gdir:
            d["n"] += 1
            d["hit"] += pdir == gdir
        gt_rot = total_turns(tr.get("runs"))
        if gt_rot is not None and _num(turn.get("rotations")):
            rot_err.append(abs(turn["rotations"] - gt_rot))
        if verbose:
            print(f"    turn {tr['t']:6.2f} gt={gdir}/{gt_rot}  row={r[0] if r else None} {r[2].get('move') if r else None}"
                  f" dir={pdir} rot={turn.get('rotations')}")
    side_start = {"hit": 0, "n": 0}
    for c in gt.get("cbl", []):
        if c.get("optional") or not lo <= c["t"] <= hi or not c.get("from"):
            continue
        r = covering(rows, c["t"])
        if r is None or not is_cbl(r[2]):
            continue
        fs = (r[2].get("sides") or {}).get("followerStart")
        side_start["n"] += 1
        side_start["hit"] += fs == c["from"]
        # 1 行に入れ替わりが 2 回以上あるとき、k 回目の入れ替わりの前の側は行の始まりの側を k−1 回入れ替えたもの
        # （行の中の正解の入れ替わり（optional 含む）のうち、この入れ替わりより前のものの数だけ反転する）
        k = sum(1 for o in gt.get("cbl", []) if o is not c and r[0] <= o["t"] < c["t"])
        exp = fs if k % 2 == 0 else FLIP_SIDE.get(fs)
        side["n"] += 1
        side["hit"] += exp == c["from"]
    # turnPrec: 女性のターンのある行のうち、正解の女性のターン（optional 含む）が入っている行の割合。
    # 正解表がターンを全部拾っている動画（turnsComplete が false でない）だけ数える
    tp = {"hit": 0, "n": 0}
    if gt.get("turnsComplete", True):
        gturns = [tr["t"] for tr in gt.get("turns", []) if tr.get("by") == "follower"]
        for s, e, m in rows:
            if s >= hi or e <= lo or not has_turn(m):
                continue
            tp["n"] += 1
            tp["hit"] += any(s <= t < e for t in gturns)
            if verbose and not any(s <= t < e for t in gturns):
                print(f"    turnFP row {s:6.2f} {m.get('move')} {m.get('name')}")
    acc = lambda x: round(x["hit"] / x["n"], 3) if x["n"] else None  # noqa: E731
    return {
        "turnPrec": {**tp, "acc": acc(tp)},
        "dir": {**d, "acc": acc(d)},
        "rot": {"n": len(rot_err), "meanAbsErr": round(sum(rot_err) / len(rot_err), 3) if rot_err else None},
        "side": {**side, "acc": acc(side)},
        "sideStart": {**side_start, "acc": acc(side_start)},
    }


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--job", action="append", default=[], help="名前=ジョブID（既定は routine の入った最新のジョブ）")
    a.add_argument("--json", help="指標を JSON で書き出す")
    a.add_argument("--jobs-dir", help="result.json / measurements.json をこの下の <ジョブID>/out から読む（正規化し直した写しの採点用。ジョブの選び方は同じ）")
    a.add_argument("--db", default=DB_PATH, help="ジョブを選ぶ DB（全部の動画を --job で指定すれば無くてよい）")
    a.add_argument("--verbose", "-v", action="store_true")
    args = a.parse_args()
    forced = dict(x.split("=", 1) for x in args.job)
    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True) if os.path.exists(args.db) else None
    report = {}
    keys = ("cbl", "swap", "cblRows", "rowAgree", "turn")
    tot = {k: [0, 0] for k in keys + ("dir", "side", "sideStart", "turnPrec", "count")}
    rot_all = []
    print(f"{'video':10s} {'job':8s} rows  " + "  ".join(f"{k:>9s}" for k in keys) + "      dir     side  turnPrec  rotErr")
    for path in sorted(glob.glob(os.path.join(GT_DIR, "*.json"))):
        name = os.path.splitext(os.path.basename(path))[0]
        gt = json.load(open(path, encoding="utf-8"))
        jid = forced.get(name) or (latest_routine_job(db, NAME_TO_VIDEO.get(name, name)) if db else None)
        if not jid:
            print(f"{name:10s} （routine の入ったジョブが無い）")
            report[name] = None
            continue
        out = os.path.join(args.jobs_dir or JOBS_DIR, jid, "out")
        res = json.load(open(os.path.join(out, "result.json"), encoding="utf-8"))
        meas_p = os.path.join(out, "measurements.json")
        meas = json.load(open(meas_p, encoding="utf-8")) if os.path.exists(meas_p) else None
        routine = res["routine"]
        grid = routine.get("grid") or {}
        beat = grid.get("beatSec") if _num(grid.get("beatSec")) else 60 / (routine.get("bpm") or 170)
        if args.verbose:
            print(f"== {name} {jid}")
        ev = evaluate(routine["moves"], gt, beat, cv_swaps_from(meas) if meas else None)
        ev.update(extra_checks(routine["moves"], gt, beat, args.verbose))
        ev["job"] = jid
        report[name] = ev
        cp = ev["countPhase"]
        ev["count"] = {"hit": cp["ok"], "n": cp["n"], "acc": cp["acc"]}
        for k in keys + ("dir", "side", "sideStart", "turnPrec", "count"):
            tot[k][0] += ev[k]["hit"]
            tot[k][1] += ev[k]["n"]
        if ev["rot"]["meanAbsErr"] is not None:
            rot_all += [ev["rot"]["meanAbsErr"]] * ev["rot"]["n"]
        cell = lambda x: f"{x['hit']:>2}/{x['n']:<2}={x['acc'] if x['acc'] is not None else '-':<5}"  # noqa: E731
        print(f"{name:10s} {jid[:8]} {ev['rows']:4d}  " + " ".join(cell(ev[k]) for k in keys)
              + f" {cell(ev['dir'])} {cell(ev['side'])} {cell(ev['turnPrec'])} {cell(ev['count'])} bias={cp['bias']} {ev['rot']['meanAbsErr']} (n={ev['rot']['n']})")
    total = {k: {"hit": h, "n": n, "acc": round(h / n, 3) if n else None} for k, (h, n) in tot.items()}
    total["rot"] = {"n": len(rot_all), "meanAbsErr": round(sum(rot_all) / len(rot_all), 3) if rot_all else None}
    report["total"] = total
    print("total      " + " ".join(f"{k}={v['hit']}/{v['n']}={v['acc']}" for k, v in total.items() if k != "rot")
          + f" rotErr={total['rot']['meanAbsErr']} (n={total['rot']['n']})")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
