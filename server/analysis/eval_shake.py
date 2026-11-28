"""揺らし検査の簡易版（README 19 の j1/j2/d1/d2 に相当）。

ジョブの measurements.tracks.json（骨格の原盤）の導出値に小さな揺れを掛けて detect_events を回し、揺らす前の events との
食い違い（種類と人が同じで ±MATCH_SEC 以内に相手の無いもの。双方向）を数える。検出ロジックの変更が「出来事の出現の安定さ」を
落とさないかを見る（README 23 の採用基準: 食い違いが増えない）。

  j1 / j2  shDx・hipX・wrists に枠の大きさの 1.5%（標準偏差）の正規ノイズ（シード 1 / 2。x は枠の幅、y は枠の高さ基準）
  d1 / d2  コマを 2% 落とす（シード 1 / 2）

README 19 の元の検査との違い: YOLO や外見の追跡は回さない（人物 ID は tracks のまま固定）ので、枠・骨格そのものを動かした j1/j2 の
再現ではなく導出値へのノイズ、(fix) = 二重検出を除いて YOLO から回し直した検出は再現しない。数字は当時のものと比べず、
同じコードの前後（設定を変えた 2 回）を比べるのに使う。

Usage（server/ で）:
  python analysis/eval_shake.py [--set TURN_REARM_RATIO=0.5 ...] [--names 8c312c6d,img1884] [--json out.json]
--set NAME=VALUE: analyze_pair の定数を上書きして回す（前後比較用。VALUE は数値・True/False）。
MOTION_LAB_STORAGE で eval_ground_truth と同じく別の storage を読める。
"""
import argparse
import glob
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze_pair as ap  # noqa: E402
import eval_ground_truth as eg  # noqa: E402

NOISE = 0.015
DROP = 0.02
MATCH_SEC = 0.5
TAGS = (("j1", "j", 1), ("j2", "j", 2), ("d1", "d", 1), ("d2", "d", 2))


def perturb(frames, mode, seed):
    """frames（tracks の draw_frames）を揺らした写しを返す。元は変えない"""
    rnd = random.Random(seed)
    out = []
    for f in frames:
        if mode == "d" and rnd.random() < DROP:
            continue
        g = dict(f)
        g["kept"] = []
        for p in f["kept"]:
            q = dict(p)
            if mode == "j":
                x0, y0, x1, y1 = p.get("bbox") or (0, 0, 0.25, 0.25)
                sx, sy = NOISE * max(abs(x1 - x0), 1e-3), NOISE * max(abs(y1 - y0), 1e-3)
                q["shDx"] = p["shDx"] + rnd.gauss(0, sx)
                q["hipX"] = p["hipX"] + rnd.gauss(0, sx)
                q["wrists"] = {k: ([v[0] + rnd.gauss(0, sx), v[1] + rnd.gauss(0, sy)] if v else v)
                               for k, v in (p.get("wrists") or {}).items()}
            g["kept"].append(q)
        out.append(g)
    return out


def events_of(data, frames):
    return ap.apply_cbl_pass_half(ap.detect_events(frames, data["leaderPid"]))


def mismatches(a, b):
    """a と b で、種類と人が同じ ±MATCH_SEC 以内に相手の無い events の数（双方向）"""
    def key(e):
        return (e["type"], e.get("by"))

    def lone(xs, ys):
        return sum(1 for e in xs if not any(key(y) == key(e) and abs(y["t"] - e["t"]) <= MATCH_SEC for y in ys))
    return lone(a, b) + lone(b, a)


def parse_value(v):
    if v in ("True", "False"):
        return v == "True"
    try:
        return int(v)
    except ValueError:
        return float(v)


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--set", action="append", default=[], help="analyze_pair の定数を上書き（NAME=VALUE）")
    a.add_argument("--names", help="正解表の名前（カンマ区切り。既定は全部）")
    a.add_argument("--json", help="結果を JSON で書き出す")
    args = a.parse_args()
    for kv in args.set:
        k, v = kv.split("=", 1)
        if not hasattr(ap, k):
            sys.exit(f"analyze_pair に {k} が無い")
        setattr(ap, k, parse_value(v))
    names = args.names.split(",") if args.names else sorted(
        os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(eg.GT_DIR, "*.json")))
    total = {t: 0 for t, _, _ in TAGS}
    per = {}
    for nm in names:
        gt = json.load(open(os.path.join(eg.GT_DIR, nm + ".json"), encoding="utf-8"))
        if not os.path.exists(os.path.join(eg.out_dir(gt), "measurements.tracks.json")):
            print(f"  （tracks が無いので飛ばす: {nm}）")
            continue
        data = eg.load_tracks(gt)
        base = events_of(data, data["frames"])
        per[nm] = {}
        for tag, mode, seed in TAGS:
            per[nm][tag] = mismatches(base, events_of(data, perturb(data["frames"], mode, seed)))
            total[tag] += per[nm][tag]
    s = sum(total.values())
    for nm, r in per.items():
        print(f"  {nm:10s} " + " ".join(f"{t}={r[t]:2d}" for t, _, _ in TAGS) + f"  計 {sum(r.values())}")
    print("  合計      " + " ".join(f"{t}={total[t]:2d}" for t, _, _ in TAGS) + f"  計 {s}  （食い違い。少ないほど安定）")
    if args.json:
        json.dump({"set": args.set, "perVideo": per, "total": total, "sum": s}, open(args.json, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
