# ペアの「相対位置ベクトル」の向きが時間的に滑らかか（＝平滑化で直せるノイズか）を測る。
# 2人は手でつながっているので、向きは物理的にゆっくりしか変わらないはず。
import json, sys, math, statistics as st

def pct(xs, p):
    xs = sorted(xs); i = min(len(xs)-1, max(0, int(round((len(xs)-1)*p)))); return xs[i]

d = json.load(open(sys.argv[1], encoding='utf-8'))
N = d['joints']; I = {n: i for i, n in enumerate(N)}
ts, th, dist = [], [], []
prev = None
for f in d['frames']:
    if len(f['p']) < 2: continue
    m = []
    for p in f['p'].values():
        j = p['j']
        m.append(((j[I['lHip']*3] + j[I['rHip']*3])/2, (j[I['lHip']*3+2] + j[I['rHip']*3+2])/2))
    dx, dz = m[1][0]-m[0][0], m[1][1]-m[0][1]
    a = math.atan2(dz, dx)
    if prev is not None:
        while a - prev > math.pi: a -= 2*math.pi
        while a - prev < -math.pi: a += 2*math.pi
    prev = a
    ts.append(f['t']); th.append(a); dist.append(math.hypot(dx, dz))

rate = []
for i in range(1, len(ts)):
    dt = ts[i]-ts[i-1]
    if dt <= 0 or dt > 0.1: continue
    rate.append(abs(th[i]-th[i-1]) / dt)
print(f'n={len(ts)}')
print(f'向きの変化 [deg/s]: median={math.degrees(st.median(rate)):.0f} '
      f'p95={math.degrees(pct(rate,0.95)):.0f} max={math.degrees(max(rate)):.0f}')
over = sum(1 for r in rate if math.degrees(r) > 720)
print(f'720deg/s 超（1フレームで17度以上 = 人が回り込める速さを超える）: '
      f'{over}/{len(rate)} = {over/len(rate)*100:.0f}%')
print(f'ペア距離 [m]: median={st.median(dist):.2f} p05={pct(dist,0.05):.2f} p95={pct(dist,0.95):.2f}')

# 平滑化（移動平均11 ≒ 0.26s）したら向きはどれだけ動くか
win = 11
sm = []
for i in range(len(th)):
    a = max(0, i-win//2); b = min(len(th), i+win//2+1)
    sm.append(sum(th[a:b])/(b-a))
diff = [abs(math.degrees(sm[i]-th[i])) for i in range(len(th))]
print(f'平滑化で動く量 [deg]: median={st.median(diff):.1f} p95={pct(diff,0.95):.1f} max={max(diff):.0f}')
