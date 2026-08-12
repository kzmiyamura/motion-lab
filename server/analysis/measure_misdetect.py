#!/usr/bin/env python3
"""切り出しの中で MediaPipe が「隣の人」を掴んでいないか測る。

lift3d は YOLO の bbox で1人ずつ切り出して単人モードの MediaPipe をかける。
2人が交差・密着すると切り出しの中に2人とも入り、単人モードは片方しか返さないので、
**両方の切り出しが同じ人を掴む**ことがある。そうなると2人の腰が画像座標の時点で
同じ場所に出る＝3Dでも必ず重なる。奥行き（弱透視）の誤差と紛らわしいが別物で、
見分け方は「画像上で既に重なっているかどうか」。

身元の正解は bbox（YOLO の追跡）が持っているので、それを物差しに使う。

Usage: python measure_misdetect.py <tracks.json> <lifted.json>
       lifted.json は lift3d の出力（パイプラインの 1_lift.json）
"""
import sys
import json

import numpy as np

MATCH_TOL_SEC = 0.08   # tracks と lift の時刻合わせの許容
NEAR_RATIO = 0.8       # 相手の bbox 中心にこの比率より近ければ取り違え
HIP_CLOSE = 0.03       # 腰が画面幅のこの割合より近い＝重なっている
BBOX_FAR = 0.10        # bbox 中心が画面幅のこの割合より離れている＝別の場所に居るはず


def main():
    tr = json.load(open(sys.argv[1], encoding="utf-8"))
    lf = json.load(open(sys.argv[2]))
    W = lf["camera"]["width"]
    H = lf["camera"]["height"]

    # tracks: t -> {pid: bbox}
    tframes = []
    for f in tr["frames"]:
        d = {p["pid"]: p["bbox"] for p in (f.get("kept") or []) if p.get("pid") is not None}
        if d:
            tframes.append((f["t"], d))
    tt = np.array([x[0] for x in tframes])

    def bbox_at(t):
        i = int(np.argmin(np.abs(tt - t)))
        return tframes[i][1] if abs(tt[i] - t) <= MATCH_TOL_SEC else None

    n = both = wrong = collapsed = 0
    hits = []
    for fr in lf["frames"]:
        ps = {p["pid"]: p for p in fr["persons"]}
        bb = bbox_at(fr["t"])
        if not bb or len(ps) < 2 or 0 not in bb or 1 not in bb:
            continue
        both += 1
        cen = {}
        for q in (0, 1):
            x1, y1, x2, y2 = bb[q]
            cen[q] = ((x1 + x2) / 2 * W, (y1 + y2) / 2 * H)
        du = abs(ps[0]["hipUV"][0] - ps[1]["hipUV"][0]) / W
        dcen = abs(cen[0][0] - cen[1][0]) / W
        if du < HIP_CLOSE and dcen > BBOX_FAR:
            collapsed += 1
        nwrong = 0
        for q in (0, 1):
            u, v = ps[q]["hipUV"]
            n += 1
            d_own = np.hypot(u - cen[q][0], v - cen[q][1])
            d_oth = np.hypot(u - cen[1 - q][0], v - cen[1 - q][1])
            if d_oth < d_own * NEAR_RATIO:
                nwrong += 1
                wrong += 1
        if nwrong:
            hits.append((fr["t"], nwrong, du, dcen))

    print(f"2人そろい bbox も取れたフレーム: {both}   人物フレーム: {n}")
    print(f"腰が相手の bbox 中心のほうに寄っている: {wrong} = {wrong/max(n,1)*100:.1f}%")
    print(f"bbox は画面幅{BBOX_FAR*100:.0f}%以上離れているのに腰が{HIP_CLOSE*100:.0f}%未満に重なる: "
          f"{collapsed} = {collapsed/max(both,1)*100:.1f}%   ← これが「2人が重なる」の実体")
    if hits:
        print("\n最初の20件:")
        for t, k, du, dc in hits[:20]:
            print(f"  t={t:6.2f}  取り違え={k}人  腰の差={du:.3f}  bbox中心差={dc:.3f}")


if __name__ == "__main__":
    main()
