#!/usr/bin/env python3
"""
Claude が書いた result.json の routine.moves を、振付シートとして踊れる形に整える（決定的な後処理）。

Claude の routine は技イベントの時刻（CBL・ターンの瞬間）から作るので、
  - 技の境目が拍・8カウントの頭に乗らない（「1-16」なのに 4 秒、1-8 が 1 秒おきに 2 つ 等）
  - 1×8 に満たない細切れの行・同じ技の重複行が並ぶ
  - 計測の誤差で回転数が大きすぎる（3回転・4½回転）
  - 技名が長い説明文になる
ことがある。ここでそれを機械的に直す:

1. 8カウント（1×8）の長さを決める: 音声のビート格子があれば 8 拍。無ければ（画面収録など無音）
   CV の左右入れ替わり（summary.events の CBL）が 8 カウントの同じ位置（On2 の CBL なら女が 5 で通る）に
   最もよく揃う周期・位相（・ゆっくりしたテンポの変化）を、Claude の routine の間隔を目安に探す。
   入れ替わりが少ない・揃わないときは、routine の間隔の中央値から推定し技の頭の時刻に合わせる（従来）
2. 位相（8カウントの頭がどこか）: 音声なら技の頭の時刻が最もよく乗る拍。入れ替わりで当てたならそれで決まる。
   各技の start を最寄りの 8 カウントの頭へ寄せる。入れ替わりで当てたときは、Claude の行の順番を保ったまま
   CBL 系の行が入れ替わりのある 8 カウントに来るよう前後にずらす（Claude の行の時刻が 1 行ずれることがある）
3. 同じ頭に寄った技は 1 行にまとめる（ターン・パスがある方を主にする）。counts は次の技の頭までの 8 の倍数
4. 回転数は ½ 刻みに丸め、2 回転を上限にする（画像で見えていて自信 0.7 以上なら 3 回転まで）。
   削ったら自信を下げて「?」が付くようにする
5. 技名は全角 14 文字以内に縮める（括弧書きを落とし「クロスボディリード」→「CBL」等）
6. 各技に、カウントごとに男女が何をするかの短い行（steps）を付ける。Claude が書いていればそれを使い、
   無ければ技の種類・回転・通る側から決まった言い回しで埋める。
   On1/On2 は Claude が on1/on2 と書いていればそれ、無い・unclear なら On2（ユーザーの動画は基本 On2）。
   On2 のベーシックは Claude の行でも On2 の決まった言い回しに置き換える（動画ごとの情報が無く、
   On1 の数え方「1-2-3 男:前へ」で書かれていることがあるため）

元の行は routine.rawMoves に残す（何度実行しても rawMoves から作り直すので結果は同じ）。

Usage: python normalize_routine.py <result.json> <measurements.json> [--default-onbeat=on2]
  result.json をその場で書き換える。routine.moves が無ければ何もしない
"""
import bisect
import json
import math
import os
import re
import sys

NAME_MAX = 14
MIN_UNIT8 = 1.6     # 1×8 の秒数の下限（≒ 300 BPM）
MAX_UNIT8 = 6.0     # 上限（≒ 80 BPM）
DEFAULT_UNIT8 = 8 * 60 / 170
MAX_ROT = 2.0
MAX_ROT_STRONG = 3.0
STRONG_CONF = 0.7
LOW_CONF = 0.35

# 無音の動画で、CV の左右入れ替わり（summary.events の CBL）から格子を当てるときの設定
SWAP_MIN = 8               # 入れ替わりがこれ未満なら使わない（routine の間隔から推定する従来の方法へ）
SWAP_MIN_R = 0.2           # 当てた周期での入れ替わりの位相の揃い方（Rayleigh R）がこれ未満なら使わない
SWAP_MIN_Z = 7.5           # 入れ替わり＋ターンの Rayleigh z = n·R² がこれ未満なら使わない。でたらめな時刻でも
                           # 周期を ±25% 振れば z の最大は中央値 4.6・95% 点 7.4 くらいになる（50 個・156 秒で試算）
SWAP_PERIOD_RANGE = 0.25   # 周期を routine の目安の ±25% で探す
SWAP_PERIOD_STEP = 0.002   # 秒。156 秒で 60 個の 8 カウントなら、0.002 秒の差が終わりで 0.12 拍になる
SWAP_PRIOR = 0.1           # 目安から離れた周期への小さな罰（同じくらい揃うなら目安に近い方）
SWAP_DRIFT_MAX = 2.0       # テンポの変化: 終わりまでに等速の格子から最大 2 個分の 8 カウントずれてよい
                           # （周期の当てはめで吸収しきれずに残るずれは drift の ⅛ 程度。¾ 以下なら等速で足りる）
DRIFT_MIN_GAIN = 0.05      # drift を入れるのは R がこれ以上良くなるときだけ（ノイズへの当てはめすぎを防ぐ）
SWAP_BEAT = 7.0            # CV の入れ替わり時刻が来る、8 カウントの頭からの拍数（下の説明）
# SWAP_BEAT: On2 の CBL では男が 2 で下がって 3 で開き、女は 2 で前へ出てそのまま 5 で男の前を通る
# （腰の左右が入れ替わる）。CV の入れ替わり時刻（detect_cbl）は「入れ替わった後に 2 人とも見えた最初のコマ」
# なので本当の入れ替わりより遅れる。値は正解表で決めた（1230b3d5 は On2。eval_routine_grid.py、ジョブ
# 2f4b6919 / 581ef6a2）: 7.0 で正解の入れ替わりの平均がカウント 4.96（= 5 で通る）。6.5 → 4.4、7.5 → 5.5。
# 行の一致・CBL の再現率は 6.0〜7.0 でほぼ同じ（差は 1〜2 行）なので、On2 の「5 で通る」に合う 7.0 のまま
DEFAULT_TIMING = "on2"     # Claude が on1/on2 を書かなかった（unclear）ときの数え方。ユーザーの動画は基本 On2
SWAP_ALIGN_WEIGHT = 1.0    # 行を入れ替わりに合わせ直すとき、CBL 系の行と入れ替わりの有無が食い違う罰
SWAP_SHIFT_WEIGHT = 0.5    # 同じく、行を元の時刻から 1 行ぶん動かす罰（1 行ずらして食い違いが 1 つ減るなら動かす）
SWAP_MERGE_WEIGHT = 1.0    # 同じく、2 行を同じ 8 カウントにまとめる罰（Claude の行が 1 つ消える）

DEFAULT_NAME = {
    "basic": "ベーシック", "cbl": "CBL", "cbl_inside_turn": "CBL＋インサイド",
    "cbl_outside_turn": "CBL＋アウトサイド", "reverse_cbl": "逆CBL", "right_turn": "右ターン",
    "left_turn": "左ターン", "inside_turn": "インサイドターン", "outside_turn": "アウトサイドターン",
    "leader_turn": "男性ターン", "copa": "コパ", "hand_change": "持ち替え", "wrap": "ラップ",
    "hammerlock": "ハンマーロック", "shadow": "シャドウ", "dip": "ディップ", "shine": "シャイン",
    "other": "その他",
}
LIGHT_MOVES = {"basic", "shine", "other", "hand_change"}
CBL_MOVES = {"cbl", "cbl_inside_turn", "cbl_outside_turn", "reverse_cbl"}   # 男女の左右が入れ替わる技


# ---------------------------------------------------------------- 周期と位相

def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def grid_from_beats(summary):
    """音声のビート格子 → (1×8 の秒数, 拍の秒数, 最初の拍の秒)。無ければ None"""
    g = (summary or {}).get("beatGrid") or {}
    beat = g.get("beatIntervalSec")
    if not _num(beat):
        bpm = g.get("bpm")
        beat = 60.0 / bpm if _num(bpm) and bpm > 0 else None
    if not _num(beat) or not (MIN_UNIT8 / 8 <= beat <= MAX_UNIT8 / 8):
        return None
    first = g.get("firstBeatSec")
    return 8 * beat, beat, float(first) if _num(first) else 0.0


def unit8_from_routine(moves):
    """Claude の routine から 1×8 の秒数の目安（各行の長さ ÷ 8カウントの数 の中央値）"""
    vals = []
    for a, b in zip(moves, moves[1:]):
        s0, s1 = a.get("start"), b.get("start")
        if not (_num(s0) and _num(s1)) or s1 <= s0:
            continue
        c = a.get("counts")
        n8 = max(1, round(c / 8)) if _num(c) and c > 0 else 1
        vals.append((s1 - s0) / n8)
    if not vals:
        return None
    vals.sort()
    u = vals[len(vals) // 2]
    return min(max(u, MIN_UNIT8), MAX_UNIT8)


def snap_cost(starts, period, phase):
    """各 start と最寄りの格子線との距離（周期で割った値）の二乗和"""
    tot = 0.0
    for s in starts:
        d = (s - phase) / period
        tot += (d - round(d)) ** 2
    return tot


def best_phase(starts, period, candidates):
    return min(candidates, key=lambda p: (snap_cost(starts, period, p), p))


def fit_grid(starts, unit_guess):
    """拍が分からないとき: 周期を目安の ±12% で探し、位相も合わせる。
    周期が短いほど誤差は小さくなりがちなので、格子線のうち技の頭が来ない線の割合も罰する"""
    best = None
    for k in range(-12, 13):
        period = unit_guess * (1 + k / 100)
        if not (MIN_UNIT8 <= period <= MAX_UNIT8):
            continue
        phases = [period * i / 32 for i in range(32)]
        phase = best_phase(starts, period, phases)
        err = snap_cost(starts, period, phase) / max(1, len(starts))
        idx = {round((s - phase) / period) for s in starts}
        span = (max(idx) - min(idx) + 1) if idx else 1
        empty = 1 - len(idx) / span
        score = err + 0.15 * empty
        if best is None or score < best[0] - 1e-12:
            best = (score, period, phase)
    if best is None:
        return unit_guess, 0.0
    return best[1], best[2]


# ---------------------------------------------------------------- CV の入れ替わりから格子を当てる（無音のとき）

def swap_times(summary):
    """measurements.json の summary.events から CV の左右入れ替わり（CBL）の時刻"""
    ev = (summary or {}).get("events") or []
    return sorted(e["t"] for e in ev if isinstance(e, dict) and e.get("type") == "CBL" and _num(e.get("t")))


def turn_times(summary):
    """同じく女性のターンの時刻（周期の手がかりを増やすのに使う）"""
    ev = (summary or {}).get("events") or []
    return sorted(e["t"] for e in ev if isinstance(e, dict) and e.get("type") == "Turn"
                  and e.get("by") == "follower" and _num(e.get("t")))


def grid_cycles(t, period, drift, span):
    """時刻 t までに進んだ 8 カウントの数（格子の位相）。drift はテンポのゆっくりした変化で、
    動画の終わりまでに位相が等速の格子から何 8 カウントずれるか"""
    return t / period + drift * (t / span) ** 2


def swap_concentration(swaps, period, drift=0.0, span=1.0):
    """入れ替わりが 8 カウントの同じ位置に集まっている度合い（Rayleigh の R、0〜1）と、その平均位置（周期の割合）"""
    if not swaps:
        return 0.0, 0.0
    c = s = 0.0
    for t in swaps:
        a = 2 * math.pi * grid_cycles(t, period, drift, span)
        c += math.cos(a)
        s += math.sin(a)
    c, s = c / len(swaps), s / len(swaps)
    return math.hypot(c, s), (math.atan2(s, c) / (2 * math.pi)) % 1


def fit_grid_to_swaps(swaps, unit_guess, duration, turns=()):
    """CV の入れ替わり時刻に 8 カウントの格子を当てる。CBL なら入れ替わりは毎回 8 カウントの同じ所
    （On2 は 5）に来るので、周期を目安の ±SWAP_PERIOD_RANGE で振って位相が最も揃う周期を取る。
    周期（と揃っているかの判定）には女性のターン（turns）も足す。ターンも 8 カウントの決まった所で回るので
    手がかりが増える（1230b3d5: 入れ替わりだけだと z=5.2 で偶然と見分けられないが、ターンを足すと 8.8）。
    8 カウントの頭（位相）は入れ替わりだけで決める（ターンは 1-3 で回る技もあり位置が決まらない）。
    テンポがゆっくり変わる（drift）ことも許すが、揃い方が DRIFT_MIN_GAIN 以上良くなるときだけ。
    戻り値 {period, drift, span, head0, R, z} か、入れ替わりが少ない・揃わないとき None"""
    if len(swaps) < SWAP_MIN or not unit_guess:
        return None
    events = sorted(list(swaps) + list(turns or ()))
    span = max(duration or 0, events[-1], 1.0)

    def score(p, q):
        r, _ = swap_concentration(events, p, q, span)
        return r - SWAP_PRIOR * abs(math.log(p / unit_guess)), r

    lo = max(MIN_UNIT8, unit_guess * (1 - SWAP_PERIOD_RANGE))
    hi = min(MAX_UNIT8, unit_guess * (1 + SWAP_PERIOD_RANGE))
    cands = []
    p = lo
    while p <= hi + 1e-9:
        cands.append(p)
        p += SWAP_PERIOD_STEP
    best = max(((score(p, 0.0), p) for p in cands), key=lambda x: x[0][0])
    (_, r0), period = best
    drift = 0.0
    r_best = r0
    if SWAP_DRIFT_MAX > 0:
        # drift q は真ん中あたりの周期も q/span ほど変えるので、周期も ±4% 振り直す
        p0 = period
        for i in range(-40, 41):
            p = p0 * (1 + i * 0.001)
            for j in range(-round(SWAP_DRIFT_MAX / 0.1), round(SWAP_DRIFT_MAX / 0.1) + 1):
                q = j * 0.1
                r, _ = swap_concentration(events, p, q, span)
                if r > r_best + 1e-9 and (q == 0 or r >= r0 + DRIFT_MIN_GAIN):
                    r_best, period, drift = r, p, q
    z = len(events) * r_best ** 2
    if z < SWAP_MIN_Z:
        return None
    r_swap, mean = swap_concentration(swaps, period, drift, span)
    if r_swap < SWAP_MIN_R:
        return None
    # 入れ替わりの平均位置が 8 カウントの SWAP_BEAT 拍目に来るように頭を決める
    head0 = (mean - SWAP_BEAT / 8) % 1
    return {"period": period, "drift": drift, "span": span, "head0": head0, "R": r_swap, "z": z}


def swap_heads(fit, duration):
    """当てた格子の 8 カウントの頭の時刻（0 秒の手前 1 つから duration の後ろ 1 つまで）"""
    period, drift, span, head0 = fit["period"], fit["drift"], fit["span"], fit["head0"]
    end = max(duration or 0, span) + period

    def solve(k):
        # grid_cycles(t) = k + head0 を二分法で解く（単調増加の範囲で）
        a, b = -2 * period, end + 2 * period
        for _ in range(60):
            m = (a + b) / 2
            if grid_cycles(m, period, drift, span) < k + head0:
                a = m
            else:
                b = m
        return (a + b) / 2

    heads = []
    k = math.floor(grid_cycles(0, period, drift, span) - head0)
    while True:
        t = solve(k)
        if t > end:
            break
        if t > -period:
            heads.append(t)
        k += 1
    return heads


def nearest_head(heads, t):
    """t に最も近い 8 カウントの頭の番号"""
    i = bisect.bisect_left(heads, t)
    if i <= 0:
        return 0
    if i >= len(heads):
        return len(heads) - 1
    return i if heads[i] - t < t - heads[i - 1] else i - 1


def swap_cells(heads, swaps):
    """各 8 カウントに CV の入れ替わりがあるか。入れ替わりは頭から SWAP_BEAT 拍目に来る想定なので、
    そこから前後半周期（±4 拍）の入れ替わりをその 8 カウントのものとする"""
    has = [False] * len(heads)
    for s in swaps:
        for j in range(len(heads) - 1):
            b = (heads[j + 1] - heads[j]) / 8
            c = heads[j] + SWAP_BEAT * b
            if c - 4 * b <= s < c + 4 * b:
                has[j] = True
                break
    return has


def align_to_swaps(moves, heads, swaps):
    """Claude の行（時刻順）を 8 カウントへ順番を保って割り当てる。各行はまず元の時刻の最寄りの頭が候補で、
    CBL 系の行が入れ替わりのある 8 カウントに、そうでない行が入れ替わりの無い 8 カウントに来るよう
    前後にずらしてよい（Claude の行の時刻が 1 行ぶんずれていることがあるため）。
    罰: ずらした分 × SWAP_SHIFT_WEIGHT、食い違い × SWAP_ALIGN_WEIGHT。同じ 8 カウントに 2 行 → まとめる"""
    n = len(heads)
    has = swap_cells(heads, swaps)
    inf = float("inf")
    pref = [nearest_head(heads, m["start"]) for m in moves]
    span = [((heads[j + 1] - heads[j]) if j + 1 < n else (heads[j] - heads[j - 1])) for j in range(n)]

    def cost(i, j):
        shift = abs(heads[j] - moves[i]["start"]) / span[j] - abs(heads[pref[i]] - moves[i]["start"]) / span[pref[i]]
        miss = (moves[i].get("move") in CBL_MOVES) != has[j]
        return SWAP_SHIFT_WEIGHT * max(0.0, shift) + SWAP_ALIGN_WEIGHT * miss

    dp = [[inf] * n for _ in moves]
    back = [[-1] * n for _ in moves]
    for j in range(n):
        dp[0][j] = cost(0, j)
    for i in range(1, len(moves)):
        best, arg = inf, -1   # 前の行が j より前の頭のときの最小
        for j in range(n):
            # 前の行が同じ頭 j → 2 行をまとめる（Claude の行が 1 つ消えるので罰）
            same = dp[i - 1][j] + SWAP_MERGE_WEIGHT
            if best <= same and best < inf:
                dp[i][j], back[i][j] = best + cost(i, j), arg
            elif same < inf:
                dp[i][j], back[i][j] = same + cost(i, j), j
            if dp[i - 1][j] < best:
                best, arg = dp[i - 1][j], j
    j = min(range(n), key=lambda x: dp[-1][x])
    cells = [0] * len(moves)
    for i in range(len(moves) - 1, -1, -1):
        cells[i] = j
        j = back[i][j]
    return cells


# ---------------------------------------------------------------- 技名

_SHORT = [
    (r"クロス\s*ボディ\s*・?\s*リード", "CBL"),
    (r"リバース\s*[・\s]?\s*CBL", "逆CBL"),
    (r"\s*(→|⇒|・|から(の)?|からの|＋|\+)\s*", "＋"),
    (r"アウトサイドターン", "アウトサイド"),
    (r"男性の?", "男性"),
]


def short_name(raw, move):
    """全角14文字以内の技名。末尾の「?」は残す（アプリが「推定」バッジにする）"""
    name = raw.strip() if isinstance(raw, str) else ""
    q = bool(re.search(r"[?？]\s*$", name)) or "?" in name or "？" in name
    name = re.sub(r"[（(][^）)]*[）)]", "", name)
    name = name.replace("?", "").replace("？", "")
    name = re.sub(r"\s+", " ", name).strip(" ・＋")
    if len(name) > NAME_MAX:
        for pat, rep in _SHORT:
            name = re.sub(pat, rep, name)
        name = re.sub(r"＋+", "＋", name).strip("＋ ")
    if not name:
        name = DEFAULT_NAME.get(move, "技")
    elif len(name) > NAME_MAX:
        # 説明文になっている名前は、決まった技なら標準の名前、それ以外は頭だけ残す
        name = DEFAULT_NAME[move] if move in DEFAULT_NAME and move != "other" else name[:NAME_MAX - 1] + "…"
    return name + ("?" if q else "")


# ---------------------------------------------------------------- 回転

def round_half(x):
    return math.floor(x * 2 + 0.5) / 2


def clean_turn(turn, mv):
    """回転数を ½ 刻みに丸め上限で抑える。戻り値 (turn, capped)"""
    if not isinstance(turn, dict):
        return None, False
    t = dict(turn)
    r = t.get("rotations")
    capped = False
    if _num(r):
        r = max(0.5, round_half(r))
        conf = mv.get("confidence")
        strong = mv.get("evidence") == "seen" and _num(conf) and conf >= STRONG_CONF
        cap = MAX_ROT_STRONG if strong else MAX_ROT
        if r > cap:
            r, capped = cap, True
        t["rotations"] = r
    return t, capped


# ---------------------------------------------------------------- 行のまとめ

def weight(mv):
    """まとめるとき主にする行の重み（ターン・パスがある・技らしい・画像で見えた）"""
    w = 0.0
    t = mv.get("turn")
    if isinstance(t, dict) and _num(t.get("rotations")) and t["rotations"] >= 1:
        w += 2
    if mv.get("passSide") in ("left", "right", "return"):
        w += 2
    if mv.get("move") not in LIGHT_MOVES:
        w += 1
    if mv.get("evidence") == "seen":
        w += 0.5
    c = mv.get("confidence")
    if _num(c):
        w += c
    return w


def merge_group(group):
    """同じ 8 カウントに寄った行を 1 行に"""
    if len(group) == 1:
        return dict(group[0])
    main = max(group, key=weight)
    out = dict(main)
    out["holdStart"] = next((g.get("holdStart") for g in group if g.get("holdStart")), main.get("holdStart"))
    out["holdEnd"] = next((g.get("holdEnd") for g in reversed(group) if g.get("holdEnd")), main.get("holdEnd"))
    if not out.get("turn"):
        out["turn"] = next((g["turn"] for g in group if g.get("turn")), None)
    if not out.get("passSide"):
        out["passSide"] = next((g["passSide"] for g in group if g.get("passSide")), None)
    heavy = [g for g in group if g.get("move") not in LIGHT_MOVES]
    if len({g.get("move") for g in heavy}) > 1:
        # 別々の技が同じ 1×8 に入った = どちらかの時刻・種類が怪しい
        confs = [g.get("confidence") for g in group if _num(g.get("confidence"))]
        out["confidence"] = min(confs + [0.5])
    if any(g.get("evidence") == "inferred" for g in group) and main.get("evidence") != "seen":
        out["evidence"] = "inferred"
    out["mergedFrom"] = [g.get("name") or g.get("move") for g in group if g is not main]
    return out


# ---------------------------------------------------------------- カウントごとの動き

def rot_text(n):
    if not _num(n) or n <= 0:
        return ""
    h = round_half(n)
    whole = int(h)
    frac = "½" if h - whole >= 0.5 else ""
    return f"{whole if whole else ''}{frac}回転" if whole or frac else ""


def turn_text(turn, default_dir=None):
    if not isinstance(turn, dict):
        return ""
    d = turn.get("direction") or default_dir
    word = "右回り" if d == "right" else "左回り" if d == "left" else ""
    return f"{word}{rot_text(turn.get('rotations'))}" or "回る"


def template_steps(mv, timing):
    """技の種類から決まる、男女のカウントごとの動き。On1 以外（on2・unclear・無し）は On2 の言い方"""
    if timing != "on1":
        return template_steps_on2(mv)
    move = mv.get("move")
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else None
    who = (turn or {}).get("by")
    ftxt = turn_text(turn) if who in ("follower", "both") else ""
    pass_side = mv.get("passSide")
    side = "右" if pass_side == "right" else "左"
    a, b = "1-2-3", "5-6-7"
    if move == "basic":
        rows = [(a, "前へ", "後ろへ"), (b, "後ろへ", "前へ")]
    elif move == "cbl":
        rows = [(a, "3で左へ開く", "前へ"), (b, "向きを戻す", f"男の{side}を通る")]
    elif move in ("cbl_inside_turn", "inside_turn"):
        rows = [(a, "左へ開き手を上げる", "前へ"), (b, "頭上で回す", f"通りながら{turn_text(turn, 'left') or '左回り'}")]
    elif move in ("cbl_outside_turn", "outside_turn"):
        rows = [(a, "左へ開く", "前へ"), (b, "手を外へ回す", f"通りながら{turn_text(turn, 'right') or '右回り'}")]
    elif move == "reverse_cbl":
        rows = [(a, "3で右へ開く", "前へ"), (b, "向きを戻す", f"男の右を通る{('・' + ftxt) if ftxt else ''}")]
    elif move in ("right_turn", "left_turn"):
        d = "right" if move == "right_turn" else "left"
        rows = [(a, "手を上げる", "前へ"), (b, "頭上で回す", turn_text(turn, d) or ("右回り" if d == "right" else "左回り"))]
    elif move == "leader_turn":
        rows = [(a, f"自分で{turn_text(turn) or '回る'}", "その場"), (b, "向き直る", "前へ")]
    elif move == "copa":
        rows = [(a, "左へ開く", "男の前へ出る"), (b, "引き戻す", "半回転して戻る")]
    elif move == "hand_change":
        rows = [(a, "手を持ち替える", "ベーシック"), (b, "ベーシック", "ベーシック")]
    elif move == "shine":
        rows = [("1-8", "手を離して各自", "手を離して各自")]
    elif move == "wrap":
        rows = [(a, "手を上げる", "左回りで巻かれる"), (b, "腕で包む", "男の横に並ぶ")]
    elif move == "hammerlock":
        rows = [(a, "手を上げる", "回る"), (b, "背中で手を止める", "片手が背中に")]
    elif move == "shadow":
        rows = [(a, "女の後ろへ", "前へ"), (b, "同じ向きで踊る", "同じ向き")]
    elif move == "dip":
        rows = [(a, "支える", "後ろへ倒れる"), (b, "起こす", "戻る")]
    else:
        if not ftxt and not (turn and who == "leader"):
            return []
        rows = [(b, "手でリード" if ftxt else f"自分で{turn_text(turn)}", ftxt or "その場")]
    return [{"count": c, "leader": l, "follower": f} for c, l, f in rows]


def template_steps_on2(mv):
    """On2 の言い方。ブレークは 2 と 6（男は 2 で後ろ・6 で前、女はその逆）。
    CBL は男が 2 で下がった直後の 3 で開き、女は 2 で前へ出てそのまま 5 で男の前を通る。
    ターンは 1-2-3 で準備し 5-6-7 でリード、女は 5-6 で回って 7 で止まる"""
    move = mv.get("move")
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else None
    who = (turn or {}).get("by")
    ftxt = turn_text(turn) if who in ("follower", "both") else ""
    pass_side = mv.get("passSide")
    a, b = "1-2-3", "5-6-7"
    prep_l, prep_f = "2で下がり3で開く", "2で前へ出て前進"
    passing = "5で右を通過" if pass_side == "right" else "5で前を通過"
    if move == "basic":
        rows = [(a, "2で後ろへ", "2で前へ"), (b, "6で前へ", "6で後ろへ")]
    elif move == "cbl":
        rows = [(a, prep_l, prep_f), (b, "左へ送り向きを戻す", f"{passing}・向き直る")]
    elif move in ("cbl_inside_turn", "inside_turn"):
        rows = [(a, "2で下がり手を上げる" if move == "inside_turn" else prep_l, prep_f),
                (b, "頭上で回す", f"5-6で{turn_text(turn, 'left') or '左回り'}")]
    elif move in ("cbl_outside_turn", "outside_turn"):
        rows = [(a, "2で下がり手を上げる" if move == "outside_turn" else prep_l, prep_f),
                (b, "手を外へ回す", f"5-6で{turn_text(turn, 'right') or '右回り'}")]
    elif move == "reverse_cbl":
        rows = [(a, "2で下がり3で右へ開く", prep_f), (b, "右へ送り向きを戻す", f"5で右を通過{('・' + ftxt) if ftxt else '・向き直る'}")]
    elif move in ("right_turn", "left_turn"):
        d = "right" if move == "right_turn" else "left"
        rows = [(a, "2で下がり手を上げる", "2で前へ"),
                (b, "頭上で回す", f"5-6で{turn_text(turn, d) or ('右回り' if d == 'right' else '左回り')}")]
    elif move == "leader_turn":
        rows = [(a, f"自分で{turn_text(turn) or '回る'}", "その場"), (b, "6で前へ", "6で後ろへ")]
    elif move == "copa":
        rows = [(a, prep_l, "2で前へ出る"), (b, "引き戻す", "5で半回転して戻る")]
    elif move == "hand_change":
        rows = [(a, "手を持ち替える", "ベーシック"), (b, "ベーシック", "ベーシック")]
    elif move == "shine":
        rows = [("1-8", "手を離して各自", "手を離して各自")]
    elif move == "wrap":
        rows = [(a, "2で下がり手を上げる", "2で前へ"), (b, "腕で包む", "5-6で巻かれて並ぶ")]
    elif move == "hammerlock":
        rows = [(a, "2で下がり手を上げる", "2で前へ"), (b, "背中で手を止める", "5-6で回り手が背中に")]
    elif move == "shadow":
        rows = [(a, "女の後ろへ", "2で前へ"), (b, "同じ向きで踊る", "同じ向き")]
    elif move == "dip":
        rows = [(a, "支える", "後ろへ倒れる"), (b, "起こす", "戻る")]
    else:
        if not ftxt and not (turn and who == "leader"):
            return []
        rows = [(b, "手でリード" if ftxt else f"自分で{turn_text(turn)}", f"5-6で{ftxt}" if ftxt else "その場")]
    return [{"count": c, "leader": l, "follower": f} for c, l, f in rows]


def resolve_timing(routine, result, default=None):
    """On1/On2。Claude が on1/on2 と書いていればそれ、無い・unclear なら default（既定 DEFAULT_TIMING = On2）。
    前回ここで既定を入れた routine.timing（timingSource=default）は Claude の判断として扱わない。
    戻り値 (timing, source)"""
    cands = [(result.get("style") or {}).get("onBeat")]
    if routine.get("timingSource") != "default":
        cands.insert(0, routine.get("timing"))
    for v in cands:
        if v in ("on1", "on2"):
            return v, "claude"
    return (default if default in ("on1", "on2") else DEFAULT_TIMING), "default"


def clean_steps(steps):
    """Claude が書いた steps を検査（最大2行・各欄 12 文字まで）。使えなければ None"""
    if not isinstance(steps, list):
        return None
    out = []
    for s in steps[:2]:
        if not isinstance(s, dict):
            continue
        c = str(s.get("count") or "").strip()
        l = str(s.get("leader") or "").strip()[:12]
        f = str(s.get("follower") or "").strip()[:12]
        if c and (l or f):
            out.append({"count": c[:8], "leader": l, "follower": f})
    return out or None


# ---------------------------------------------------------------- 本体

def normalize(result, summary, duration=None, default_timing=None):
    """result（dict）の routine を整えて返す（result をその場で書き換える）。
    default_timing: Claude が on1/on2 を決めなかったときの数え方（None なら DEFAULT_TIMING）"""
    routine = result.get("routine")
    if not isinstance(routine, dict):
        return result
    raw = routine.get("rawMoves") if isinstance(routine.get("rawMoves"), list) else routine.get("moves")
    if not isinstance(raw, list) or not raw:
        return result
    moves = [dict(m) for m in raw if isinstance(m, dict) and _num(m.get("start")) and m["start"] >= 0]
    moves.sort(key=lambda m: m["start"])
    if not moves:
        return result
    timing, timing_src = resolve_timing(routine, result, default_timing)

    beats = grid_from_beats(summary)
    starts = [m["start"] for m in moves]
    if duration is None or not _num(duration):
        duration = None
    swap_fit = None
    if beats:
        period, beat, first = beats
        phase = best_phase(starts, period, [first + beat * k for k in range(8)])
        tempo_src = "audio"
    else:
        guess = unit8_from_routine(moves) or DEFAULT_UNIT8
        swaps = swap_times(summary)
        swap_fit = fit_grid_to_swaps(swaps, guess, duration or (max(starts) + guess), turn_times(summary))
        if swap_fit:
            period = swap_fit["period"]
            phase = (swap_fit["head0"] * period) % period
            tempo_src = "swaps"
        else:
            period, phase = fit_grid(starts, guess)
            tempo_src = "routine"
        beat = period / 8
    if duration is None:
        duration = moves[-1]["start"] + period

    # 8 カウントの頭の時刻の並び（等速なら phase + k×period。drift があれば少しずつ伸び縮みする）
    if swap_fit:
        heads = swap_heads(swap_fit, max(duration, starts[-1]))
    else:
        k0 = math.floor((0 - phase) / period) - 1
        k1 = math.ceil((max(duration, starts[-1]) - phase) / period) + 1
        heads = [phase + k * period for k in range(k0, k1 + 1)]

    if swap_fit:
        cells = align_to_swaps(moves, heads, swaps)
    else:
        cells = [nearest_head(heads, m["start"]) for m in moves]

    # 各技を割り当てた 8 カウントの頭へ。同じ頭（または前の行より前）に寄ったら前の行にまとめる
    groups = []
    for m, g in zip(moves, cells):
        if groups and g <= groups[-1][0]:
            groups[-1][1].append(m)
        else:
            groups.append((g, [m]))

    out = []
    for k, (g, grp) in enumerate(groups):
        mv = merge_group(grp)
        t0 = max(0.0, heads[g])
        if k + 1 < len(groups):
            n8 = groups[k + 1][0] - g
        else:
            n8 = max(1, round((duration - t0) / period))
        mv["start"] = round(t0, 2)
        mv["counts"] = 8 * max(1, n8)
        turn, capped = clean_turn(mv.get("turn"), mv)
        mv["turn"] = turn
        if capped:
            c = mv.get("confidence")
            mv["confidence"] = min(c, LOW_CONF) if _num(c) else LOW_CONF
        mv["name"] = short_name(mv.get("name"), mv.get("move"))
        steps = clean_steps(mv.get("steps"))
        if timing == "on2" and mv.get("move") == "basic":
            steps = None   # ベーシックは決まった On2 の言い回しで（Claude が On1 の数え方で書くことがある）
        mv["steps"] = steps or template_steps(mv, timing)
        mv["stepsSource"] = "claude" if steps else "template"
        out.append(mv)

    routine["rawMoves"] = raw
    routine["moves"] = out
    routine["timing"] = timing
    routine["timingSource"] = timing_src
    routine["grid"] = {
        "unitSec": round(period, 3), "beatSec": round(beat, 4), "phaseSec": round(phase % period, 3),
        "source": tempo_src,
    }
    if swap_fit:
        routine["grid"]["swapR"] = round(swap_fit["R"], 3)
        routine["grid"]["swaps"] = len(swaps)
        routine["grid"]["z"] = round(swap_fit["z"], 2)
        if swap_fit["drift"]:
            routine["grid"]["driftCycles"] = round(swap_fit["drift"], 3)
    # Claude が書いた bpm は残す。ここで決めた bpm（bpmSource あり）は毎回決め直す（周期が変わったら追従する）
    if not _num(routine.get("bpm")) or routine.get("bpm") <= 0 or routine.get("bpmSource"):
        routine["bpm"] = round(60 / beat)
        routine["bpmSource"] = tempo_src
    return result


def main():
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    if len(pos) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    result_path, meas_path = pos[:2]
    default_timing = opts.get("default-onbeat")
    with open(result_path, encoding="utf-8") as f:
        result = json.load(f)
    summary, duration = {}, None
    if os.path.exists(meas_path):
        with open(meas_path, encoding="utf-8") as f:
            meas = json.load(f) or {}
        summary = meas.get("summary") or {}
        fps, n = meas.get("fps"), meas.get("totalFrames")
        if _num(fps) and fps > 0 and _num(n) and n > 0:
            duration = n / fps
    before = len(((result.get("routine") or {}).get("rawMoves") or (result.get("routine") or {}).get("moves") or []))
    normalize(result, summary, duration, default_timing)
    after = len(((result.get("routine") or {}).get("moves") or []))
    tmp = result_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp, result_path)
    grid = (result.get("routine") or {}).get("grid")
    print(f"normalized routine: {before} -> {after} moves, grid={grid}", file=sys.stderr)


if __name__ == "__main__":
    main()
