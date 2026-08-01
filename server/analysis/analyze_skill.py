#!/usr/bin/env python3
"""
tracks.json（骨格原盤）から「上手さ指標」を計算する。ロードマップの先にある
ビジョン「ダンス版トラックマン＝上手さの定量化」の第一歩。

上手さの正解ラベルは無いので、ここでは物理的に意味のある生の指標だけを出す。
複数のプロ動画で計算して「基準分布」を作り、新しい踊り手をその分布からの距離で
採点するのが本来の使い方（お手本ライブラリ方式）。

依存は標準ライブラリのみ（analyze_pair は import しない＝軽量・遅延なし）。

## 役割別の上手さ定義（リーダーとフォロワーは仕事が違うので軸を分ける）

リーダー = 「動く土台」。自分がブレると相手が回れない。省エネで明確にリードするのが上手さ:
- axisUprightMean: 体軸の直立度（鼻が腰の真上にあるか）。小さいほど芯が通る
- baseStability: 腰（土台）の左右ブレの小ささ。相手を回している間も腰が暴れない
- postureBounce: 腰の上下動の滑らかさ（体重移動の質）
- leadClarity: 手首の動きのメリハリ（静→動のコントラスト）。リードが読み取りやすい

フォロワー = 「回る側」。キレよく回り、その場に留まる（スポット）のが上手さ:
- turnAxisStability: ターン中の体軸ブレの小ささ。回転中も軸が立っている
- spotTightness: ターン中の腰の水平移動の小ささ。回りながら流れない（スポットが締まる）
- turnCrispnessSec: 1回転の所要時間の中央値（速いほどキレ）
- axisUprightMean: 全編の体軸直立度（共通指標だがフォロワーにも重要）

値はすべて「小さいほど上手い」向き（turnCrispnessSec のみ小さい=速い=上手い）。
正解ラベルは無いので生値を出し、複数プロ動画で基準分布を作る前提（お手本ライブラリ方式）。

Usage: python analyze_skill.py <tracks_json> [<events_json>]
       events_json 省略時は tracks 内に events があればそれを使う
"""
import sys
import json
import math

# COCO
NOSE, L_SH, R_SH, L_WR, R_WR, L_HIP, R_HIP = 0, 5, 6, 9, 10, 11, 12
KP_CONF = 0.3


def kp(p, i):
    """kps[i] を (x, y, conf) で返す。tracks の kept[].kps は [x,y,conf] の配列"""
    return p["kps"][i]


def body_axis_offset(p):
    """鼻が腰中点の真上からどれだけ横にずれているか（身長で正規化）。取れなければ None"""
    ks = p.get("kps")
    if not ks:
        return None
    nose, lh, rh = ks[NOSE], ks[L_HIP], ks[R_HIP]
    lsh, rsh = ks[L_SH], ks[R_SH]
    if min(nose[2], lh[2], rh[2], lsh[2], rsh[2]) < KP_CONF:
        return None
    hip_mid_x = (lh[0] + rh[0]) / 2
    hip_mid_y = (lh[1] + rh[1]) / 2
    sh_mid_y = (lsh[1] + rsh[1]) / 2
    body_h = abs(hip_mid_y - sh_mid_y)  # 肩→腰の縦距離（身長の代理。全身より安定して取れる）
    if body_h < 1e-4:
        return None
    return abs(nose[0] - hip_mid_x) / body_h


def std(values):
    if len(values) < 2:
        return None
    m = sum(values) / len(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / len(values))


def median(values):
    if not values:
        return None
    s = sorted(values)
    return s[len(s) // 2]


def person_of(df, pid):
    for p in df["kept"]:
        if p.get("pid") == pid:
            return p
    return None


def hip_mid(ks):
    if ks[L_HIP][2] < KP_CONF or ks[R_HIP][2] < KP_CONF:
        return None
    return ((ks[L_HIP][0] + ks[R_HIP][0]) / 2, (ks[L_HIP][1] + ks[R_HIP][1]) / 2)


def body_height(ks):
    if ks[L_HIP][2] < KP_CONF or ks[R_HIP][2] < KP_CONF or ks[L_SH][2] < KP_CONF or ks[R_SH][2] < KP_CONF:
        return None
    h = abs((ks[L_HIP][1] + ks[R_HIP][1]) / 2 - (ks[L_SH][1] + ks[R_SH][1]) / 2)
    return h if h > 1e-4 else None


def collect(frames, pid, pred=None):
    """pred(t) が真（Noneなら全編）のフレームで pid の人物レコードを列挙"""
    out = []
    for df in frames:
        if pred is not None and not pred(df["t"]):
            continue
        p = person_of(df, pid)
        if p is not None and p.get("kps"):
            out.append((df["t"], p))
    return out


def wrist_speed_series(recs):
    """手首（左右の平均位置）の毎フレーム速度。リードのメリハリ計算用"""
    speeds = []
    prev = None
    for t, p in recs:
        ks = p["kps"]
        pts = [ks[i] for i in (L_WR, R_WR) if ks[i][2] >= KP_CONF]
        if not pts:
            prev = None
            continue
        cx = sum(q[0] for q in pts) / len(pts)
        cy = sum(q[1] for q in pts) / len(pts)
        if prev is not None:
            speeds.append(math.hypot(cx - prev[0], cy - prev[1]))
        prev = (cx, cy)
    return speeds


def compute_skill(tracks, events):
    frames = tracks["frames"]
    leader_pid = tracks.get("leaderPid")
    if leader_pid is None:
        return {"leader": None, "follower": None}
    follower_pid = 1 - leader_pid

    def upright_and_bounce(pid):
        offs, hipxs, hipys = [], [], []
        for _, p in collect(frames, pid):
            off = body_axis_offset(p)
            if off is not None:
                offs.append(off)
            hm = hip_mid(p["kps"])
            bh = body_height(p["kps"])
            if hm is not None and bh is not None:
                hipxs.append(hm[0] / 1.0)  # 正規化X（tracks は既に0-1正規化済み）
                hipys.append(hm[1])
        return offs, hipxs, hipys

    def turn_metrics(role, pid):
        turn_times = [e["t"] for e in events if e["type"] == "Turn" and e["by"] == role]
        near = lambda t: any(abs(t - tt) <= 0.7 for tt in turn_times)
        recs = collect(frames, pid, near)
        offs, hipxs = [], []
        for _, p in recs:
            off = body_axis_offset(p)
            if off is not None:
                offs.append(off)
            hm = hip_mid(p["kps"])
            if hm is not None:
                hipxs.append(hm[0])
        # ターンのキレ: rotations と検出間隔からは正確に出せないので、
        # イベントの rotations 合計 / ターン周辺の実フレーム秒数 = 1回転あたり秒数の近似
        total_rot = sum(e.get("rotations", 1) for e in events if e["type"] == "Turn" and e["by"] == role)
        turn_secs = len(recs) * (1.0 / max(1.0, tracks.get("sampledFps", 10)))
        crisp = round(turn_secs / total_rot, 3) if total_rot > 0 else None
        return turn_times, offs, hipxs, crisp

    # リーダー: 土台の安定・リードの明確さ
    l_offs, l_hipxs, l_hipys = upright_and_bounce(leader_pid)
    l_wsp = wrist_speed_series(collect(frames, leader_pid))
    leader = {
        "axisUprightMean": round(sum(l_offs) / len(l_offs), 4) if l_offs else None,
        "baseStability": round(std(l_hipxs), 4) if l_hipxs else None,
        "postureBounce": round(std(l_hipys), 4) if l_hipys else None,
        # リードの明確さ = 手首速度のメリハリ（標準偏差/平均。大きいほど静→動がはっきり）
        "leadClarity": round(std(l_wsp) / (sum(l_wsp) / len(l_wsp)), 3) if l_wsp and sum(l_wsp) > 0 else None,
        "samples": len(l_offs),
    }

    # フォロワー: ターンのキレ・スポット維持
    f_offs_all, _, _ = upright_and_bounce(follower_pid)
    f_times, f_turn_offs, f_turn_hipxs, f_crisp = turn_metrics("follower", follower_pid)
    follower = {
        "axisUprightMean": round(sum(f_offs_all) / len(f_offs_all), 4) if f_offs_all else None,
        "turnAxisStability": round(std(f_turn_offs), 4) if f_turn_offs else None,
        "spotTightness": round(std(f_turn_hipxs), 4) if f_turn_hipxs else None,
        "turnCrispnessSec": f_crisp,
        "turnCount": len(f_times),
        "samples": len(f_offs_all),
    }
    return {"leader": leader, "follower": follower}


def main():
    if len(sys.argv) not in (2, 3):
        print("Usage: analyze_skill.py <tracks_json> [<events_json>]", file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[1]) as f:
        tracks = json.load(f)
    if len(sys.argv) == 3:
        with open(sys.argv[2]) as f:
            events = json.load(f).get("events", [])
    else:
        events = tracks.get("events", [])

    skill = compute_skill(tracks, events)
    print(json.dumps({"video": tracks.get("video"), "skill": skill}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
