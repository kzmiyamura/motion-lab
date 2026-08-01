#!/usr/bin/env python3
"""
On1/On2 判定の CV 材料を作る（ロードマップ⑥の第一弾）。

サルサの「ブレーク」（前後ステップの折り返し = 体重を入れ替える瞬間）は
On1 なら 1・5 拍、On2 なら 2・6 拍に落ちる。ここでは CV として:

  1. リーダーの腰X座標の折り返し（速度ゼロ交差 = 位置の極値）を「ブレーク候補」として検出
  2. それを analyze_beats が出した beatGrid（等間隔の拍格子）に畳み込み、
     - 8カウント上のどの位置にブレークが集まるか（ヒストグラム）
     - 拍の上に乗っている割合（onBeatRatio）・規則性（4拍周期で2山か）
     を計測する

【重要な限界】音声からは「どの拍がカウント1か」は決まらない（analyze_beats のコメント参照）。
したがって CV はグリッド相対の「ブレークが集まる拍位置」までしか出せない。
On1（ブレーク=1&5）か On2（ブレーク=2&6）かの最終判断は、この材料＋キーフレーム＋
サルサ知識（音楽の1拍目・技の慣例）を持つ Judge層（Claude）が行う。

依存は標準ライブラリのみ（analyze_skill と同じ軽量方針）。

Usage: python analyze_onbeat.py <tracks_json> <measurements_json>
       measurements.summary.onBeat に結果を書き込む（in-place）。
"""
import sys
import json

L_HIP, R_HIP = 11, 12
KP_CONF = 0.3
# ブレークとみなす最小スイング振幅（正規化X）。これ未満の折り返しはジッタとして無視
MIN_SWING = 0.012
# オンビート許容（拍のこのフラクション以内なら「拍の上」）
ON_BEAT_TOL = 0.28


def leader_hipx_series(frames, leader_pid):
    """(t, hipX) の時系列。hipX があればそれ、無ければ腰キーポイントから算出"""
    out = []
    for df in frames:
        for p in df.get("kept", []):
            if p.get("pid") != leader_pid:
                continue
            hx = p.get("hipX")
            if hx is None:
                ks = p.get("kps")
                if ks and ks[L_HIP][2] >= KP_CONF and ks[R_HIP][2] >= KP_CONF:
                    hx = (ks[L_HIP][0] + ks[R_HIP][0]) / 2
            if hx is not None:
                out.append((df["t"], hx))
            break
    return out


def detect_breaks(series):
    """腰Xの極値（折り返し）をブレーク時刻として返す。
    速度の符号反転 = 位置の山/谷。前後の振幅が MIN_SWING を超えるものだけ採用。"""
    if len(series) < 3:
        return []
    # 軽く平滑化（3点移動平均）してジッタを除く
    ts = [t for t, _ in series]
    xs = [x for _, x in series]
    sm = xs[:]
    for i in range(1, len(xs) - 1):
        sm[i] = (xs[i - 1] + xs[i] + xs[i + 1]) / 3
    breaks = []
    last_ext_x = sm[0]
    for i in range(1, len(sm) - 1):
        dprev = sm[i] - sm[i - 1]
        dnext = sm[i + 1] - sm[i]
        # 符号反転 = 極値（+→- 山、-→+ 谷）
        if dprev == 0 or (dprev > 0) == (dnext > 0):
            continue
        # 直前に採用した極値からの振幅が十分か（往復の片道が MIN_SWING 以上）
        if abs(sm[i] - last_ext_x) < MIN_SWING:
            continue
        breaks.append(ts[i])
        last_ext_x = sm[i]
    return breaks


def fold(breaks, grid):
    """ブレーク時刻を beatGrid に畳み込む。各ブレークの (mod8位置, 拍からのずれ) を返す"""
    first = grid["firstBeatSec"]
    interval = grid["beatIntervalSec"]
    folded = []
    for t in breaks:
        phase = (t - first) / interval
        nearest = round(phase)
        offset = phase - nearest            # 拍単位のずれ（±0.5）
        folded.append((int(nearest) % 8, offset, int(nearest)))
    return folded


def compute_onbeat(tracks, grid):
    frames = tracks.get("frames", [])
    leader_pid = tracks.get("leaderPid")
    if leader_pid is None or not grid:
        return None
    series = leader_hipx_series(frames, leader_pid)
    breaks = detect_breaks(series)
    if not breaks:
        return {"leaderBreaks": 0, "note": "ブレーク（腰Xの折り返し）を検出できず。横向き/密着で腰Xが動かない動画の可能性"}

    folded = fold(breaks, grid)
    hist = [0] * 8
    on_beat = 0
    abs_off_sum = 0.0
    even = odd = 0
    for mod8, offset, nearest in folded:
        hist[mod8] += 1
        abs_off_sum += abs(offset)
        if abs(offset) <= ON_BEAT_TOL:
            on_beat += 1
        if nearest % 2 == 0:
            even += 1
        else:
            odd += 1
    n = len(folded)

    # 規則性: ブレークは 4拍周期で2山（k と k+4）に集まるはず。
    # k=0..3 で hist[k]+hist[k+4] が最大になる組を「主ブレーク拍」とする。
    best_k, best_pair = 0, -1
    for k in range(4):
        s = hist[k] + hist[k + 4]
        if s > best_pair:
            best_pair, best_k = s, k
    regularity = round(best_pair / n, 3) if n else 0.0

    return {
        "leaderBreaks": n,
        "beatHistogram8": hist,          # グリッド相対の8カウント位置ごとのブレーク数
        "dominantBeatsMod8": [best_k, best_k + 4],  # ブレークが集まるグリッド拍（0始まり）
        "onBeatRatio": round(on_beat / n, 3),        # 拍の上に乗っている割合
        "meanAbsOffsetBeats": round(abs_off_sum / n, 3),
        "parity": {"even": even, "odd": odd},
        "regularity": regularity,        # 4拍周期2山への集中度（1に近い=きれいな基本ステップ）
        "beatGridConfidence": grid.get("confidence"),
        "note": (
            "グリッド相対。musical count-1 は音声から未確定。"
            "On1(break=1&5) か On2(break=2&6) の最終判断は Judge層がキーフレーム＋"
            "音楽知識で行う。dominantBeatsMod8 は『最強オンセット拍から何拍後にブレークが来るか』の材料"
        ),
    }


def main():
    if len(sys.argv) != 3:
        print("Usage: analyze_onbeat.py <tracks_json> <measurements_json>", file=sys.stderr)
        sys.exit(1)
    tracks_path, meas_path = sys.argv[1], sys.argv[2]

    with open(meas_path) as f:
        meas = json.load(f)
    grid = meas.get("summary", {}).get("beatGrid")

    try:
        with open(tracks_path) as f:
            tracks = json.load(f)
    except FileNotFoundError:
        tracks = {"frames": [], "leaderPid": None}

    onbeat = compute_onbeat(tracks, grid) if grid else None
    meas.setdefault("summary", {})["onBeat"] = onbeat

    with open(meas_path, "w") as f:
        json.dump(meas, f)

    if onbeat and onbeat.get("leaderBreaks"):
        print(f"onbeat: breaks={onbeat['leaderBreaks']} dominant={onbeat['dominantBeatsMod8']} "
              f"onBeatRatio={onbeat['onBeatRatio']} regularity={onbeat['regularity']}", file=sys.stderr)
    else:
        print(f"onbeat: {onbeat['note'] if onbeat else 'beatGrid なし → スキップ'}", file=sys.stderr)


if __name__ == "__main__":
    main()
