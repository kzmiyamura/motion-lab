"""回帰評価ハーネス: 人手校正済みの正解表（ground_truth/*.json）と analyze_pair の出力を突き合わせる。

YOLO は回さない。各ジョブの out/measurements.tracks.json（骨格の原盤）から detect_events を
今のコードで計算し直すので、analyze_pair.py の検出ロジックを変えたら即座に前後比較できる。
--stored を付けると、ジョブが保存した measurements.json の events（全フレームで取り直した spin 込み）を採点する。

指標:
  events      CBL / 女性のターン / 男性のターン ごとの precision・recall（±MATCH_SEC で1対1対応）
  turnDir     対応したターンのうち向きが読めた正解に対する向きの正答率（主な向き = 回転数の最も多い run）
  rotations   対応したターンの回転数の誤差（rotations フィールド / spin の合計回転数）
  hold        正解時刻の手のつなぎ（男性の手・男女両方）
  pass        CBL の女性の奥行き（near/far）・通過側（side）・入れ替わり前の女性の側（from）
  handRaise   CBL で男性が手を頭上に上げたか

Usage: python eval_ground_truth.py [--stored] [--json out.json] [--verbose]
"""
import argparse
import glob
import hashlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze_pair as ap  # noqa: E402

# MOTION_LAB_STORAGE: 別の場所に写した storage を読む（worktree から本体の解析出力の写しを採点する等）
STORAGE_DIR = os.environ.get("MOTION_LAB_STORAGE") or os.path.join(HERE, "..", "storage")
JOBS_DIR = os.path.join(STORAGE_DIR, "analysis-jobs")
GT_DIR = os.path.join(HERE, "ground_truth")
MATCH_SEC = 1.0
# ターンの照合に使う検出の時刻（README 28）。正解表の t は、0.1 秒刻みで読み直した 3 本（2fda2815・8c312c6d・bb0efcb9）と
# 1230b3d5 は回転の真ん中（memo の範囲の 0.2〜0.62、中央値 0.50）、img1884・screenrec（2026-09 の連続フレームの校正）は
# 回り始めに付いている。検出の t は回り始め（女性: 最初の反転、男: 最初の 1 回転の中点）なので、
#   auto  正解表の turnTime（"mid" / "start"、無ければ start）に合わせる: mid なら検出の tMid（回転の範囲の真ん中）、start なら t
#   t     いつも検出の t（README 27 までの照合）
#   mid   いつも tMid
# どれも ±MATCH_SEC は同じ。CBL の照合は変えない
TURN_MATCH = "auto"


def turn_mid(e):
    """検出のターンの回転の範囲の真ん中: tMid、無ければ全フレームの取り直しの spin.from〜to、それも無ければ t"""
    if isinstance(e.get("tMid"), (int, float)):
        return e["tMid"]
    sp = e.get("spin") or {}
    if isinstance(sp.get("from"), (int, float)) and isinstance(sp.get("to"), (int, float)):
        return (sp["from"] + sp["to"]) / 2
    return e["t"]


def turn_time_key(gt, mode=None):
    """正解表と照合モードから、検出のターンの照合用の時刻を取る関数"""
    mode = mode or TURN_MATCH
    if mode == "auto":
        mode = "mid" if gt.get("turnTime") == "mid" else "t"
    return turn_mid if mode == "mid" else (lambda e: e["t"])


def out_dir(gt):
    """解析出力の置き場所。ジョブを経ずに analyze_pair を直接回した動画は outDir（storage からの相対）で指す"""
    if gt.get("outDir"):
        return os.path.join(STORAGE_DIR, gt["outDir"])
    return os.path.join(JOBS_DIR, gt["job"], "out")


def in_range(gt, t):
    """evalRange [開始, 終了]（秒）の内側か。録画停止時の画面などは範囲外にして採点しない"""
    lo, hi = gt.get("evalRange") or (float("-inf"), float("inf"))
    return lo <= t <= hi


RETRACK = False  # --retrack: 保存済み tracks の人物 ID を今のコードで付け直してから採点する


def _retrack_cache_path(gt, path):
    st = os.stat(path)
    base = os.environ.get("MOTION_LAB_RETRACK_CACHE") or os.path.join(tempfile.gettempdir(), "motion-lab-retrack")
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|{ap.IDENTITY_JOINT}".encode()).hexdigest()[:16]
    return os.path.join(base, f"{key}.json")


def load_tracks(gt):
    """tracks の原盤を読む。RETRACK なら人物 ID（pid）と男の pid を今の assign_appearance_ids で付け直す。
    ジョブが保存した tracks の pid は古い追跡のコードのもので、1230b3d5 は 16 秒で男女が入れ替わったまま戻らず、
    全編の 9 割が逆だった（README 31）。付け直しは動画を 1 回読む（YOLO は回さない）ので、結果は一時ディレクトリに
    置いて 2 回目から使う（MOTION_LAB_RETRACK_CACHE で場所を変えられる）。storage は書き換えない"""
    path = os.path.join(out_dir(gt), "measurements.tracks.json")
    data = json.load(open(path, encoding="utf-8"))
    if not RETRACK:
        return data
    video = os.path.join(STORAGE_DIR, "originals", data.get("video") or "")
    cache = _retrack_cache_path(gt, path)
    if os.path.exists(cache):
        c = json.load(open(cache, encoding="utf-8"))
    elif data.get("video") and os.path.exists(video):
        import update_events
        update_events.retrack(data, video)
        c = {"leaderPid": data["leaderPid"], "pids": [[p.get("pid") for p in f["kept"]] for f in data["frames"]]}
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        json.dump(c, open(cache, "w", encoding="utf-8"))
        return data
    else:
        print(f"  （動画が無いので付け直さない: {video}）")
        return data
    data["leaderPid"] = c["leaderPid"]
    for f, pids in zip(data["frames"], c["pids"]):
        for p, pid in zip(f["kept"], pids):
            if pid is None:
                p.pop("pid", None)
            else:
                p["pid"] = pid
    return data


def load_events(gt, stored, events_dir=None, name=None):
    out = out_dir(gt)
    if events_dir:
        # 外から渡した events（refine_events.py で取り直した measurements 等）。<events_dir>/<名前>.json の summary.events
        p = os.path.join(events_dir, f"{name}.json")
        if os.path.exists(p):
            m = json.load(open(p, encoding="utf-8"))
            return [e for e in m["summary"]["events"] if in_range(gt, e["t"])], None
    if stored:
        m = json.load(open(os.path.join(out, "measurements.json"), encoding="utf-8"))
        return [e for e in m["summary"]["events"] if in_range(gt, e["t"])], None
    data = load_tracks(gt)
    events = ap.apply_cbl_pass_half(ap.detect_events(data["frames"], data["leaderPid"]))
    return [e for e in events if in_range(gt, e["t"])], data


def match(gt_items, preds, key=None):
    """時刻の近い順に1対1で対応づける。key: 検出の照合用の時刻（既定は t）。戻り値: [(gt_index, pred_index)]"""
    key = key or (lambda e: e["t"])
    pairs = sorted(
        ((abs(g["t"] - key(p)), gi, pi) for gi, g in enumerate(gt_items) for pi, p in enumerate(preds)
         if abs(g["t"] - key(p)) <= MATCH_SEC),
        key=lambda x: x[0])
    used_g, used_p, out = set(), set(), []
    for _, gi, pi in pairs:
        if gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        out.append((gi, pi))
    return out


class Counter:
    def __init__(self):
        self.tp = self.fp = self.fn = 0

    def add(self, other):
        self.tp += other.tp
        self.fp += other.fp
        self.fn += other.fn

    def as_dict(self):
        p = self.tp / (self.tp + self.fp) if self.tp + self.fp else None
        r = self.tp / (self.tp + self.fn) if self.tp + self.fn else None
        f = 2 * p * r / (p + r) if p and r else None
        return {"tp": self.tp, "fp": self.fp, "fn": self.fn,
                "precision": _r(p), "recall": _r(r), "f1": _r(f)}


class Ratio:
    def __init__(self):
        self.hit = self.n = 0

    def add(self, ok):
        self.n += 1
        self.hit += bool(ok)

    def as_dict(self):
        return {"hit": self.hit, "n": self.n, "acc": _r(self.hit / self.n) if self.n else None}


def _r(x):
    return None if x is None else round(x, 3)


def score_events(gt_items, preds, count_fp=True, key=None):
    """optional な正解は、対応した検出を誤検出に数えず、見逃しても取りこぼしに数えない。
    count_fp=False は正解側が出来事を数え切れていない（turnsComplete: false）ときで、誤検出を数えない"""
    c = Counter()
    pairs = match(gt_items, preds, key)
    matched_g = {gi for gi, _ in pairs}
    matched_p = {pi for _, pi in pairs}
    for gi, _ in pairs:
        if not gt_items[gi].get("optional"):
            c.tp += 1
    c.fn += sum(1 for gi, g in enumerate(gt_items) if gi not in matched_g and not g.get("optional"))
    if count_fp:
        c.fp += sum(1 for pi in range(len(preds)) if pi not in matched_p)
    return c, pairs


def main_dir(runs):
    """runs のうち回転数の最も多い向き（向き不明は除く）"""
    known = [r for r in runs if r.get("dir")]
    if not known:
        return None
    return max(known, key=lambda r: r.get("turns") or 0)["dir"]


def pred_runs(e):
    sp = e.get("spin")
    if not sp:
        return []
    if sp.get("runs") is not None:
        return sp["runs"]
    return ap._spin_runs(sp.get("seq", ""))


def parse_hold(label):
    if not label:
        return None
    return ("L" if "リーダー左手" in label else "R", "L" if "フォロワー左手" in label else "R")


def gt_side(cbl):
    """正解の通過側。男性の向きは detect_pass_side と同じ「女性の方を向く」規則（正解10件で全一致した規則）"""
    if cbl.get("depth") is None or cbl.get("from") is None:
        return None
    hx = 1 if cbl["from"] == "right" else -1
    py = -1 if cbl["depth"] == "near" else 1
    return "left" if hx * py > 0 else "right"


def evaluate(gt, stored, verbose, events_dir=None, name=None):
    preds, data = load_events(gt, stored, events_dir, name)
    res = {"events": {}, "turnDir": Ratio(), "rotations": [], "spinTurns": [], "hold": {"leader": Ratio(), "both": Ratio()},
           "pass": {"depth": Ratio(), "side": Ratio(), "from": Ratio()}, "handRaise": Ratio()}
    log = []

    # CBL
    pc = [e for e in preds if e["type"] == "CBL"]
    c, pairs = score_events(gt["cbl"], pc)
    res["events"]["CBL"] = c
    for gi, pi in pairs:
        g, p = gt["cbl"][gi], pc[pi]
        ps = p.get("pass") or {}
        if g.get("depth"):
            res["pass"]["depth"].add(ps.get("followerDepth") == g["depth"])
        if gt_side(g):
            res["pass"]["side"].add(ps.get("side") == gt_side(g))
        if g.get("from"):
            res["pass"]["from"].add(ps.get("followerFrom") == g["from"])
        if g.get("leaderHandRaised") is not None:
            hr = p.get("handRaise") or {}
            res["handRaise"].add(bool(hr.get("raised")) == g["leaderHandRaised"])
            if bool(hr.get("raised")) != g["leaderHandRaised"]:
                log.append(f"  HR外れ gt {g['t']:5.1f} 正解={g['leaderHandRaised']} 予測={hr}")
        log.append(f"  CBL  gt {g['t']:5.1f} ↔ {p['t']:5.2f}  depth {g.get('depth')}/{ps.get('followerDepth')}"
                   f"  from {g.get('from')}/{ps.get('followerFrom')}  side {gt_side(g)}/{ps.get('side')}")
    log += [f"  CBL  見逃し {g['t']:5.1f} {g.get('memo', '')}" for gi, g in enumerate(gt["cbl"])
            if gi not in {a for a, _ in pairs} and not g.get("optional")]
    log += [f"  CBL  誤検出 {p['t']:5.2f}" for pi, p in enumerate(pc) if pi not in {b for _, b in pairs}]

    # ターン（女性 / 男性 別）。照合の時刻は正解表の turnTime に合わせる（TURN_MATCH、README 28）
    tkey = turn_time_key(gt)
    for by, key in (("follower", "Turn.follower"), ("leader", "Turn.leader")):
        g_items = [g for g in gt["turns"] if g["by"] == by]
        p_items = [e for e in preds if e["type"] == "Turn" and e["by"] == by]
        c, pairs = score_events(g_items, p_items, count_fp=gt.get("turnsComplete", True), key=tkey)
        res["events"][key] = c
        for gi, pi in pairs:
            g, p = g_items[gi], p_items[pi]
            gdir, pdir = main_dir(g["runs"]), main_dir(pred_runs(p))
            if gdir:
                res["turnDir"].add(pdir == gdir)
            gturns = sum(r["turns"] for r in g["runs"]) if all(r.get("turns") for r in g["runs"]) else None
            if gturns is not None and not g.get("optional"):
                res["rotations"].append(abs((p.get("rotations") or 1) - gturns))
                pr = pred_runs(p)
                if pr:
                    res["spinTurns"].append(abs(sum(r["turns"] for r in pr) - gturns))
            log.append(f"  Turn {by[0]} gt {g['t']:5.1f} ↔ {p['t']:5.2f} (mid {turn_mid(p):5.2f})  dir {gdir}/{pdir}"
                       f"  rot {gturns}/{p.get('rotations')}  spin {[(r['dir'][0], r['turns']) for r in pred_runs(p)]}")
        log += [f"  Turn {by[0]} 見逃し {g['t']:5.1f} {g.get('memo', '')}" for gi, g in enumerate(g_items)
                if gi not in {a for a, _ in pairs} and not g.get("optional")]
        log += [f"  Turn {by[0]} 誤検出 {p['t']:5.2f}" for pi, p in enumerate(p_items) if pi not in {b for _, b in pairs}]

    # ホールド（tracks の原盤から正解時刻で推定する。--stored でも原盤を読む）
    if data is None:
        data = load_tracks(gt)
    for h in gt["holds"]:
        if h.get("optional"):
            continue
        got = parse_hold(ap.detect_hold(data["frames"], h["t"], data["leaderPid"]))
        res["hold"]["leader"].add(got is not None and got[0] == h["leader"])
        if h.get("follower"):
            res["hold"]["both"].add(got == (h["leader"], h["follower"]))
    if verbose:
        print("\n".join(log))
    return res


def mae(xs):
    return _r(sum(xs) / len(xs)) if xs else None


def summarize(results):
    total = {"events": {}, "turnDir": Ratio(), "rotations": [], "spinTurns": [],
             "hold": {"leader": Ratio(), "both": Ratio()},
             "pass": {"depth": Ratio(), "side": Ratio(), "from": Ratio()}, "handRaise": Ratio()}
    for r in results:
        for k, c in r["events"].items():
            total["events"].setdefault(k, Counter()).add(c)
        for path in (("turnDir",), ("handRaise",), ("hold", "leader"), ("hold", "both"),
                     ("pass", "depth"), ("pass", "side"), ("pass", "from")):
            src, dst = r, total
            for p in path:
                src, dst = src[p], dst[p]
            dst.hit += src.hit
            dst.n += src.n
        total["rotations"] += r["rotations"]
        total["spinTurns"] += r["spinTurns"]
    return total


def to_dict(r):
    all_c = Counter()
    for c in r["events"].values():
        all_c.add(c)
    return {
        "events": {**{k: c.as_dict() for k, c in r["events"].items()}, "all": all_c.as_dict()},
        "turnDir": r["turnDir"].as_dict(),
        "rotationsMAE": {"rotationsField": mae(r["rotations"]), "spinRuns": mae(r["spinTurns"]),
                         "n": len(r["rotations"])},
        "hold": {k: v.as_dict() for k, v in r["hold"].items()},
        "pass": {k: v.as_dict() for k, v in r["pass"].items()},
        "handRaise": r["handRaise"].as_dict(),
    }


def fmt(d):
    lines = []
    for k, c in d["events"].items():
        lines.append(f"  {k:14s} P={c['precision']} R={c['recall']} F1={c['f1']}  (tp{c['tp']} fp{c['fp']} fn{c['fn']})")
    td, rm = d["turnDir"], d["rotationsMAE"]
    lines.append(f"  turnDir        {td['hit']}/{td['n']} = {td['acc']}")
    lines.append(f"  rotations MAE  field={rm['rotationsField']} spin={rm['spinRuns']} (n={rm['n']})")
    h = d["hold"]
    lines.append(f"  hold           男の手 {h['leader']['hit']}/{h['leader']['n']}  両方 {h['both']['hit']}/{h['both']['n']}")
    p = d["pass"]
    lines.append(f"  pass           depth {p['depth']['hit']}/{p['depth']['n']}  side {p['side']['hit']}/{p['side']['n']}"
                 f"  from {p['from']['hit']}/{p['from']['n']}")
    hr = d["handRaise"]
    lines.append(f"  handRaise      {hr['hit']}/{hr['n']}")
    return "\n".join(lines)


def main():
    ap_ = argparse.ArgumentParser()
    ap_.add_argument("--stored", action="store_true", help="保存済み measurements.json の events を採点する")
    ap_.add_argument("--events-dir", help="<dir>/<正解表の名前>.json の summary.events を採点する（無い動画は tracks から）")
    ap_.add_argument("--retrack", action="store_true", help="tracks の人物 ID を今のコードで付け直してから採点する（動画を読む。結果は一時ディレクトリに置く）")
    ap_.add_argument("--json", help="指標を JSON で書き出す（前後比較用）")
    ap_.add_argument("--verbose", "-v", action="store_true", help="1件ずつの対応・見逃し・誤検出を出す")
    ap_.add_argument("--turn-match", choices=("auto", "t", "mid"), default=None,
                     help="ターンの照合の時刻: auto = 正解表の turnTime に合わせる（既定）/ t = 検出の t（README 27 まで）/ mid = tMid")
    args = ap_.parse_args()
    global TURN_MATCH, RETRACK
    RETRACK = args.retrack
    if args.turn_match:
        TURN_MATCH = args.turn_match

    results, report = [], {"mode": "stored" if args.stored else "tracks", "matchSec": MATCH_SEC,
                           "turnMatch": TURN_MATCH, "videos": {}}
    for path in sorted(glob.glob(os.path.join(GT_DIR, "*.json"))):
        gt = json.load(open(path, encoding="utf-8"))
        name = os.path.splitext(os.path.basename(path))[0]
        print(f"== {name}")
        if not os.path.exists(os.path.join(out_dir(gt), "measurements.tracks.json")):
            print(f"  （解析出力が無いので飛ばす: {out_dir(gt)}）")
            report["videos"][name] = None
            continue
        r = evaluate(gt, args.stored, args.verbose, args.events_dir, name)
        results.append(r)
        report["videos"][name] = to_dict(r)
        print(fmt(report["videos"][name]))
    report["total"] = to_dict(summarize(results))
    print("== total")
    print(fmt(report["total"]))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
