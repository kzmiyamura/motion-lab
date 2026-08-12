# 「画面に写っている左右の隔たり」と「復元3Dの左右の隔たり」を突き合わせる。
# 画像は真実（射影の外に出ない）、Z は推定なので、画像で離れているのに 3D で重なる
# フレームがあれば、それは復元の X が壊れている証拠。
import json, sys, math, statistics as st

def pct(xs, p):
    xs = sorted(xs); i = min(len(xs)-1, max(0, int(round((len(xs)-1)*p)))); return xs[i]

tr = json.load(open(sys.argv[1], encoding='utf-8'))
cl = json.load(open(sys.argv[2], encoding='utf-8'))
W = float(sys.argv[3]) if len(sys.argv) > 3 else 888.0   # 動画の横px
N = cl['joints']; I = {n: i for i, n in enumerate(N)}
frames = cl['frames']

def clip_at(t):
    f = min(frames, key=lambda f: abs(f['t'] - t))
    if abs(f['t'] - t) > 0.06 or len(f['p']) < 2: return None
    xs = []
    for p in f['p'].values():
        j = p['j']
        xs.append(((j[I['lHip']*3] + j[I['rHip']*3]) / 2,
                   (j[I['lHip']*3+2] + j[I['rHip']*3+2]) / 2))
    return xs

rows = []
for fr in tr['frames']:
    kept = fr.get('kept') or []
    if len(kept) != 2: continue
    c = clip_at(fr['t'])
    if not c: continue
    # 画像の腰X（正規化）。kps[11]/[12] が左右の腰
    def hipx(k):
        if k.get('hipX') is not None: return k['hipX']
        kp = k['kps']
        return (kp[11][0] + kp[12][0]) / 2
    dimg = abs(hipx(kept[0]) - hipx(kept[1]))
    d3 = abs(c[0][0] - c[1][0])
    dz3 = abs(c[0][1] - c[1][1])
    rows.append((fr['t'], dimg, d3, dz3))

print(f'突き合わせできたフレーム: {len(rows)}')
ratio = [d3 / dimg for _, dimg, d3, _ in rows if dimg > 0.03]
print(f'3D左右差 / 画像左右差: median={st.median(ratio):.2f} '
      f'p05={pct(ratio,0.05):.2f} p95={pct(ratio,0.95):.2f}')
scale = st.median(ratio)   # 画像1.0 あたりの推定メートル
bad = [r for r in rows if r[1] > 0.15 and r[2] < 0.20]
print(f'画像では明確に離れている（>0.15 = 画面幅の15%）のに 3D では重なる（<0.20m）: '
      f'{len(bad)} / {len(rows)} = {len(bad)/len(rows)*100:.0f}%')
for t, dimg, d3, dz3 in bad[:15]:
    print(f'  t={t:6.2f} 画像={dimg:.3f}(≒{dimg*scale:.2f}m) 3D左右={d3:.3f}m 3D奥行={dz3:.3f}m')
