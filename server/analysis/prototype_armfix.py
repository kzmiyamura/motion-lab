#!/usr/bin/env python3
"""
腕の残存スパイクの除去。剛体拘束の後段。

■ 残っている問題
骨長を固定しても手首の1フレーム移動が最大46cm残る。骨長は直せても **向き** は直らないため。
腕は可視率が低く（手首42〜62%）、隠れている間の肘・手首の推定はしばしば別物を指している。

■ 直し方 — 胴体基準で見る
腕の異常を **ワールド座標で** 判定・補間するのは誤り。ターン中は体ごと回っているので、
腕が体に対して静止していてもワールドでは大きく動く（＝正常な動きを異常と誤判定し、
補間すると体の回転から腕だけ取り残される）。

そこで胴体に固定した局所座標系（原点=腰中点、軸=肩腰から作る）に載せ替えてから、
  1. 信頼できないフレームを拾う（可視でない／局所座標での飛びが腕長に対して大きすぎる）
  2. その区間を前後の信頼できるフレームから局所座標のまま線形補間する
  3. ワールドへ戻し、腕の骨長を張り直す（符号は時間連続な方を選ぶ、bonelength と同じ）
短い欠落だけ埋め、長い区間は捏造せずそのまま残す。

Usage:
  python prototype_armfix.py <lifted.json> <out.json> [--max-gap-sec 0.5] [--jump 0.6]
"""
import sys
import json
import argparse

import numpy as np

L_SHO, R_SHO, L_HIP, R_HIP = 11, 12, 23, 24
ARMS = [(L_SHO, 13, 15), (R_SHO, 14, 16)]   # (肩, 肘, 手首)


def torso_basis(j):
    """胴体に固定した正規直交基底と原点を返す。取れなければ None"""
    hip_mid = (j[L_HIP] + j[R_HIP]) / 2
    sho_mid = (j[L_SHO] + j[R_SHO]) / 2
    ex = j[R_HIP] - j[L_HIP]
    ey = sho_mid - hip_mid
    if np.linalg.norm(ex) < 1e-6 or np.linalg.norm(ey) < 1e-6:
        return None
    ex = ex / np.linalg.norm(ex)
    ey = ey - ex * float(ey @ ex)
    if np.linalg.norm(ey) < 1e-6:
        return None
    ey = ey / np.linalg.norm(ey)
    ez = np.cross(ex, ey)
    return np.stack([ex, ey, ez]), hip_mid       # 行が基底


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("out")
    ap.add_argument("--max-gap-sec", type=float, default=0.5,
                    help="これより長い不信区間は補間せず残す")
    ap.add_argument("--jump", type=float, default=0.6,
                    help="1フレームの局所移動が『腕の全長×この値』を超えたら異常とみなす")
    args = ap.parse_args()

    data = json.load(open(args.lifted))
    ts_all = [fr["t"] for fr in data["frames"]]
    dt = float(np.median(np.diff(ts_all))) if len(ts_all) > 2 else 0.1
    fps = 1.0 / dt if dt > 1e-6 else 10.0
    max_gap = max(1, int(round(args.max_gap_sec * fps)))

    for pid in (0, 1):
        entries = [p for fr in data["frames"] for p in fr["persons"] if p["pid"] == pid]
        if len(entries) < 10:
            continue
        J = np.array([e["joints"] for e in entries], dtype=np.float64)
        V = np.array([e["vis"] for e in entries], dtype=np.float64)
        T = len(J)

        # 胴体基底（剛体拘束済みなので安定しているはず）
        B, O = [], []
        for t in range(T):
            tb = torso_basis(J[t])
            B.append(None if tb is None else tb[0])
            O.append(None if tb is None else tb[1])

        report = []
        for sho, elb, wri in ARMS:
            # 腕長（剛体拘束済みなので一定）
            La = float(np.linalg.norm(J[0][elb] - J[0][sho]))
            Lf = float(np.linalg.norm(J[0][wri] - J[0][elb]))
            reach = La + Lf
            thresh = reach * args.jump

            # 局所座標へ（肩を原点にした腕のかたち）
            loc = np.full((T, 2, 3), np.nan)
            for t in range(T):
                if B[t] is None:
                    continue
                loc[t, 0] = B[t] @ (J[t][elb] - J[t][sho])
                loc[t, 1] = B[t] @ (J[t][wri] - J[t][sho])

            # 信頼できるフレーム: 肘・手首とも実観測（補間フラグでも0でもない）かつ局所の飛びが小さい
            observed = (V[:, elb] >= 0.4) & (V[:, wri] >= 0.4)
            trust = observed & ~np.isnan(loc[:, 1, 0])
            jumps = 0
            for t in range(1, T):
                if not (trust[t] and trust[t - 1]):
                    continue
                d = np.linalg.norm(loc[t, 1] - loc[t - 1, 1])
                if d > thresh:
                    trust[t] = False
                    jumps += 1

            # 不信区間を局所座標のまま埋める。
            # 重要: 短い欠落だけ補間して長い欠落を「元の推定のまま」残すと、区間の境目で
            # 補間結果と元推定という別物どうしが繋がり、そこで新しい飛びが生まれる
            # （実際それをやったら手首の最大移動が 46cm -> 92cm に悪化した）。
            # 腕は全フレームこの経路だけで決める。長い欠落は直近の信頼できる
            # 「体に対する腕のかたち」を保持する — 胴体基準なので体の回転には追従し、
            # 静止して見えるのは体に対してだけ。分からない区間は動かさない、が一番正直。
            idx = np.where(trust)[0]
            filled = held = 0
            if len(idx) >= 2:
                for a, b in zip(idx[:-1], idx[1:]):
                    gap = b - a - 1
                    if gap <= 0:
                        continue
                    if gap <= max_gap:
                        for k in range(1, gap + 1):
                            w = k / (gap + 1)
                            loc[a + k] = loc[a] * (1 - w) + loc[b] * w
                            filled += 1
                    else:
                        # 長すぎる欠落は前後それぞれの直近を保持して中央で切り替える
                        mid = a + gap // 2
                        for k in range(a + 1, b):
                            loc[k] = loc[a] if k <= mid else loc[b]
                            held += 1
                    for k in range(a + 1, b):
                        trust[k] = True
            if len(idx) >= 1:
                # 端の外側も直近を保持（先頭・末尾で腕が消えるのを防ぐ）
                for k in range(0, idx[0]):
                    loc[k] = loc[idx[0]]; trust[k] = True; held += 1
                for k in range(idx[-1] + 1, T):
                    loc[k] = loc[idx[-1]]; trust[k] = True; held += 1

            # 観測でないフレームは vis を「推定」にして、描画側で薄く出せるようにする
            for t in range(T):
                if not observed[t] and trust[t]:
                    if V[t][elb] >= 0.4 or V[t][elb] == 0:
                        V[t][elb] = -1.0
                    if V[t][wri] >= 0.4 or V[t][wri] == 0:
                        V[t][wri] = -1.0

            # ワールドへ戻して骨長を張り直す（符号は時間連続な方）
            prev_e = prev_w = None
            for t in range(T):
                if B[t] is None or not trust[t] or np.isnan(loc[t, 1, 0]):
                    prev_e = prev_w = None
                    continue
                Bt = B[t]
                e_world = J[t][sho] + Bt.T @ loc[t, 0]
                w_world = J[t][sho] + Bt.T @ loc[t, 1]

                for base, tgt, target_len, prev in (
                    (J[t][sho], "e", La, prev_e), (None, "w", Lf, prev_w),
                ):
                    if tgt == "e":
                        b0, p1 = J[t][sho], e_world
                    else:
                        b0, p1 = e_world, w_world
                    d = p1 - b0
                    r2 = d[0] * d[0] + d[1] * d[1]
                    if r2 >= target_len * target_len:
                        s = target_len / max(1e-9, np.sqrt(r2))
                        nd = np.array([d[0] * s, d[1] * s, 0.0])
                    else:
                        dz = np.sqrt(target_len * target_len - r2)
                        cand = [np.array([d[0], d[1], dz]), np.array([d[0], d[1], -dz])]
                        pick = 0 if d[2] >= 0 else 1
                        if prev is not None:
                            dist = [np.linalg.norm(b0 + c - prev) for c in cand]
                            pick = int(np.argmin(dist))
                        nd = cand[pick]
                    if tgt == "e":
                        e_world = b0 + nd
                    else:
                        w_world = b0 + nd

                J[t][elb] = e_world
                J[t][wri] = w_world
                prev_e, prev_w = e_world, w_world

            report.append((sho, jumps, filled, held, int(observed.sum()), T))

        for t in range(T):
            entries[t]["joints"] = [[round(float(c), 4) for c in q] for q in J[t]]
            entries[t]["vis"] = [round(float(x), 2) for x in V[t]]

        for sho, jumps, filled, held, nobs, T_ in report:
            side = "L" if sho == L_SHO else "R"
            print(f"pid{pid} {side}腕: 実観測 {nobs}/{T_} ({nobs/T_*100:.0f}%)  "
                  f"飛びで棄却 {jumps}  補間 {filled}  保持 {held}", file=sys.stderr)

    json.dump(data, open(args.out, "w"))
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
