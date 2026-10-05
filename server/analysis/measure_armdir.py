"""腕・手・顔の動きから回る向きを読む手がかりの当たり率を、正解のあるターンで測る（README 36）。
使い方: MOTION_LAB_STORAGE=<storage> python server/analysis/measure_armdir.py"""
import glob, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MOTION_LAB_TURN_SEGMENTS", "1")
import eval_ground_truth as eg
import analyze_pair as ap
eg.RETRACK = True
CONF = 0.3


def cross(frames, pid, lo, hi, getter, partner=None):
    """sum(u*dw - w*du) over consecutive usable samples. u = shDx (turner), w = getter(p) - shoulder mid x"""
    rows = []
    for df in frames:
        if not (lo <= df["t"] <= hi):
            continue
        p = next((q for q in df["kept"] if q.get("pid") == pid), None)
        if not p or not p.get("kps"):
            continue
        k = p["kps"]
        if min(k[5][2], k[6][2]) < CONF:
            continue
        mid = (k[5][0] + k[6][0]) / 2
        if partner is not None:
            o = next((q for q in df["kept"] if q.get("pid") == partner), None)
            ws = getter(o["kps"]) if o and o.get("kps") else None
        else:
            ws = getter(k)
        if ws is None:
            continue
        rows.append((df["t"], p["shDx"], ws - mid))
    c = tot = 0.0
    n = 0
    for (t0, u0, w0), (t1, u1, w1) in zip(rows, rows[1:]):
        if t1 - t0 > 0.25:
            continue
        v = u0 * (w1 - w0) - w0 * (u1 - u0)
        c += v
        tot += abs(v)
        n += 1
    return c, tot, n


def mk(idx):
    def g(k):
        return k[idx][0] if k[idx][2] >= CONF else None
    return g


def mk2(i, j):
    def g(k):
        if k[i][2] >= CONF and k[j][2] >= CONF:
            return (k[i][0] + k[j][0]) / 2
        return None
    return g


def raised(idx, sh):
    def g(k):
        return k[idx][0] if k[idx][2] >= CONF and k[idx][1] < k[sh][1] else None
    return g


CUES = {
    "nose": lambda k: mk(0)(k),
    "wristL": mk(9), "wristR": mk(10),
    "elbowL": mk(7), "elbowR": mk(8),
    "wristUpL": raised(9, 5), "wristUpR": raised(10, 6),
}

rows_out = []
for path in sorted(glob.glob(os.path.join(eg.GT_DIR, "*.json"))):
    gt = json.load(open(path, encoding="utf-8"))
    name = os.path.splitext(os.path.basename(path))[0]
    if not os.path.exists(os.path.join(eg.out_dir(gt), "measurements.tracks.json")):
        continue
    data = eg.load_tracks(gt)
    frames, lp = data["frames"], data["leaderPid"]
    preds = [e for e in ap.detect_events(frames, lp) if eg.in_range(gt, e["t"])]
    tkey = eg.turn_time_key(gt)
    for by in ("follower", "leader"):
        g_items = [g for g in gt["turns"] if g["by"] == by]
        p_items = [e for e in preds if e["type"] == "Turn" and e["by"] == by]
        for gi, pi in eg.match(g_items, p_items, tkey):
            g, p = g_items[gi], p_items[pi]
            gdir = eg.main_dir(g["runs"])
            if not gdir:
                continue
            sp = p.get("span") or {}
            lo, hi = (sp.get("from", p["t"]) - 0.25, sp.get("to", p["t"]) + 0.25)
            pid = lp if by == "leader" else 1 - lp
            partner = 1 - pid
            r = {"vid": name, "by": by, "gt_t": g["t"], "gdir": gdir, "pdir": eg.main_dir(eg.pred_runs(p)), "cues": {}}
            for cn, fn in CUES.items():
                r["cues"][cn] = cross(frames, pid, lo, hi, fn)
            r["cues"]["pwristL"] = cross(frames, pid, lo, hi, mk(9), partner)
            r["cues"]["pwristR"] = cross(frames, pid, lo, hi, mk(10), partner)
            rows_out.append(r)

names = list(rows_out[0]["cues"].keys())
print("vid by gt_t gdir pdir | " + " ".join(names))
for r in rows_out:
    s = []
    for cn in names:
        c, tot, n = r["cues"][cn]
        sc = -c  # >0 => right turn
        d = "-" if n < 2 or tot == 0 else ("R" if sc > 0 else "L")
        s.append(f"{d}{abs(c)/tot if tot else 0:.1f}/{n}")
    print(r["vid"], r["by"][0], r["gt_t"], r["gdir"][0], (r["pdir"] or "?")[0], "|", " ".join(s))

for by in ("follower", "leader"):
    print("== accuracy", by)
    for cn in names + ["wrists(L+R)", "wristsUp", "elbows"]:
        hit = n = silent = 0
        for r in rows_out:
            if r["by"] != by:
                continue
            if cn == "wrists(L+R)":
                parts = ["wristL", "wristR"]
            elif cn == "wristsUp":
                parts = ["wristUpL", "wristUpR"]
            elif cn == "elbows":
                parts = ["elbowL", "elbowR"]
            else:
                parts = [cn]
            c = sum(r["cues"][x][0] for x in parts)
            tot = sum(r["cues"][x][1] for x in parts)
            nn = sum(r["cues"][x][2] for x in parts)
            if nn < 2 or tot == 0:
                silent += 1
                continue
            n += 1
            hit += ((-c > 0) == (r["gdir"] == "right"))
        print(f"  {cn:12s} hit {hit}/{n} silent {silent}")
