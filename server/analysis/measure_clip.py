# クリップの実測: fps・観測率・フレーム間の飛び・足首高さ・ペア距離
# 使い方: python measure_clip.py <clip.json> [<clip.json> ...]
import json, sys, math, statistics as st

def pct(xs, p):
    if not xs: return float('nan')
    xs = sorted(xs)
    i = min(len(xs) - 1, max(0, int(round((len(xs) - 1) * p))))
    return xs[i]

def joints(person):
    j = person['j']
    return [(j[i*3], j[i*3+1], j[i*3+2]) for i in range(len(j)//3)]

def report(path):
    d = json.load(open(path, encoding='utf-8'))
    names = d['joints']
    fr = d['frames']
    print(f"\n=== {path.split('/')[-1]} ===")
    print(f"fps(meta)={d['fps']} frames={len(fr)} duration={d['duration']}")

    dts = [fr[i+1]['t'] - fr[i]['t'] for i in range(len(fr)-1)]
    print(f"dt: median={st.median(dts)*1000:.1f}ms -> 実fps={1/st.median(dts):.2f}")

    # 観測率（v==1.0 を実観測とみなす）
    for pid in sorted(fr[0]['p'].keys()):
        vs = [0]*len(names)
        n = 0
        for f in fr:
            p = f['p'].get(pid)
            if not p: continue
            n += 1
            for k, v in enumerate(p['v']):
                if v >= 0.99: vs[k] += 1
        line = ' '.join(f"{names[k]}={vs[k]/n*100:.0f}%" for k in range(len(names)))
        print(f"[p{pid}] 観測率 (n={n}): {line}")

    # フレーム間の飛び: ネイティブ vs 30fps 相当に間引いた場合
    def jump_stats(step):
        js = []
        for i in range(0, len(fr)-step, step):
            for pid in fr[i]['p']:
                a = fr[i]['p'].get(pid); b = fr[i+step]['p'].get(pid)
                if not a or not b: continue
                ja, jb = joints(a), joints(b)
                m = max(math.dist(ja[k], jb[k]) for k in range(len(ja)))
                js.append(m)
        return js

    native = jump_stats(1)
    # 30fps 相当（元が ~42fps なので 1.4 フレームおき ≈ 間引き比）
    k = max(1, round((1/st.median(dts)) / 30))
    dec = jump_stats(k)
    print(f"1フレームあたり最大関節移動 [m] ネイティブ: median={st.median(native):.3f} "
          f"p95={pct(native,0.95):.3f} max={max(native):.3f}")
    print(f"                            {k}フレーム間引き: median={st.median(dec):.3f} "
          f"p95={pct(dec,0.95):.3f} max={max(dec):.3f}")

    # 足首の高さ（靴を置く基準）
    ia = [names.index('lAnkle'), names.index('rAnkle')]
    ys = []
    for f in fr:
        for pid, p in f['p'].items():
            jj = joints(p)
            for i in ia: ys.append(jj[i][1])
    print(f"足首 y [m]: p05={pct(ys,0.05):.3f} median={st.median(ys):.3f} min={min(ys):.3f}")

    # つま先・かかとの最低高さ（靴底の当たり）
    for nm in ('lToe','rToe','lHeel','rHeel'):
        if nm in names:
            i = names.index(nm)
            v = [joints(p)[i][1] for f in fr for p in f['p'].values()]
            print(f"  {nm}: p05={pct(v,0.05):.3f} median={st.median(v):.3f} min={min(v):.3f}")

    # ペア距離（腰中点）
    ih = [names.index('lHip'), names.index('rHip')]
    ds = []
    for f in fr:
        ps = list(f['p'].values())
        if len(ps) < 2: continue
        mids = []
        for p in ps:
            jj = joints(p)
            a, b = jj[ih[0]], jj[ih[1]]
            mids.append(((a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2))
        ds.append(math.dist(mids[0], mids[1]))
    print(f"ペア距離 [m]: min={min(ds):.3f} p05={pct(ds,0.05):.3f} median={st.median(ds):.3f} "
          f"p95={pct(ds,0.95):.3f} max={max(ds):.3f}")

for p in sys.argv[1:]:
    report(p)
