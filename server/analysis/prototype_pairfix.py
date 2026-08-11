#!/usr/bin/env python3
"""
ペア拘束と接地拘束 — 「ダンスとして使えない」欠落をサルサ固有の構造で補填する第1層。

汎用の平滑化・補間はやり尽くした（骨長固定・回転頭打ち・時間補間）。残る欠落は
ランダムノイズではなく **観測が無い** ことが原因なので、これ以上は情報を足すしかない。
ただしダンスには強い構造があり、そこからは「正直な」情報を足せる:

■ 1. ホールド拘束（手のつなぎ = 観測の転写）
analyze_pair の holdTimeline が「リーダー右手×フォロワー左手」のような区間を検出済み。
つないでいる2つの手首は物理的にほぼ同一点にある。よって
  片方の手首が実観測できていれば、その位置は相手の手首の観測でもある。
腕が隠れるのはまさに組んでいる時（相手が間に入る時）なので、欠落とホールドは重なる。
これは捏造ではなく、実観測 + 検証済みの物理拘束による転写。

- 片方観測 / 片方推定 → 推定側を観測側へスナップ（6cmオフセット）し、肘を2ボーンIKで追従
- 両方推定           → 中点で結合（どちらも当てにならないが「離れている」のは確実に誤り）
- 両方観測           → 触らない。ただし距離を診断として記録
                       （つないでいるはずの手首間距離 = 腕推定の誤差メトリクスになる）

■ 1b. 3Dホールド追加検出（カバレッジの引き上げ）
holdTimeline は 2D 側（analyze_pair）の検出で、ターン主体の動画では区間が少ない
（検証動画で拘束カバレッジ 6%）。そこで 3D 復元結果そのものから追加検出する:
リーダー×フォロワーの手首4組合せについて「両方が実観測 かつ 3D距離 < 35cm」が
持続する区間はホールドとみなせる。実観測同士が近接し続けることは偶然では起きにくい。
検出根拠が実観測のみ（推定値を使わない）なので、これも捏造ではない。
オクルージョンでの取りこぼしは時間ギャップの橋渡し（既定0.6秒）で吸収する —
組んでいる最中こそ手首が隠れるので、ギャップ内こそが転写で埋めたいフレーム。

■ 2. 接地ロック（footskate 除去）
着地している足は滑らない。足首の水平速度が低く床に近い区間を接地とみなし、
区間中の足首を区間の中央値位置に固定、膝を2ボーンIKで追従させる。
骨格アニメの「見た目のダンスらしさ」を壊す最大要因が footskate なので、
知覚品質への寄与はここが一番大きい。

Usage:
  python prototype_pairfix.py <lifted.json> <tracks.json> <out.json>
      [--hold-offset 0.06] [--contact-speed 0.015] [--contact-height 0.15]
"""
import sys
import json
import argparse

import numpy as np

L_SHO, R_SHO = 11, 12
L_ELB, R_ELB = 13, 14
L_WRI, R_WRI = 15, 16
L_HIP, R_HIP = 23, 24
L_KNE, R_KNE = 25, 26
L_ANK, R_ANK = 27, 28

ARM_OF_WRIST = {L_WRI: (L_SHO, L_ELB), R_WRI: (R_SHO, R_ELB)}
LEG_OF_ANKLE = {L_ANK: (L_HIP, L_KNE), R_ANK: (R_HIP, R_KNE)}


def two_bone_ik(S, W, a, b, ref):
    """肩(腰)S から手首(足首)W へ、上腕a・前腕b の2ボーンで届く肘(膝)位置を返す。
    W が届かない場合は到達球へクランプした W も返す。ref に最も近い解を選ぶ"""
    d = float(np.linalg.norm(W - S))
    lo, hi = abs(a - b) + 1e-4, a + b - 1e-4
    if d < 1e-9:
        W = S + np.array([hi, 0, 0]); d = hi
    elif d > hi:
        W = S + (W - S) * (hi / d); d = hi
    elif d < lo:
        W = S + (W - S) * (lo / d); d = lo
    u = (W - S) / d
    h = (a * a - b * b + d * d) / (2 * d)
    r2 = max(0.0, a * a - h * h)
    C = S + h * u
    v = ref - C
    v = v - u * float(v @ u)
    n = np.linalg.norm(v)
    if n < 1e-9:
        v = np.cross(u, np.array([0.0, 1.0, 0.0]))
        n = np.linalg.norm(v)
        if n < 1e-9:
            v = np.cross(u, np.array([1.0, 0.0, 0.0]))
            n = np.linalg.norm(v)
    E = C + np.sqrt(r2) * (v / n)
    return E, W


def parse_hold(label):
    """『リーダー左手×フォロワー右手』→ (leader手首idx, follower手首idx)"""
    lw = L_WRI if "リーダー左手" in label else R_WRI
    fw = L_WRI if "フォロワー左手" in label else R_WRI
    return lw, fw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("tracks")
    ap.add_argument("out")
    ap.add_argument("--hold-offset", type=float, default=0.06)
    ap.add_argument("--hold3d-dist", type=float, default=0.35,
                    help="3Dホールド検出: 実観測手首間の3D距離[m]がこれ未満")
    ap.add_argument("--hold3d-min-frames", type=int, default=8,
                    help="3Dホールド検出: 区間内の実観測フレーム数の下限")
    ap.add_argument("--hold3d-min-sec", type=float, default=0.35,
                    help="3Dホールド検出: 区間の持続時間[s]の下限")
    ap.add_argument("--hold3d-gap", type=float, default=0.6,
                    help="3Dホールド検出: この時間[s]以内の途切れは同一区間として橋渡し")
    ap.add_argument("--hold3d-pad", type=float, default=0.15,
                    help="3Dホールド検出: 採用区間の前後をこの時間[s]だけ広げる")
    ap.add_argument("--no-hold3d", action="store_true",
                    help="3Dホールド追加検出を無効化（holdTimelineのみ使用）")
    ap.add_argument("--contact-speed", type=float, default=0.015,
                    help="接地判定: 1フレームの水平移動[m]がこれ未満")
    ap.add_argument("--contact-height", type=float, default=0.15,
                    help="接地判定: 床からの足首高さ[m]がこれ未満")
    args = ap.parse_args()

    data = json.load(open(args.lifted))
    tracks = json.load(open(args.tracks))
    leader_pid = int(data.get("leaderPid", tracks.get("leaderPid", 0)))
    segs = [(s["from"], s["to"], *parse_hold(s["hold"]), "2d")
            for s in (tracks.get("holdTimeline") or [])]

    frames = data["frames"]
    # pid -> (frame_index -> person dict)
    by_pid = {0: {}, 1: {}}
    for i, fr in enumerate(frames):
        for p in fr["persons"]:
            by_pid[p["pid"]][i] = p

    def jabs(p, k):
        return np.array(p["joints"][k]) + np.array(p["root"])

    def set_jabs(p, k, pos):
        p["joints"][k] = [round(float(c), 4) for c in (pos - np.array(p["root"]))]

    def observed(p, k):
        return p["vis"][k] >= 0.4

    def usable(p, k):
        return p["vis"][k] >= 0.4 or p["vis"][k] < 0

    def bone_len(p, a, b):
        return float(np.linalg.norm(np.array(p["joints"][a]) - np.array(p["joints"][b])))

    ts = [fr["t"] for fr in frames]

    # ── 1b. 3Dホールド追加検出 ─────────────────────────────
    if not args.no_hold3d:
        for lw in (L_WRI, R_WRI):
            for fw in (L_WRI, R_WRI):
                marks = []                # 両方実観測かつ近接のフレーム index
                for i in range(len(frames)):
                    lp = by_pid[leader_pid].get(i)
                    fp = by_pid[1 - leader_pid].get(i)
                    if lp is None or fp is None:
                        continue
                    if not (observed(lp, lw) and observed(fp, fw)):
                        continue
                    if float(np.linalg.norm(jabs(lp, lw) - jabs(fp, fw))) < args.hold3d_dist:
                        marks.append(i)
                # 時間ギャップ hold3d-gap 以内は同一区間として橋渡し
                runs = []
                for m in marks:
                    if runs and ts[m] - ts[runs[-1][-1]] <= args.hold3d_gap:
                        runs[-1].append(m)
                    else:
                        runs.append([m])
                for run in runs:
                    t0, t1 = ts[run[0]], ts[run[-1]]
                    if len(run) < args.hold3d_min_frames or t1 - t0 < args.hold3d_min_sec:
                        continue
                    segs.append((t0 - args.hold3d_pad, t1 + args.hold3d_pad, lw, fw, "3d"))

    # ── 1. ホールド拘束 ─────────────────────────────────────
    st = {"frames_in_hold": 0, "transfer": 0, "midpoint": 0, "both_obs": 0, "skipped_far": 0}
    dist_pre = []
    for i, fr in enumerate(frames):
        t = fr["t"]
        active = [s for s in segs if s[0] - 0.05 <= t <= s[1] + 0.05]
        if not active:
            continue
        lp = by_pid[leader_pid].get(i)
        fp = by_pid[1 - leader_pid].get(i)
        if lp is None or fp is None:
            continue
        # 同じ手首を複数区間が奪い合わないよう、このフレームで使用済みの手首を排他する
        # （2d区間を先に適用し、3d検出は空いている手首の組にのみ効く）
        used_lw, used_fw = set(), set()
        counted = False
        for seg in active:
            _, _, lw, fw, _src = seg
            if lw in used_lw or fw in used_fw:
                continue
            if not (usable(lp, lw) and usable(fp, fw)):
                continue
            if not counted:
                st["frames_in_hold"] += 1
                counted = True
            used_lw.add(lw)
            used_fw.add(fw)
            Lw, Fw = jabs(lp, lw), jabs(fp, fw)
            d = float(np.linalg.norm(Lw - Fw))
            dist_pre.append(d)
            lo, fo = observed(lp, lw), observed(fp, fw)

            if lo and fo:
                st["both_obs"] += 1
                continue                  # 観測は触らない（距離は診断として記録済み）
            if d > 0.9:
                st["skipped_far"] += 1    # ここまで離れていたらホールド区間の方を疑う
                continue

            if lo != fo:                  # 片方だけ観測 → 転写
                src_p, src_k = (lp, lw) if lo else (fp, fw)
                dst_p, dst_k = (fp, fw) if lo else (lp, lw)
                anchor = jabs(src_p, src_k)
                sho, elb = ARM_OF_WRIST[dst_k]
                # 観測手首から相手の肘方向に少しオフセット（手のひら分）
                eref = jabs(dst_p, elb) if usable(dst_p, elb) else anchor + np.array([0, -0.1, 0])
                dir_v = eref - anchor
                n = np.linalg.norm(dir_v)
                target = anchor + (dir_v / n * args.hold_offset if n > 1e-6 else 0.0)
                S = jabs(dst_p, sho)
                E, W = two_bone_ik(S, target, bone_len(dst_p, sho, elb),
                                   bone_len(dst_p, elb, dst_k), eref)
                set_jabs(dst_p, elb, E)
                set_jabs(dst_p, dst_k, W)
                # 実観測+物理拘束による転写なので「観測に準ずる」扱いで実線描画にする
                dst_p["vis"][dst_k] = 0.45
                st["transfer"] += 1
            else:                         # 両方推定 → 中点で結合
                mid = (Lw + Fw) / 2
                for p, k in ((lp, lw), (fp, fw)):
                    sho, elb = ARM_OF_WRIST[k]
                    eref = jabs(p, elb) if usable(p, elb) else mid + np.array([0, -0.1, 0])
                    S = jabs(p, sho)
                    E, W = two_bone_ik(S, mid, bone_len(p, sho, elb), bone_len(p, elb, k), eref)
                    set_jabs(p, elb, E)
                    set_jabs(p, k, W)
                st["midpoint"] += 1

    # ── 2. 接地ロック ──────────────────────────────────────
    ank_ys = [jabs(p, k)[1] for i, fr in enumerate(frames) for p in fr["persons"]
              for k in (L_ANK, R_ANK) if usable(p, k)]
    floor_y = float(np.percentile(ank_ys, 2.0))
    dt = float(np.median(np.diff(ts)))

    fs = {"spans": 0, "frames": 0, "drift_pre": []}
    for pid in (0, 1):
        idxs = sorted(by_pid[pid].keys())
        if len(idxs) < 5:
            continue
        for ank in (L_ANK, R_ANK):
            hip, kne = LEG_OF_ANKLE[ank]
            # 接地候補: 連続フレームで水平速度と高さが小さい
            marks = []
            for a, b in zip(idxs[:-1], idxs[1:]):
                if b - a > 2 or ts[b] - ts[a] > dt * 2.5:
                    continue
                p0, p1 = by_pid[pid][a], by_pid[pid][b]
                if not (usable(p0, ank) and usable(p1, ank)):
                    continue
                q0, q1 = jabs(p0, ank), jabs(p1, ank)
                v = np.hypot(q1[0] - q0[0], q1[2] - q0[2])
                if v < args.contact_speed and q1[1] < floor_y + args.contact_height:
                    marks.append(b)
            if not marks:
                continue
            # 連続区間へまとめ、3フレーム以上だけ採用
            spans = []
            s = e = marks[0]
            for m in marks[1:]:
                if m - e <= 1:
                    e = m
                else:
                    if e - s >= 2:
                        spans.append((s, e))
                    s = e = m
            if e - s >= 2:
                spans.append((s, e))

            for s, e in spans:
                span = [i for i in range(s, e + 1) if i in by_pid[pid]
                        and usable(by_pid[pid][i], ank)]
                if len(span) < 3:
                    continue
                pos = np.array([jabs(by_pid[pid][i], ank) for i in span])
                anchor = np.median(pos, axis=0)
                fs["drift_pre"].append(float(np.mean(np.linalg.norm(
                    np.diff(pos[:, [0, 2]], axis=0), axis=1))))
                fs["spans"] += 1
                for n_, i in enumerate(span):
                    p = by_pid[pid][i]
                    # 端2フレームはランプして繋ぐ
                    w = min(1.0, min(n_, len(span) - 1 - n_) / 2.0 + 0.5) if len(span) > 3 else 1.0
                    cur = jabs(p, ank)
                    tgt = np.array([anchor[0], max(cur[1], floor_y), anchor[2]])
                    newp = cur * (1 - w) + tgt * w
                    kref = jabs(p, kne) if usable(p, kne) else (jabs(p, hip) + newp) / 2
                    K, A = two_bone_ik(jabs(p, hip), newp,
                                       bone_len(p, hip, kne), bone_len(p, kne, ank), kref)
                    set_jabs(p, kne, K)
                    set_jabs(p, ank, A)
                    fs["frames"] += 1

    json.dump(data, open(args.out, "w"))
    dp = np.array(dist_pre) if dist_pre else np.array([0.0])
    n2d = sum(1 for s in segs if s[4] == "2d")
    n3d = len(segs) - n2d
    covered = sum(1 for t in ts if any(s[0] - 0.05 <= t <= s[1] + 0.05 for s in segs))
    print(f"ホールド区間: {len(segs)}本（holdTimeline {n2d} + 3D追加検出 {n3d}）  "
          f"対象フレーム {st['frames_in_hold']}  "
          f"カバレッジ {covered}/{len(ts)} = {covered/max(1,len(ts))*100:.0f}%", file=sys.stderr)
    for s in sorted(segs, key=lambda s: s[0]):
        names = {L_WRI: "左手首", R_WRI: "右手首"}
        print(f"  [{s[4]}] {s[0]:6.2f}〜{s[1]:6.2f}s  L{names[s[2]]}×F{names[s[3]]}",
              file=sys.stderr)
    print(f"  つないでいるはずの手首間距離(修正前): median={np.median(dp)*100:.1f}cm "
          f"p95={np.percentile(dp,95)*100:.1f}cm   ← 腕推定の誤差の実測値", file=sys.stderr)
    print(f"  観測→推定の転写 {st['transfer']}  両推定を中点結合 {st['midpoint']}  "
          f"両観測(無修正) {st['both_obs']}  遠すぎて除外 {st['skipped_far']}", file=sys.stderr)
    drift = np.array(fs["drift_pre"]) if fs["drift_pre"] else np.array([0.0])
    print(f"接地ロック: {fs['spans']}区間 {fs['frames']}フレーム  "
          f"床y={floor_y:.2f}m  修正前の足滑り median={np.median(drift)*100:.1f}cm/フレーム",
          file=sys.stderr)
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
