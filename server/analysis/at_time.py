# 指定時刻の2人の腰中点・肩幅・向きを出す（元動画の見え方と突き合わせるため）
import json, sys, math

d = json.load(open(sys.argv[1], encoding='utf-8'))
N = d['joints']; I = {n: i for i, n in enumerate(N)}
fr = d['frames']
for t in [float(x) for x in sys.argv[2:]]:
    f = min(fr, key=lambda f: abs(f['t'] - t))
    print(f"\n=== t={f['t']:.3f} (要求 {t}) leaderPid={d['leaderPid']}")
    mids = {}
    for pid, p in sorted(f['p'].items()):
        j = p['j']
        g = lambda n: [j[I[n]*3+c] for c in range(3)]
        lh, rh, ls, rs = g('lHip'), g('rHip'), g('lShoulder'), g('rShoulder')
        mid = [(lh[c]+rh[c])/2 for c in range(3)]
        mids[pid] = mid
        yaw = math.degrees(math.atan2(rh[2]-lh[2], -(rh[0]-lh[0])))
        sw = math.dist(ls, rs)
        print(f"  p{pid}: 腰中点 x={mid[0]:+.3f} y={mid[1]:.3f} z={mid[2]:+.3f} "
              f"肩幅={sw:.3f} 向き={yaw:+.0f}deg "
              f"手首可視 L={p['v'][I['lWrist']]:.1f} R={p['v'][I['rWrist']]:.1f}")
    a, b = mids['0'], mids['1']
    print(f"  差: dx={b[0]-a[0]:+.3f} dy={b[1]-a[1]:+.3f} dz={b[2]-a[2]:+.3f} "
          f"距離={math.dist(a,b):.3f}")
