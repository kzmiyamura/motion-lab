#!/usr/bin/env python3
"""
人体の剛性を課す（ゴム腕・胴体の伸縮の除去）。ぎこちなさの最大要因。

■ 実測された問題
フレームを独立に推論しているので骨の長さが毎フレーム変わる。実測で前腕の変動係数49%、
レンジ 0.018m〜0.586m（30倍）。人体は骨の長さが変わらないので、これは全部推定誤差であり、
見た目には手足が伸び縮みする「ゴム人形」として出る。

■ 3つの拘束を順に課す

1. 胴体は剛体。肩と腰の4点を「1つの硬い板」として扱い、正準形状を Kabsch 法で
   各フレームに当てはめる。
   （胴体を「腰中点→左肩」「腰中点→右肩」の2本の骨として長さだけ固定したのでは不十分だった —
     2本の長さが正しくても肩幅が縮む自由度が残り、実測で肩幅CV21.9%・レンジ0.10〜0.615mと
     胴体が潰れていた。板にすれば肩幅も自動的に一定になる。）

2. 手足の骨長は一定。どこを動かして長さを合わせるかが要点で、**z だけを動かす**。
   world landmarks の x,y は画像平面に揃っていて2Dの検出精度がそのまま乗るので比較的正確、
   一方 z（奥行き）は単眼推定で誤差の大半がここに集中する。

       骨長 L と信頼できる (dx, dy) から   dz = ±sqrt(L² - dx² - dy²)
       dx²+dy² > L² のとき（投影長が骨より長い＝ありえない）だけ (dx,dy) を L に縮める

   実質「2D + 骨長 → 3D」のリフティングで、MediaPipe の z をそのまま信じるより頑健。

3. dz の符号は時間的に連続な方を選ぶ。上式の符号は2択で、измеренный dz の符号を
   そのまま採ると、手足が画像平面に近い瞬間（dz≈0）に符号がノイズで反転する。
   反転すると子関節が 2×dz だけ瞬間移動し、実測で手首の1フレーム移動 p95 が
   22.7cm→41.8cm に悪化した（＝ぎこちなさが増えた）。
   前フレームの位置に近い符号を選べば解決する。

■ 骨長そのものの決め方
測定した3D長の中央値は z のノイズを含む。代わりに **2D投影長の高パーセンタイル** を使う。
手足がカメラに対して垂直になった瞬間、投影長は真の骨長と一致し、それ以外では必ず短く写る。
つまり投影長の上側は真値に漸近する（z を一切使わずに骨長が決まる）。
さらに左右対称性で平均して安定させる。

Usage:
  python prototype_bonelength.py <lifted.json> <out.json> [--pct 92]
"""
import sys
import json
import argparse

import numpy as np

L_SHO, R_SHO, L_HIP, R_HIP = 11, 12, 23, 24
TORSO = [L_SHO, R_SHO, L_HIP, R_HIP]

# 手足の運動連鎖。(親, 子)。親から順に決める
LIMBS = [
    (L_HIP, 25), (25, 27), (27, 31),
    (R_HIP, 26), (26, 28), (28, 32),
    (L_SHO, 13), (13, 15),
    (R_SHO, 14), (14, 16),
]
SYMMETRY = [
    ((L_HIP, 25), (R_HIP, 26)),
    ((25, 27), (26, 28)),
    ((27, 31), (28, 32)),
    ((L_SHO, 13), (R_SHO, 14)),
    ((13, 15), (14, 16)),
]
NOSE = 0


def usable(vis, k):
    return vis[k] >= 0.4 or vis[k] < 0


def kabsch(P, Q, w):
    """重み付き Kabsch。正準形状 P を観測 Q に合わせる (R, t) を返す。鏡像は許さない"""
    w = w / max(1e-9, w.sum())
    pc = (P * w[:, None]).sum(0)
    qc = (Q * w[:, None]).sum(0)
    H = ((P - pc) * w[:, None]).T @ (Q - qc)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    return R, qc - R @ pc


def canonical_torso(J, V, pct):
    """胴体4点の正準形状を求める。各フレームで胴体基底に載せ替えて平均する"""
    acc, n = [], 0
    for t in range(len(J)):
        if not all(usable(V[t], k) for k in TORSO):
            continue
        j = J[t]
        hip_mid = (j[L_HIP] + j[R_HIP]) / 2
        sho_mid = (j[L_SHO] + j[R_SHO]) / 2
        ex = j[R_HIP] - j[L_HIP]
        ey = sho_mid - hip_mid
        if np.linalg.norm(ex) < 1e-6 or np.linalg.norm(ey) < 1e-6:
            continue
        ex = ex / np.linalg.norm(ex)
        ey = ey - ex * (ey @ ex)
        if np.linalg.norm(ey) < 1e-6:
            continue
        ey = ey / np.linalg.norm(ey)
        ez = np.cross(ex, ey)
        B = np.stack([ex, ey, ez])       # 行が基底
        acc.append((B @ (j[TORSO] - hip_mid).T).T)
        n += 1
    if n < 8:
        return None
    A = np.stack(acc)                    # (n,4,3)
    canon = np.median(A, axis=0)
    # 幅・高さは投影長の高パーセンタイルで置き換える（z のノイズを避ける狙いは手足と同じ）
    sw, hw, th = [], [], []
    for t in range(len(J)):
        if not all(usable(V[t], k) for k in TORSO):
            continue
        j = J[t]
        sw.append(np.hypot(j[L_SHO][0] - j[R_SHO][0], j[L_SHO][1] - j[R_SHO][1]))
        hw.append(np.hypot(j[L_HIP][0] - j[R_HIP][0], j[L_HIP][1] - j[R_HIP][1]))
        hm = (j[L_HIP] + j[R_HIP]) / 2
        sm = (j[L_SHO] + j[R_SHO]) / 2
        th.append(np.hypot(sm[0] - hm[0], sm[1] - hm[1]))
    SW, HW, TH = (float(np.percentile(x, pct)) for x in (sw, hw, th))
    canon = np.array([
        [-SW / 2, TH, 0.0],   # L肩
        [+SW / 2, TH, 0.0],   # R肩
        [-HW / 2, 0.0, 0.0],  # L腰
        [+HW / 2, 0.0, 0.0],  # R腰
    ])
    return canon, SW, HW, TH


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("out")
    ap.add_argument("--pct", type=float, default=92.0,
                    help="骨長・胴体寸法に使う2D投影長のパーセンタイル")
    args = ap.parse_args()

    data = json.load(open(args.lifted))

    for pid in (0, 1):
        entries = [p for fr in data["frames"] for p in fr["persons"] if p["pid"] == pid]
        if len(entries) < 10:
            continue
        J = np.array([e["joints"] for e in entries], dtype=np.float64)
        V = np.array([e["vis"] for e in entries], dtype=np.float64)

        ct = canonical_torso(J, V, args.pct)
        if ct is None:
            print(f"pid{pid}: 胴体の観測が足りずスキップ", file=sys.stderr)
            continue
        canon, SW, HW, TH = ct

        # --- 手足の骨長（2D投影長の高パーセンタイル → 左右対称化）---
        L = {}
        for par, ch in LIMBS:
            ok = np.array([usable(V[t], par) and usable(V[t], ch) for t in range(len(J))])
            if ok.sum() < 8:
                d = J[:, ch] - J[:, par]
                L[(par, ch)] = float(np.median(np.linalg.norm(d, axis=1)))
                continue
            d = J[ok][:, ch] - J[ok][:, par]
            L[(par, ch)] = float(np.percentile(np.hypot(d[:, 0], d[:, 1]), args.pct))
        for b1, b2 in SYMMETRY:
            m = (L[b1] + L[b2]) / 2.0
            L[b1] = L[b2] = m
        # 鼻は肩中点からの相対で固定する
        nose_ok = np.array([usable(V[t], NOSE) and usable(V[t], L_SHO) and usable(V[t], R_SHO)
                            for t in range(len(J))])
        nose_len = 0.2
        if nose_ok.sum() >= 8:
            sm = (J[nose_ok][:, L_SHO] + J[nose_ok][:, R_SHO]) / 2
            dn = J[nose_ok][:, NOSE] - sm
            nose_len = float(np.percentile(np.hypot(dn[:, 0], dn[:, 1]), args.pct))

        # --- フレームを時間順に処理（符号の連続性のため順序が意味を持つ）---
        prev = None
        stats = {"flip_saved": 0, "clamped": 0, "total": 0}
        for t in range(len(J)):
            j = J[t]
            out = j.copy()

            # 1) 胴体を剛体として当てはめる
            w = np.array([1.0 if usable(V[t], k) else 0.05 for k in TORSO])
            R, tr = kabsch(canon, j[TORSO], w)
            placed = (canon @ R.T) + tr
            for k, p3 in zip(TORSO, placed):
                out[k] = p3

            # 2,3) 手足を骨長どおりに、符号は時間連続な方を選ぶ
            for par, ch in LIMBS + [(-1, NOSE)]:
                if par == -1:
                    base_out = (out[L_SHO] + out[R_SHO]) / 2
                    base_meas = (j[L_SHO] + j[R_SHO]) / 2
                    target = nose_len
                else:
                    base_out, base_meas, target = out[par], j[par], L[(par, ch)]
                d = j[ch] - base_meas
                stats["total"] += 1
                if target <= 1e-6:
                    out[ch] = base_out + d
                    continue
                r2 = d[0] * d[0] + d[1] * d[1]
                if r2 >= target * target:
                    s = target / max(1e-9, np.sqrt(r2))
                    out[ch] = base_out + np.array([d[0] * s, d[1] * s, 0.0])
                    stats["clamped"] += 1
                    continue
                dz = np.sqrt(target * target - r2)
                cand = [np.array([d[0], d[1], dz]), np.array([d[0], d[1], -dz])]
                pick = 0 if d[2] >= 0 else 1
                if prev is not None:
                    # 前フレームの子関節に近い方を採る（dz≈0 付近の符号ノイズで飛ばない）
                    dist = [np.linalg.norm(base_out + c - prev[ch]) for c in cand]
                    best = int(np.argmin(dist))
                    if best != pick:
                        stats["flip_saved"] += 1
                    pick = best
                out[ch] = base_out + cand[pick]

            entries[t]["joints"] = [[round(float(c), 4) for c in q] for q in out]
            prev = out

        print(f"pid{pid}: 胴体 肩幅={SW:.3f} 腰幅={HW:.3f} 胴長={TH:.3f}m  "
              f"上腕={L[(L_SHO,13)]:.3f} 前腕={L[(13,15)]:.3f} 大腿={L[(L_HIP,25)]:.3f} "
              f"下腿={L[(25,27)]:.3f}m", file=sys.stderr)
        print(f"        符号を時間連続性で選び直した回数 {stats['flip_saved']}/{stats['total']}  "
              f"投影長クランプ {stats['clamped']}/{stats['total']}", file=sys.stderr)

    json.dump(data, open(args.out, "w"))
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
