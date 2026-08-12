# 手首の実観測が「リグの目標として使えるか」を測る。
#  - 肩からの距離（腕の長さに収まるか＝人体として成立するか）
#  - 欠測の穴の長さ（速度ベクトルで何秒ぶん外挿すれば足りるか）
#  - 1フレームあたりの移動量（外挿の暴れ具合）
import json, sys, math, statistics as st

def pct(xs, p):
    xs = sorted(xs); i = min(len(xs)-1, max(0, int(round((len(xs)-1)*p)))); return xs[i]

d = json.load(open(sys.argv[1], encoding='utf-8'))
N = d['joints']; fr = d['frames']
I = {n: i for i, n in enumerate(N)}

for pid in sorted(fr[0]['p'].keys()):
    print(f"\n--- person {pid} ---")
    for side, (sh, wr, el) in (('L', ('lShoulder', 'lWrist', 'lElbow')),
                               ('R', ('rShoulder', 'rWrist', 'rElbow'))):
        reach, gaps, jump = [], [], []
        run = 0
        prev = None
        for f in fr:
            p = f['p'].get(pid)
            if not p:
                continue
            v, j = p['v'], p['j']
            ok = v[I[wr]] >= 0.99
            if ok:
                if run:
                    gaps.append(run); run = 0
                w = [j[I[wr]*3+c] for c in range(3)]
                s = [j[I[sh]*3+c] for c in range(3)]
                reach.append(math.dist(w, s))
                if prev is not None:
                    jump.append(math.dist(w, prev))
                prev = w
            else:
                run += 1
                prev = None
        if run: gaps.append(run)
        if not reach: continue
        fps = 1/st.median([fr[i+1]['t']-fr[i]['t'] for i in range(len(fr)-1)])
        print(f"{side}: 実観測 {len(reach)}f  肩からの距離[m] median={st.median(reach):.3f} "
              f"p05={pct(reach,0.05):.3f} p95={pct(reach,0.95):.3f} max={max(reach):.3f}")
        print(f"    欠測の穴[f] median={st.median(gaps):.0f} p90={pct(gaps,0.9):.0f} "
              f"max={max(gaps):.0f}  (= {st.median(gaps)/fps*1000:.0f}ms / "
              f"{pct(gaps,0.9)/fps*1000:.0f}ms / {max(gaps)/fps:.1f}s)")
        print(f"    連続観測中の1f移動[m] median={st.median(jump):.3f} p95={pct(jump,0.95):.3f} "
              f"max={max(jump):.3f}")
