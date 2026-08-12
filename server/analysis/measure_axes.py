# 2人の位置関係が「左右（画面X）」で出ているか「奥行き（Z）」で出ているかを測る。
# 元動画では2人は横に並んで見えるので、Zばかり大きいなら弱透視の奥行き誤差。
import json, sys, math, statistics as st

def pct(xs, p):
    xs = sorted(xs); i = min(len(xs)-1, max(0, int(round((len(xs)-1)*p)))); return xs[i]

d = json.load(open(sys.argv[1], encoding='utf-8'))
names = d['joints']; fr = d['frames']
ih = [names.index('lHip'), names.index('rHip')]

dx, dz, dy = [], [], []
for f in fr:
    ps = list(f['p'].values())
    if len(ps) < 2: continue
    mid = []
    for p in ps:
        j = p['j']
        a = [j[ih[0]*3+c] for c in range(3)]
        b = [j[ih[1]*3+c] for c in range(3)]
        mid.append([(a[c]+b[c])/2 for c in range(3)])
    dx.append(abs(mid[0][0]-mid[1][0]))
    dy.append(abs(mid[0][1]-mid[1][1]))
    dz.append(abs(mid[0][2]-mid[1][2]))

def line(nm, v):
    print(f'{nm}: median={st.median(v):.3f} p05={pct(v,0.05):.3f} p95={pct(v,0.95):.3f} max={max(v):.3f}')

print(f'n={len(dx)} フレーム')
line('|Δx| 左右', dx)
line('|Δy| 上下', dy)
line('|Δz| 奥行き', dz)
share = [z/(x+z+1e-9) for x, z in zip(dx, dz)]
print(f'奥行きが距離に占める割合: median={st.median(share)*100:.0f}% '
      f'（0.5超 = 主に前後に離れている）')
n_overlap = sum(1 for x in dx if x < 0.30)
print(f'左右の隔たりが 0.30m 未満（画面上ほぼ重なる）: {n_overlap/len(dx)*100:.0f}%')
