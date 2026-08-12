# 30fps にしていたら失われていた動きの量を測る。
# ネイティブfpsのクリップを 30fps に間引き → 線形補間でネイティブの時刻へ戻し →
# 本物の観測との差を出す（= 30fps 書き出しが取りこぼしていた分）。
import json, sys, math, statistics as st

def pct(xs, p):
    xs = sorted(xs)
    i = min(len(xs)-1, max(0, int(round((len(xs)-1)*p))))
    return xs[i]

def report(path):
    d = json.load(open(path, encoding='utf-8'))
    fr = d['frames']
    names = d['joints']
    ts = [f['t'] for f in fr]
    fps = 1/st.median([ts[i+1]-ts[i] for i in range(len(ts)-1)])

    # 30fps で採ったであろうフレーム（各 1/30 秒に最も近い実フレーム）
    keep = sorted({min(range(len(ts)), key=lambda i: abs(ts[i]-k/30.0))
                   for k in range(int(d['duration']*30)+1)})
    kset = set(keep)

    err = {}   # pid -> list of per-joint error
    wrist_err = []
    for a, b in zip(keep, keep[1:]):
        for i in range(a+1, b):           # 間引きで消えた実フレーム
            u = (ts[i]-ts[a])/(ts[b]-ts[a])
            for pid, p in fr[i]['p'].items():
                pa, pb = fr[a]['p'].get(pid), fr[b]['p'].get(pid)
                if not pa or not pb: continue
                for k in range(len(names)):
                    x = [pa['j'][k*3+c]*(1-u) + pb['j'][k*3+c]*u for c in range(3)]
                    e = math.dist(x, p['j'][k*3:k*3+3])
                    err.setdefault(names[k], []).append(e)

    allv = [e for v in err.values() for e in v]
    print(f"\n=== {path.split('/')[-1]} ===")
    print(f"実fps={fps:.2f} 実フレーム={len(fr)}  30fpsなら={len(keep)} "
          f"（捨てていた実観測 {len(fr)-len(keep)} フレーム = {100*(1-len(keep)/len(fr)):.0f}%）")
    print(f"30fps→線形補間 の誤差 [m] 全関節: median={st.median(allv):.3f} "
          f"p95={pct(allv,0.95):.3f} max={max(allv):.3f}")
    for nm in ('lWrist','rWrist','lAnkle','rAnkle','lToe','nose'):
        if nm in err:
            v = err[nm]
            print(f"  {nm}: median={st.median(v):.3f} p95={pct(v,0.95):.3f} max={max(v):.3f}")

for p in sys.argv[1:]:
    report(p)
