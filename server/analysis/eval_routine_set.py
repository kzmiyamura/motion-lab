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
  side  正解の入れ替わり（optional でない）を覆う CBL 系の行の sides.followerStart が正解の from と合うか

Usage: python eval_routine_set.py [--job screenrec=<jobId> ...] [--jobs-dir <dir>] [--json out.json] [--verbose]
"""
import argparse
import glob
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from eval_routine_grid import evaluate, cv_swaps_from, rows_with_end, covering, is_cbl, _num  # noqa: E402

SERVER = os.path.join(HERE, "..")
JOBS_DIR = os.path.join(SERVER, "storage", "analysis-jobs")
GT_DIR = os.path.join(HERE, "ground_truth")
DB_PATH = os.path.join(SERVER, "data", "motionlab.db")

# 正解表の名前 → 動画 ID の先頭（名前が ID の先頭 8 桁でないもの）
NAME_TO_VIDEO = {"img1884": "d5e96a5b", "screenrec": "cb822fe5"}


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
    for c in gt.get("cbl", []):
        if c.get("optional") or not lo <= c["t"] <= hi or not c.get("from"):
            continue
        r = covering(rows, c["t"])
        if r is None or not is_cbl(r[2]):
            continue
        fs = (r[2].get("sides") or {}).get("followerStart")
        side["n"] += 1
        side["hit"] += fs == c["from"]
    acc = lambda x: round(x["hit"] / x["n"], 3) if x["n"] else None  # noqa: E731
    return {
        "dir": {**d, "acc": acc(d)},
        "rot": {"n": len(rot_err), "meanAbsErr": round(sum(rot_err) / len(rot_err), 3) if rot_err else None},
        "side": {**side, "acc": acc(side)},
    }


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--job", action="append", default=[], help="名前=ジョブID（既定は routine の入った最新のジョブ）")
    a.add_argument("--json", help="指標を JSON で書き出す")
    a.add_argument("--jobs-dir", help="result.json / measurements.json をこの下の <ジョブID>/out から読む（正規化し直した写しの採点用。ジョブの選び方は同じ）")
    a.add_argument("--verbose", "-v", action="store_true")
    args = a.parse_args()
    forced = dict(x.split("=", 1) for x in args.job)
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    report = {}
    keys = ("cbl", "swap", "cblRows", "rowAgree", "turn")
    tot = {k: [0, 0] for k in keys + ("dir", "side")}
    rot_all = []
    print(f"{'video':10s} {'job':8s} rows  " + "  ".join(f"{k:>9s}" for k in keys) + "      dir     side  rotErr")
    for path in sorted(glob.glob(os.path.join(GT_DIR, "*.json"))):
        name = os.path.splitext(os.path.basename(path))[0]
        gt = json.load(open(path, encoding="utf-8"))
        jid = forced.get(name) or latest_routine_job(db, NAME_TO_VIDEO.get(name, name))
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
        for k in keys + ("dir", "side"):
            tot[k][0] += ev[k]["hit"]
            tot[k][1] += ev[k]["n"]
        if ev["rot"]["meanAbsErr"] is not None:
            rot_all += [ev["rot"]["meanAbsErr"]] * ev["rot"]["n"]
        cell = lambda x: f"{x['hit']:>2}/{x['n']:<2}={x['acc'] if x['acc'] is not None else '-':<5}"  # noqa: E731
        print(f"{name:10s} {jid[:8]} {ev['rows']:4d}  " + " ".join(cell(ev[k]) for k in keys)
              + f" {cell(ev['dir'])} {cell(ev['side'])} {ev['rot']['meanAbsErr']} (n={ev['rot']['n']})")
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
