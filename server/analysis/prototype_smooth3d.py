#!/usr/bin/env python3
"""
復元3Dの時間方向の穴埋めと平滑化。

lift 直後のデータは、手首が約50%・膝が約55%のフレームでしか可視判定されない
（相手の体で隠れる／切り出しの端に来る）。1フレームずつ独立に推論しているので、
隠れた瞬間に手足が消える。ダンスは連続運動なので、時間方向を使えばほとんど埋まる。

やること:
  1. 関節ごとに時系列を組み、不可視区間を線形補間で埋める（長い欠落は埋めない＝捏造しない）
  2. 3タップの重み付き平均で高周波ノイズを落とす（0.29秒幅。ターンの速さは残る）
  3. 深度(root z)はスケール推定のばらつきが乗って特に暴れるので、少し強めに平滑化する

補間で埋めた点は vis を負値(-1)で記録し、「観測ではなく推定」と後段で区別できるようにする。

Usage:
  python prototype_smooth3d.py <lifted.json> <out.json> [--max-gap-sec 0.6] [--vis-min 0.4]
"""
import sys
import json
import argparse

import numpy as np

NJ = 33


def interp_gaps(series, valid, max_gap):
    """series=(T,3), valid=(T,) bool。max_gap フレーム以下の欠落だけ線形補間する。
    埋めたフレームの mask を返す"""
    T = len(series)
    filled = np.zeros(T, dtype=bool)
    idx = np.where(valid)[0]
    if len(idx) < 2:
        return filled
    for a, b in zip(idx[:-1], idx[1:]):
        gap = b - a - 1
        if gap <= 0 or gap > max_gap:
            continue
        for k in range(1, gap + 1):
            w = k / (gap + 1)
            series[a + k] = series[a] * (1 - w) + series[b] * w
            filled[a + k] = True
    return filled


def smooth(series, valid, taps):
    """valid なフレームだけを使った重み付き移動平均（端は縮退）"""
    T = len(series)
    out = series.copy()
    r = len(taps) // 2
    for t in range(T):
        if not valid[t]:
            continue
        acc = np.zeros(series.shape[1])
        wsum = 0.0
        for k, w in enumerate(taps):
            j = t + k - r
            if 0 <= j < T and valid[j]:
                acc += series[j] * w
                wsum += w
        if wsum > 0:
            out[t] = acc / wsum
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("out")
    ap.add_argument("--max-gap-sec", type=float, default=0.6)
    ap.add_argument("--vis-min", type=float, default=0.4)
    args = ap.parse_args()

    data = json.load(open(args.lifted))
    # sampledFps のフィールドは上流で取り直したときに古い値が残りうるので、
    # 実際のタイムスタンプの間隔から求める（メタデータより観測を信じる）
    ts_all = [fr["t"] for fr in data["frames"]]
    if len(ts_all) > 2:
        dt = float(np.median(np.diff(ts_all)))
        fps = 1.0 / dt if dt > 1e-6 else float(data.get("sampledFps") or 10.0)
    else:
        fps = float(data.get("sampledFps") or 10.0)
    max_gap = max(1, int(round(args.max_gap_sec * fps)))

    frames = data["frames"]
    times = [fr["t"] for fr in frames]
    T = len(frames)

    report = {}
    for pid in (0, 1):
        # フレーム番号 -> その人の辞書
        slot = [None] * T
        for i, fr in enumerate(frames):
            for p in fr["persons"]:
                if p["pid"] == pid:
                    slot[i] = p
        present = np.array([s is not None for s in slot])
        if present.sum() < 3:
            continue

        joints = np.full((T, NJ, 3), np.nan)
        vis = np.zeros((T, NJ))
        root = np.full((T, 3), np.nan)
        for i, s in enumerate(slot):
            if s is None:
                continue
            joints[i] = np.array(s["joints"])
            vis[i] = np.array(s["vis"])
            root[i] = np.array(s["root"])

        # --- root（人物の位置）---
        rvalid = present.copy()
        rfilled = interp_gaps(root, rvalid, max_gap)
        rvalid = rvalid | rfilled
        # 深度は他の2軸よりノイジーなので別の重みで均す
        xy = smooth(root[:, :2], rvalid, [0.25, 0.5, 0.25])
        z = smooth(root[:, 2:3], rvalid, [0.15, 0.2, 0.3, 0.2, 0.15])
        root = np.concatenate([xy, z], axis=1)

        # --- 各関節 ---
        n_filled = 0
        n_target = 0
        for j in range(NJ):
            v = present & (vis[:, j] >= args.vis_min)
            n_target += present.sum()
            f = interp_gaps(joints[:, j, :], v, max_gap)
            n_filled += int(f.sum())
            v2 = v | f
            joints[:, j, :] = smooth(joints[:, j, :], v2, [0.25, 0.5, 0.25])
            # 補間で埋めた点は「推定」と分かるように負の vis を入れる
            for t in np.where(f)[0]:
                vis[t, j] = -1.0
            # まだ埋まっていない不可視点は描かせない
            for t in np.where(present & ~v2)[0]:
                vis[t, j] = 0.0

        for i, s in enumerate(slot):
            if s is None:
                continue
            s["joints"] = [[round(float(c), 4) for c in j3] for j3 in joints[i]]
            s["vis"] = [round(float(x), 2) for x in vis[i]]
            s["root"] = [round(float(c), 4) for c in root[i]]

        before = float(np.mean(vis[present] >= args.vis_min))
        after = float(np.mean((vis[present] >= args.vis_min) | (vis[present] < 0)))
        report[pid] = (before, after, n_filled)

    json.dump(data, open(args.out, "w"))
    for pid, (b, a, n) in report.items():
        print(f"pid{pid}: 可視関節率 {b*100:.0f}% -> {a*100:.0f}%  (補間で {n} 点を復元)", file=sys.stderr)
    print(f"max gap = {max_gap} frames ({args.max_gap_sec}s @ {fps:.1f}fps)", file=sys.stderr)


if __name__ == "__main__":
    main()
