#!/usr/bin/env python3
"""
焦点距離 f[px] を動画そのものから推定する実験。

■ なぜ必要か
prototype_lift3d.py の深度は  Z = f / (px_per_m)  で決まる。f はカメラ内部パラメータで、
動画ファイルには入っていない。f を間違えても *奥行きの順序* は変わらないが、
「2人の奥行き差」は f に比例して伸び縮みする一方、各人の体そのものの大きさ（world landmarks の
メートル値）は f に依存しない。つまり f を外すと **体の大きさに対して前後の距離だけが伸縮した、
奥行きの歪んだシーン** になる。ペアダンスは2人の前後関係が肝なので、ここは合わせたい。

■ どうやって解くか
MediaPipe の world landmarks はメートル単位の3D、その2D投影も分かっている。
剛体の3D-2D対応が33点あるので PnP が解ける。f が正しければ再投影誤差が最小になる。
手がかりは「体の中の奥行き差による遠近（手前に伸ばした腕は大きく写る）」なので、
f を1次元スイープして再投影誤差が底を打つ点を探す。誤差カーブが平坦なら
「この動画からは f を決められない（＝被写体が小さく、ほぼ正射影）」という結論も含めて分かる。

Usage:
  python prototype_calib_f.py <lifted.json> [--min 400] [--max 6000] [--steps 40]
"""
import sys
import json
import math
import argparse

import cv2
import numpy as np

MIN_POINTS = 12
MAX_SAMPLES = 400


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("--min", type=float, default=400.0)
    ap.add_argument("--max", type=float, default=6000.0)
    ap.add_argument("--steps", type=int, default=40)
    args = ap.parse_args()

    data = json.load(open(args.lifted))
    W = data["camera"]["width"]
    H = data["camera"]["height"]
    cx, cy = W / 2.0, H / 2.0

    # 3D-2D 対応のサンプルを集める
    samples = []
    for fr in data["frames"]:
        for p in fr["persons"]:
            img = p.get("img")
            if img is None:
                continue
            obj, im2 = [], []
            for j3, q in zip(p["joints"], img):
                if q is None:
                    continue
                # 保存時に three.js 系 (x,-y,-z) にしてあるので MediaPipe 系へ戻す
                obj.append([j3[0], -j3[1], -j3[2]])
                im2.append(q)
            if len(obj) >= MIN_POINTS:
                samples.append((np.array(obj, np.float64), np.array(im2, np.float64),
                                fr["t"], p["pid"]))
    if not samples:
        print("no usable 3D-2D correspondences", file=sys.stderr)
        sys.exit(1)
    step = max(1, len(samples) // MAX_SAMPLES)
    samples = samples[::step]
    print(f"{len(samples)} samples (each >= {MIN_POINTS} pts), image {W}x{H}", file=sys.stderr)

    fs = np.linspace(args.min, args.max, args.steps)
    curve = []
    for f in fs:
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        errs = []
        for obj, im2, _t, _pid in samples:
            ok, rvec, tvec = cv2.solvePnP(obj, im2, K, None, flags=cv2.SOLVEPNP_SQPNP)
            if not ok:
                continue
            proj, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
            e = np.linalg.norm(proj.reshape(-1, 2) - im2, axis=1)
            errs.append(float(np.sqrt(np.mean(e ** 2))))
        if errs:
            curve.append((float(f), float(np.median(errs))))

    curve.sort(key=lambda c: c[0])
    best_f, best_e = min(curve, key=lambda c: c[1])
    worst_e = max(c[1] for c in curve)

    print("\n f[px]   hfov[deg]   median reprojection RMS[px]", file=sys.stderr)
    for f, e in curve:
        hf = math.degrees(2 * math.atan((W / 2.0) / f))
        bar = "#" * int(60 * (1 - (e - best_e) / max(1e-9, worst_e - best_e)))
        mark = "  <== best" if f == best_f else ""
        print(f"{f:7.0f}  {hf:8.1f}   {e:7.2f}  {bar}{mark}", file=sys.stderr)

    contrast = (worst_e - best_e) / max(1e-9, best_e)
    print(f"\nbest f = {best_f:.0f}px  (hfov {math.degrees(2*math.atan((W/2.0)/best_f)):.1f}deg)"
          f"  RMS {best_e:.2f}px", file=sys.stderr)

    # 「最小値がどこか」より「どの範囲なら同じくらい説明できるか」が知りたい。
    # 最良から TOL 以内の f を全部拾って、それを妥当域として報告する。
    # （谷が広い＝この動画では f を一意に決められない、という結論も含めて正直に出す）
    TOL = 0.02
    thresh = best_e * (1 + TOL)
    plausible = [f for f, e in curve if e <= thresh]
    lo, hi = min(plausible), max(plausible)
    open_top = hi >= curve[-1][0] - 1e-6
    print(f"許容域 (最良RMSの+{TOL:.0%}以内): f = {lo:.0f} .. {hi:.0f}px"
          f"  → hfov {math.degrees(2*math.atan((W/2.0)/hi)):.1f} .. "
          f"{math.degrees(2*math.atan((W/2.0)/lo)):.1f}deg"
          f"{'（上限は打ち切り＝もっと望遠でも説明できる）' if open_top else ''}", file=sys.stderr)

    if lo <= curve[0][0] + 1e-6:
        print("=> 広角側も否定できない。f は決められない。", file=sys.stderr)
    elif open_top:
        print("=> 広角側ははっきり否定できる（f が小さいと再投影誤差が跳ね上がる）が、"
              "望遠側は谷が平坦で一意に決まらない。\n"
              "   下限 f>=%.0f は使える制約。奥行きの *絶対値* は仮定依存、"
              "*順序と相対変化* は f に依らず信頼してよい。" % lo, file=sys.stderr)
    else:
        print("=> 谷が閉じている。この f を lift 側に渡す価値がある。", file=sys.stderr)

    json.dump({"curve": curve, "bestF": best_f, "bestRms": best_e, "contrast": contrast,
               "plausibleF": [lo, hi], "openTop": open_top},
              open(args.lifted.replace(".json", ".fcurve.json"), "w"))


if __name__ == "__main__":
    main()
