# 各人の奥行き z が「人が歩ける速さ」で動いているかを測る。
# 弱透視では X = (u-cx)*Z/f なので、Z が飛ぶと横位置 X も一緒に飛ぶ（= 2人が重なる）。
import json, sys, math, statistics as st

def pct(xs, p):
    xs = sorted(xs); i = min(len(xs)-1, max(0, int(round((len(xs)-1)*p)))); return xs[i]

d = json.load(open(sys.argv[1], encoding='utf-8'))
N = d['joints']; I = {n: i for i, n in enumerate(N)}
series = {}
for f in d['frames']:
    for pid, p in f['p'].items():
        j = p['j']
        z = (j[I['lHip']*3+2] + j[I['rHip']*3+2]) / 2
        x = (j[I['lHip']*3] + j[I['rHip']*3]) / 2
        series.setdefault(pid, []).append((f['t'], x, z))

for pid, s in sorted(series.items()):
    vz, vx = [], []
    for i in range(1, len(s)):
        dt = s[i][0]-s[i-1][0]
        if not (0 < dt < 0.1): continue
        vz.append(abs(s[i][2]-s[i-1][2])/dt)
        vx.append(abs(s[i][1]-s[i-1][1])/dt)
    print(f'p{pid}: 奥行き速度[m/s] median={st.median(vz):.2f} p95={pct(vz,0.95):.2f} '
          f'max={max(vz):.1f}  |  左右速度[m/s] median={st.median(vx):.2f} '
          f'p95={pct(vx,0.95):.2f} max={max(vx):.1f}')
    over = sum(1 for v in vz if v > 3.0)
    print(f'     奥行きが 3m/s 超（人の歩速を超える）: {over}/{len(vz)} = {over/len(vz)*100:.0f}%')
