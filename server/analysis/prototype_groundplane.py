#!/usr/bin/env python3
"""
床面拘束による深度の検証と補正。

■ 問題
prototype_lift3d.py の深度は「体の見かけの大きさ」から出している（Z = f / px_per_m）。
ところが MediaPipe のメートル推定は平均体型に引っ張られるため、**小柄な人ほど
「遠くにいる」と誤られる** 疑いがある。実測でフォロワーが常に約0.42m奥に出ており、
これが本物の位置関係なのか体格バイアスなのか区別がついていなかった。

■ 体格に依存しない手がかり = 床
2人が同じ床に立っているなら、足首の画面上の高さ v がそのまま深度を表す:
    v = v_horizon + k / Z        （k = f × カメラ高、v_horizon = 水平線）
体の大きさは一切入らないので、体格バイアスから独立した第二の観測になる。

■ やること
1. 全人物フレームの (足首v, 体格由来の深度) から (k, v_horizon) を最小二乗で当てはめる
2. 当てはめの残差を pid 別に集計する。片方だけ系統的にズレていればバイアス確定
3. --apply で深度を床基準に置き換える（体格に依存しない値になる）

Usage:
  python prototype_groundplane.py <lifted.json> [--apply <out.json>]
"""
import sys
import json
import argparse

import numpy as np


def collect(data, vis_min=0.4):
    """(ankle_v, depth_bodyscale, pid, frame_index) を集める"""
    rows = []
    for fi, fr in enumerate(data["frames"]):
        for p in fr["persons"]:
            img = p.get("img")
            if img is None:
                continue
            vs = p["vis"]
            # 足首は左右どちらか片方でも観測できていればよい（接地側が取れれば十分）
            cand = []
            for k in (27, 28):
                if img[k] is not None and (vs[k] >= vis_min or vs[k] < 0):
                    cand.append(img[k][1])
            if not cand:
                continue
            rows.append((max(cand), p["depthM"], p["pid"], fi))  # 下にある方＝接地足
    return rows


def fit_ground(v, z):
    """v = v_h + k / z  を (v_h, k) について線形最小二乗で解く"""
    A = np.stack([np.ones_like(z), 1.0 / z], axis=1)
    coef, *_ = np.linalg.lstsq(A, v, rcond=None)
    return float(coef[0]), float(coef[1])


def fit_per_person_scale(v, z, pid, iters=3):
    """水平線を共有しつつ、人物ごとに別の傾きを許して当てはめる。

        v = v_h + m_pid / z

    MediaPipe の体格バイアスは「その人の骨格を一定倍率 c で誤る」形なので、深度も同じ倍率で
    ずれる。倍率はクリップ全体で一定なので、フレーム毎に深度を差し替えるより
    **人物ごとに1つの補正係数を出す** ほうが遥かに頑健（足の上げ下げや足首の検出ノイズが平均化される）。
    傾き m_i = k / c_i なので、補正係数の比は m の逆比で取れる。
    絶対スケールは f と縮退しているので、平均が1になるように正規化して返す。

    外れ値（片足を高く上げた瞬間・足首の誤検出）は残差でトリムして落とす。
    """
    keep = np.ones(len(v), dtype=bool)
    v_h = m0 = m1 = 0.0
    for _ in range(iters):
        inv = 1.0 / z[keep]
        p = pid[keep]
        A = np.stack([np.ones(keep.sum()), inv * (p == 0), inv * (p == 1)], axis=1)
        coef, *_ = np.linalg.lstsq(A, v[keep], rcond=None)
        v_h, m0, m1 = (float(c) for c in coef)
        inv_all = 1.0 / z
        pred = v_h + inv_all * np.where(pid == 0, m0, m1)
        r = np.abs(v - pred)
        thr = np.percentile(r, 85)
        keep = r <= max(thr, 1e-6)
    # c_i ∝ 1/m_i、平均1に正規化
    c0, c1 = 1.0 / m0, 1.0 / m1
    mean = (c0 + c1) / 2
    return v_h, m0, m1, c0 / mean, c1 / mean, keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("--apply", default=None, help="床基準の深度に置き換えて書き出す")
    ap.add_argument("--blend", type=float, default=1.0,
                    help="1.0=完全に床基準, 0.0=体格由来のまま")
    args = ap.parse_args()

    data = json.load(open(args.lifted))
    rows = collect(data)
    if len(rows) < 30:
        print(f"足首の観測が足りない ({len(rows)})", file=sys.stderr)
        sys.exit(1)

    v = np.array([r[0] for r in rows])
    z = np.array([r[1] for r in rows])
    pid = np.array([r[2] for r in rows])

    v_h, k = fit_ground(v, z)
    pred = v_h + k / z
    resid = v - pred
    print(f"サンプル {len(rows)}  床面当てはめ: v_horizon={v_h:.1f}px  k={k:.0f}", file=sys.stderr)
    print(f"残差 RMS={np.sqrt(np.mean(resid**2)):.1f}px", file=sys.stderr)

    for q in (0, 1):
        m = pid == q
        if m.sum() == 0:
            continue
        print(f"  pid{q}: n={m.sum():4d}  残差 median={np.median(resid[m]):+7.1f}px  "
              f"体格由来の深度 median={np.median(z[m]):.2f}m", file=sys.stderr)

    bias = np.median(resid[pid == 0]) - np.median(resid[pid == 1])
    print(f"\npid0 と pid1 の残差差 = {bias:+.1f}px", file=sys.stderr)

    # --- 人物ごとの体格バイアス補正係数 ---
    v_h2, m0, m1, c0, c1, keep = fit_per_person_scale(v, z, pid)
    print(f"\n人物別あてはめ (外れ値 {int((~keep).sum())}/{len(v)} を除外)", file=sys.stderr)
    print(f"  v_horizon={v_h2:.1f}px  m0={m0:.0f}  m1={m1:.0f}", file=sys.stderr)
    print(f"  体格バイアス補正係数: pid0 x{c0:.3f}  pid1 x{c1:.3f}", file=sys.stderr)

    sep_body, sep_corr = [], []
    byframe = {}
    for av, zb, q, fi in rows:
        byframe.setdefault(fi, {})[q] = zb
    for fi, d in byframe.items():
        if 0 in d and 1 in d:
            sep_body.append(d[0] - d[1])
            sep_corr.append(d[0] * c0 - d[1] * c1)
    if sep_body:
        print(f"\n2人の深度差 (pid0 - pid1)  同一フレーム {len(sep_body)} 件", file=sys.stderr)
        print(f"  補正前: median={np.median(sep_body):+.2f}m  std={np.std(sep_body):.2f}m", file=sys.stderr)
        print(f"  補正後: median={np.median(sep_corr):+.2f}m  std={np.std(sep_corr):.2f}m", file=sys.stderr)
        moved = abs(np.median(sep_body)) - abs(np.median(sep_corr))
        if moved > 0.05:
            print(f"=> 一定オフセットのうち {moved:.2f}m は体格バイアスの artifact だった。", file=sys.stderr)
        else:
            print("=> 補正してもオフセットが残る。本物の位置関係の可能性が高い。", file=sys.stderr)

    if args.apply:
        # 人物ごとの定数倍だけを掛ける（フレーム毎の足首ノイズを持ち込まない）。
        # root の x,y は px_per_m 由来で深度に比例するので一緒にスケールする
        cs = {0: c0, 1: c1}
        n = 0
        for fr in data["frames"]:
            for p in fr["persons"]:
                s = cs.get(p["pid"])
                if s is None:
                    continue
                p["root"] = [round(p["root"][0] * s, 4), round(p["root"][1] * s, 4),
                             round(p["root"][2] * s, 4)]
                p["depthM"] = round(p["depthM"] * s, 3)
                n += 1
        data["camera"]["groundPlane"] = {"vHorizon": round(v_h2, 1),
                                         "scaleCorrection": {"0": round(c0, 4), "1": round(c1, 4)}}
        json.dump(data, open(args.apply, "w"))
        print(f"\nwrote {args.apply}: {n} person-frames に体格バイアス補正を適用", file=sys.stderr)


if __name__ == "__main__":
    main()
