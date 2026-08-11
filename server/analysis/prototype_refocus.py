#!/usr/bin/env python3
"""
lift 済み3Dの焦点距離 f を差し替える（MediaPipe を再実行せずに幾何だけやり直す）。

■ f を変えると何が動くのか
  depth  = f / px_per_m
  root_x = (u - cx) * depth / f = (u - cx) / px_per_m     ← f が約分されて消える
  root_y = -(v - cy) * depth / f = -(v - cy) / px_per_m   ← 同上
  root_z = -depth = -f / px_per_m                          ← ここだけ f に比例

つまり **f は「2人の横位置・高さ」には一切影響せず、奥行きのスケールだけを変える**。
各人の体そのもの（world landmarks のメートル値）も f に依存しない。
だから f を外すと「体の大きさに対して前後だけが伸び縮みしたシーン」になる、という
prototype_calib_f.py の話がそのまま効いてくる。

重い知覚は動画1本につき1回だけ、幾何は何度でも安くやり直す（tracks.json 原盤と同じ方針）。

Usage:
  python prototype_refocus.py <lifted.json> <out.json> --f-px 2524
"""
import sys
import json
import math
import argparse

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("out")
    ap.add_argument("--f-px", type=float, required=True)
    args = ap.parse_args()

    data = json.load(open(args.lifted))
    f_old = float(data["camera"]["fPx"])
    f_new = args.f_px
    k = f_new / f_old

    n = 0
    for fr in data["frames"]:
        for p in fr["persons"]:
            # 奥行きだけ f に比例して伸ばす。x,y はそのまま（上のコメントの通り f に依らない）
            p["root"][2] = round(p["root"][2] * k, 4)
            p["depthM"] = round(p["depthM"] * k, 3)
            n += 1

    W = data["camera"]["width"]
    data["camera"]["fPx"] = round(f_new, 1)
    data["camera"]["hfovDeg"] = round(math.degrees(2 * math.atan((W / 2.0) / f_new)), 1)
    data["camera"]["refocusedFrom"] = f_old
    json.dump(data, open(args.out, "w"))

    both = [fr for fr in data["frames"] if len(fr["persons"]) == 2]
    seps = []
    for fr in both:
        d = {p["pid"]: p["depthM"] for p in fr["persons"]}
        seps.append(abs(d[0] - d[1]))
    depths = [p["depthM"] for fr in data["frames"] for p in fr["persons"]]

    print(f"refocus f {f_old:.0f} -> {f_new:.0f}px (x{k:.2f}), {n} person-frames", file=sys.stderr)
    print(f"  depth median {np.median(depths):.2f}m  range {np.min(depths):.2f}..{np.max(depths):.2f}m", file=sys.stderr)
    print(f"  |depth separation| median={np.median(seps):.2f}m  p90={np.percentile(seps,90):.2f}m", file=sys.stderr)


if __name__ == "__main__":
    main()
