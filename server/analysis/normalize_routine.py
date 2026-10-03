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
   On2 では、ペアの決まった技（ベーシック・CBL 系・ターン・コパ等、TEMPLATE_FIRST）は Claude の行でも
   決まった言い回しに置き換える。リードする手（男の左手/右手）・女が男のどちら側を抜けるか・
   回る向きを欄の値から書くので、図や写真の説明と食い違わない（Claude の行は「手を上げる」だけのことがある）
7. 立ち位置: tracks.json の主ペアの腰の位置から、各行の始まりと終わりで女性が画面の左右どちらにいたか
   （sides.followerStart / followerEnd）と、行の中で入れ替わった時刻（sides.swapAt）を付ける（pair_sides.py）
8. パスの整合: 左右が入れ替わったのにパスの無い技（ベーシック・その場のターン）は CBL 系に付け替え、
   CBL 系なのに入れ替わっていなければ種類はそのままで「?」を付ける（passCheck に印）。
   インサイドターンは CBL と組むのが普通なので、その場のインサイドターンで入れ替わりが無ければ、前後半分の
   8 カウント以内の持ち主の無い入れ替わりを取って CBL＋インサイドにし、それも無ければ「?」を付ける
9. 回る向き: 右回り = 回る人自身の右へ = 上から見て時計回り。女性のターンは、つないだ手（女性の右手か左手か）と
   向きからインサイド/アウトサイドを決め（turn.kind）、技名もそれを主にする（手が分からなければ「女 右回り?」）。
   手がデータに無くても、CV が男の頭上の手を見ていれば普通のつなぎ（男の左手×女の右手 / 男の右手×女の左手）を
   推して使う（inferredHold・holdSource="inferred"。同じ側の手どうし・クロスが見えていれば推さない）

元の行は routine.rawMoves に残す（何度実行しても rawMoves から作り直すので結果は同じ）。

Usage: python normalize_routine.py <result.json> <measurements.json> [--default-onbeat=on2] [--tracks=<tracks.json>]
  result.json をその場で書き換える。routine.moves が無ければ何もしない。
  --tracks を省くと measurements.json の隣の measurements.tracks.json を読む（無ければ 7・8 は省く）
"""
import bisect
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pair_sides  # noqa: E402

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
IN_PLACE_TURNS = {"right_turn", "left_turn", "inside_turn", "outside_turn"}  # 女性がその場で回る（左右は変わらない）
# On2 で決まった言い回し（手・通る側・回る向き入り）を Claude の steps より優先する技。
# 欄の値（hold・passSide・turn・立ち位置）から作るので、図・写真の説明と食い違わない
TEMPLATE_FIRST = CBL_MOVES | IN_PLACE_TURNS | {"basic", "leader_turn", "copa"}
SIDE_WORD = {"left": "左", "right": "右"}


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


# ---------------------------------------------------------------- 回る向き・手・インサイド/アウトサイド
#
# 向きの決まり（アプリの凡例・runner-prompt・analyze_pair.spin_hint と同じ）:
#   右回り = 回る人自身の右へ回る = 真上から見て時計回り。左回り = 自分の左へ = 反時計回り。
#   analyze_pair の spin（R/L）も「上から見て時計回り = R」で数えている（正面→右向き→背中 なら左回り）。
# 女性のターンは、ダンサーの言葉では相手との関係で決まるインサイド/アウトサイドを主に言う:
#   女性が右手でつないでいる（男左×女右・右手同士）とき 左回り = インサイド・右回り = アウトサイド。
#   女性が左手でつないでいる（男右×女左・左手同士）ときは逆（右回り = インサイド・左回り = アウトサイド）。
#   両手・クローズド・手を離している・分からないときは決めない（右回り/左回りだけ書き「?」を付ける）

DIR_SHORT = {"right": "右回り", "left": "左回り"}
DIR_LONG = {"right": "右回り（時計回り）", "left": "左回り（反時計回り）"}
KIND_WORD = {"inside": "インサイド", "outside": "アウトサイド"}
HAND_WORD = {"L": "左手", "R": "右手"}


def follower_hand(hold):
    """つないでいる女性の手（R/L）。両手・クローズド・離している・不明は None"""
    if hold in ("LR", "RR"):
        return "R"
    if hold in ("RL", "LL"):
        return "L"
    return None


def leader_hand(hold):
    """つないでいる男性の手（L/R）。両手・クローズド・離している・不明は None"""
    if hold in ("LR", "LL"):
        return "L"
    if hold in ("RR", "RL"):
        return "R"
    return None


def turn_hold(mv):
    """ターンのときのつなぎ。片手でつないでいる方（技の初め → 終わりの順）。
    どちらも分からなければ、男が上げた手から推した普通のつなぎ（inferredHold。infer_hold を参照）"""
    for h in (mv.get("holdStart"), mv.get("holdEnd"), mv.get("inferredHold")):
        if follower_hand(h):
            return h
    return None


def turn_kind(turn, hold):
    """女性のターンのインサイド/アウトサイド（上の決まり）。決められなければ None"""
    if not isinstance(turn, dict) or turn.get("by") not in ("follower", "both"):
        return None
    d, h = turn.get("direction"), follower_hand(hold)
    if d not in DIR_SHORT or h is None:
        return None
    return "inside" if (d == "left") == (h == "R") else "outside"


def rot_text(n):
    """回転数（½ 刻み）: 1 → 「1回」、1.5 → 「1½回」"""
    if not _num(n) or n <= 0:
        return ""
    h = round_half(n)
    whole = int(h)
    frac = "½" if h - whole >= 0.5 else ""
    return f"{whole if whole else ''}{frac}回"


def turn_text(turn, default_dir=None, kind=None):
    """カードの本文に書く回り方。例: 「インサイドターン（左回り）1½回」「右回り（時計回り）2回」"""
    if not isinstance(turn, dict):
        return ""
    d = turn.get("direction") or default_dir
    n = rot_text(turn.get("rotations"))
    if kind in KIND_WORD:
        return f"{KIND_WORD[kind]}ターン（{DIR_SHORT.get(d, '')}）{n}".replace("（）", "")
    return f"{DIR_LONG.get(d, '')}{n}" or "回る"


def rot_suffix(n):
    """技名の回転数（1回は付けない）: 2 → 「×2」、1.5 → 「×1½」"""
    if not _num(n) or n <= 1:
        return ""
    h = round_half(n)
    whole = int(h)
    return f"×{whole}{'½' if h - whole >= 0.5 else ''}"


def turn_name(mv):
    """回る技の名前（インサイド/アウトサイドを主に）。決まった形にできなければ None（元の名前のまま）"""
    move, turn = mv.get("move"), mv.get("turn")
    if not isinstance(turn, dict):
        return None
    d = turn.get("direction")
    suffix = rot_suffix(turn.get("rotations"))
    if move == "leader_turn" or turn.get("by") == "leader":
        return f"男 {DIR_SHORT[d]}{suffix}" if move == "leader_turn" and d in DIR_SHORT else None
    kind = turn.get("kind")
    if move in IN_PLACE_TURNS:
        if kind:
            return f"{KIND_WORD[kind]}ターン{suffix}"
        return f"女 {DIR_SHORT[d]}{suffix}?" if d in DIR_SHORT else None
    if move in ("cbl_inside_turn", "cbl_outside_turn"):
        if kind:
            return f"CBL＋{KIND_WORD[kind]}{suffix}"
        return f"CBL＋女{DIR_SHORT[d]}{suffix}?" if d in DIR_SHORT else None
    return None


# ---------------------------------------------------------------- カウントごとの動き

def template_steps(mv, timing):
    """技の種類から決まる、男女のカウントごとの動き。On1 以外（on2・unclear・無し）は On2 の言い方"""
    if timing != "on1":
        return template_steps_on2(mv)
    move = mv.get("move")
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else None
    who = (turn or {}).get("by")
    kind = (turn or {}).get("kind")
    ftxt = turn_text(turn, kind=kind) if who in ("follower", "both") else ""
    pass_side = mv.get("passSide")
    side = "右" if pass_side == "right" else "左"
    a, b = "1-2-3", "5-6-7"
    if move == "basic":
        rows = [(a, "前へ", "後ろへ"), (b, "後ろへ", "前へ")]
    elif move == "cbl":
        rows = [(a, "3で左へ開く", "前へ"), (b, "向きを戻す", f"男の{side}を通る")]
    elif move in ("cbl_inside_turn", "inside_turn"):
        rows = [(a, "左へ開き手を上げる", "前へ"), (b, "頭上で回す", f"通りながら{turn_text(turn, 'left', kind) or '左回り'}")]
    elif move in ("cbl_outside_turn", "outside_turn"):
        rows = [(a, "左へ開く", "前へ"), (b, "手を外へ回す", f"通りながら{turn_text(turn, 'right', kind) or '右回り'}")]
    elif move == "reverse_cbl":
        rows = [(a, "3で右へ開く", "前へ"), (b, "向きを戻す", f"男の右を通る{('・' + ftxt) if ftxt else ''}")]
    elif move in ("right_turn", "left_turn"):
        d = "right" if move == "right_turn" else "left"
        rows = [(a, "手を上げる", "前へ"), (b, "頭上で回す", turn_text(turn, d, kind) or DIR_LONG[d])]
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
    CBL は男が 2 で下がった直後の 3 で開き、女は 2 で前へ出てそのまま 5 で男の横を抜け、6-7 で向き直る。
    ターンは 1-2-3 で準備し 5-6-7 でリード、女は 5-6 で回って 7 で止まる。
    リードする手（男の左手/右手）・女が男のどちら側を抜けるか・回る向き（インサイド/アウトサイドと右回り/左回り）を
    欄の値から書く。分からない要素は書かない（「手を上げる」等）"""
    move = mv.get("move")
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else None
    who = (turn or {}).get("by")
    kind = (turn or {}).get("kind")
    ftxt = turn_text(turn, kind=kind) if who in ("follower", "both") else ""
    hand = HAND_WORD.get(mv.get("leadHand"), "手")
    ps = SIDE_WORD.get(mv.get("passSide"))
    via = f"男の{ps}側を抜け" if ps else "男の前を抜け"
    a, b = "1-2-3", "5-6-7"
    prep_l, prep_f = "2で下がり3で左へ開く", "2で前へ出る"
    if move == "basic":
        rows = [(a, "2で後ろへ", "2で前へ"), (b, "6で前へ", "6で後ろへ")]
    elif move == "cbl":
        rows = [(a, prep_l, prep_f), (b, f"{hand}で左へ送り向きを戻す", f"5で{via}6-7で向き直る")]
    elif move in ("cbl_inside_turn", "cbl_outside_turn"):
        d = "left" if move == "cbl_inside_turn" else "right"
        rows = [(a, prep_l, prep_f),
                (b, f"{hand}を頭上へ上げて回す", f"5で{via}6で{turn_text(turn, d, kind)}・7で向き直る")]
    elif move == "reverse_cbl":
        rows = [(a, "2で下がり3で右へ開く", prep_f),
                (b, f"{hand}で右へ送り向きを戻す", f"5で{via}{('6で' + ftxt + '・') if ftxt else '6-7で'}向き直る")]
    elif move in IN_PLACE_TURNS:
        d = "right" if move in ("right_turn", "outside_turn") else "left"
        rows = [(a, f"2で下がり{hand}を上げる", "2で前へ"),
                (b, f"{hand}を頭上で回す", f"5-6で{turn_text(turn, d, kind)}・7はその場で向き直る")]
    elif move == "leader_turn":
        rows = [(a, f"自分で{turn_text(turn) or '回る'}", "その場"), (b, "6で前へ", "6で後ろへ")]
    elif move == "copa":
        rows = [(a, prep_l, "2で前へ出る"), (b, f"{hand}で引き戻す", "5で半回転して元の側へ戻る")]
    elif move == "hand_change":
        rows = [(a, "手を持ち替える", "ベーシック"), (b, "ベーシック", "ベーシック")]
    elif move == "shine":
        rows = [("1-8", "手を離して各自", "手を離して各自")]
    elif move == "wrap":
        rows = [(a, f"2で下がり{hand}を上げる", "2で前へ"), (b, "腕で包む", "5-6で巻かれて並ぶ")]
    elif move == "hammerlock":
        rows = [(a, f"2で下がり{hand}を上げる", "2で前へ"), (b, "背中で手を止める", "5-6で回り手が背中に")]
    elif move == "shadow":
        rows = [(a, "女の後ろへ", "2で前へ"), (b, "同じ向きで踊る", "同じ向き")]
    elif move == "dip":
        rows = [(a, "支える", "後ろへ倒れる"), (b, "起こす", "戻る")]
    else:
        if not ftxt and not (turn and who == "leader"):
            return []
        rows = [(b, f"{hand}でリード" if ftxt else f"自分で{turn_text(turn)}", f"5-6で{ftxt}" if ftxt else "その場")]
    return [{"count": c, "leader": l, "follower": f} for c, l, f in rows]


# ---------------------------------------------------------------- 立ち位置（tracks.json）とパスの整合

SIDE_START_BEATS = 1.0    # 行の始まりの立ち位置: 頭からこの拍数までに最後に確かめた側
SIDE_END_BEATS = -0.5     # 行の終わりの立ち位置: 次の行の頭からこの拍数（負 = 手前）以降に最初に確かめた側
# 正解表（1230b3d5・ジョブ 581ef6a2）で開始 -0.5〜2 拍・終了 -1.5〜2.5 拍を振り、1.0 / -0.5 が CBL 再現率 0.9・
# 行の一致 0.879 で最良（終了を -1.5 にすると、CV の入れ替わりが遅れて 8 拍目に出た行を「入れ替わり無し」と読む）
# 行ごとの局所位相（swapAt を 5 拍目に寄せてカウントを付け直す）は試して入れていない（1230b3d5・581ef6a2）:
# swapAt（CV の入れ替わりの 0.6 秒以内）の元の CV 時刻は正解の通過から -1.0〜+1.7 秒（最大 5 拍）ばらつき、
# 遅れる側に寄るので、CBL 系の行の swapAt のカウントは 6〜8 に
# 偏り（46 件中 27 件）、正解の通過（平均 5.2）とは合わない。両向きに寄せると正解の通過が 5±1 に入る割合が
# 0.58→0.30 に落ちる。早すぎる（3 以下）ときだけ寄せると 4 行しか動かず 0.58→0.60 で、行の頭が 4 拍目になる。
# 0:01.76 の行が 2〜4 拍遅れて見えるのは、全体の周期が正解より 0.6% 短い（正解だけで当てると 2.593 秒 / 今 2.577 秒）
# ため冒頭の行の頭が遅れ（正解の通過が 0〜20 秒で平均 3.9 拍目、140 秒以降で 7.1 拍目）、さらに冒頭の
# 入れ替わり 2 回（0.3・2.5 秒、間隔 6.8 拍）が 8 カウントに乗らないため
CROSS_CV_SEC = 0.6        # 入れ替わりは、CV の CBL イベントがこの秒数以内にあるものだけ数える（下の説明）
# tracks.json の左右だけで数えると、密着（ラップ・ハグ）中の腰の重なりで入れ替わりが出る（1230b3d5 の 1:28〜1:32 で
# 4 回。正解表には無い）。CV の CBL 検出は前後の離れ具合も見ているので、それと重なるものだけを入れ替わりとする


def move_sides(moves, runs, crosses, beat, duration, cv_swaps=()):
    """各行の開始・終了で女性が画面の左右どちらにいたか（tracks.json の主ペアの腰の位置）。
    開始は 2 拍目までに最後に確かめた側、終了は 7½ 拍目以降に最初に確かめた側（On2 なら 5 で通って
    6-7 で向き直るので、通過の途中を読まない）。swapAt はその行の中で左右が入れ替わった時刻
    （CV の CBL イベントと重なるものだけ）"""
    confirmed = [c for c in crosses if any(abs(s - c["t"]) <= CROSS_CV_SEC for s in cv_swaps)]
    out = []
    for k, mv in enumerate(moves):
        t0 = mv["start"]
        t1 = moves[k + 1]["start"] if k + 1 < len(moves) else min(duration, t0 + mv["counts"] * beat)
        s0 = pair_sides.side_before(runs, t0 + SIDE_START_BEATS * beat, max_dist=4 * beat)
        s1 = pair_sides.side_after(runs, t1 + SIDE_END_BEATS * beat, max_dist=4 * beat)
        swaps = [c["t"] for c in confirmed if t0 <= c["t"] < t1]
        out.append({"followerStart": s0, "followerEnd": s1, "swapAt": swaps})
    return out


def cv_pass_side(summary, t0, t1):
    """行の中の CV の CBL イベントの pass.side（男性の体から見て女性が通った側）。無ければ None"""
    for e in (summary or {}).get("events") or []:
        if not isinstance(e, dict) or e.get("type") != "CBL" or not _num(e.get("t")):
            continue
        if t0 - 0.5 <= e["t"] < t1:
            side = (e.get("pass") or {}).get("side")
            if side in ("left", "right"):
                return side
    return None


def cv_lead_hand(summary, t0, t1):
    """行の中の CV の CBL イベントで男性が頭上に上げた手（L/R）。無ければ None"""
    for e in (summary or {}).get("events") or []:
        if not isinstance(e, dict) or e.get("type") != "CBL" or not _num(e.get("t")):
            continue
        if t0 - 0.5 <= e["t"] < t1:
            hr = e.get("handRaise") or {}
            if hr.get("raised") and hr.get("hand") in ("L", "R"):
                return hr["hand"]
    return None


CV_HOLD = {   # analyze_pair の hold（日本語）→ routine の語彙（男の手が先）
    "リーダー左手×フォロワー右手": "LR", "リーダー右手×フォロワー右手": "RR",
    "リーダー右手×フォロワー左手": "RL", "リーダー左手×フォロワー左手": "LL",
}
STANDARD_HOLD = {"L": "LR", "R": "RL"}   # 男が上げた手 → 普通のつなぎ（男の左手×女の右手 / 男の右手×女の左手）
NON_STANDARD_HOLDS = {"RR", "LL", "cross"}   # 同じ側の手どうし（右手×右手・左手×左手）とクロス


def cv_holds(summary, t0, t1):
    """行の中で CV が見たつなぎ（events の hold と holdTimeline。routine の語彙）の集合"""
    s = summary or {}
    out = set()
    for e in s.get("events") or []:
        if isinstance(e, dict) and _num(e.get("t")) and t0 - 0.5 <= e["t"] < t1 and e.get("hold") in CV_HOLD:
            out.add(CV_HOLD[e["hold"]])
    for h in s.get("holdTimeline") or []:
        if isinstance(h, dict) and _num(h.get("from")) and _num(h.get("to")) and h["to"] > t0 and h["from"] < t1 \
                and h.get("hold") in CV_HOLD:
            out.add(CV_HOLD[h["hold"]])
    return out


def infer_hold(mv, summary, t0, t1):
    """女性のターンで、つないだ手がデータに無いとき、男が頭上に上げた手（CV）から普通のつなぎを推す（決定的）:
    男の左手が上がっていれば女の右手（LR）、右手なら女の左手（RL）。行の欄・CV のどちらかに同じ側の手どうし
    （RR・LL）やクロスが見えていれば推さない。離している（none）と書かれた行も推さない。
    推したら inferredHold と holdSource="inferred" を付ける。holdStart/holdEnd（見えたつなぎ）は書き換えない
    （振付シートの「つなぎ」欄に推したものを見えたように出さない。インサイド/アウトサイドは turn.kind で出る）。
    推しただけでは「?」を付けない。
    戻り値は推したつなぎ（推さなければ None）。
    581ef6a2 の 0:01.76: 手は両方不明・CV の CBL で男の左手が上がり、CV の回転は左 → 女の右手で左回り = インサイド"""
    turn = mv.get("turn")
    if not isinstance(turn, dict) or turn.get("by") not in ("follower", "both") or turn_hold(mv):
        return None
    holds = {mv.get("holdStart"), mv.get("holdEnd")}
    if "none" in holds or holds & NON_STANDARD_HOLDS or cv_holds(summary, t0, t1) & NON_STANDARD_HOLDS:
        return None
    h = STANDARD_HOLD.get(cv_lead_hand(summary, t0, t1))
    if h is None:
        return None
    mv["inferredHold"] = h
    mv["holdSource"] = "inferred"
    return h


def cv_spin(summary, t0, t1, by="follower"):
    """行の中で回り始めた CV のターンの、最初のはっきりした回転（1 回転以上続いた向き）: (direction, turns) か None。
    analyze_pair が全フレームで数え直した spin.runs（向きは上から見て時計回り = right。人手校正で女性のターンの
    向きは 8 件中 7 件正しい）"""
    for e in (summary or {}).get("events") or []:
        if not isinstance(e, dict) or e.get("type") != "Turn" or e.get("by") != by:
            continue
        sp = e.get("spin") or {}
        a = sp.get("from", e.get("t"))
        if not _num(a) or not (t0 - 0.3 <= a < t1):
            continue
        for r in sp.get("runs") or []:
            if r.get("dir") in DIR_SHORT and _num(r.get("turns")) and r["turns"] >= 1:
                return r["dir"], r["turns"]
    return None


def check_direction(mv, spin):
    """Claude の回る向きが CV の数えた向きと逆なら CV に合わせて「?」を付ける。戻り値は直した印（変えなければ None）。
    Claude はストリップ画像（上限 12 件）の無いターンを推測で書くことがあり、581ef6a2 の 0:01.76 の行は
    「右回り2回」だったが、コマを追うと 正面→背中→左向き→正面→右向き の左回り（CV も左 1 回）だった"""
    turn = mv.get("turn")
    if not isinstance(turn, dict) or turn.get("by") not in ("follower", "both") or spin is None:
        return None
    d, n = spin
    if turn.get("direction") not in DIR_SHORT or turn["direction"] == d:
        return None
    turn["claudeDirection"] = turn["direction"]
    turn["direction"] = d
    turn["directionSource"] = "cv"
    turn["rotations"] = max(0.5, min(MAX_ROT, round_half(n)))
    return f"direction:{turn['claudeDirection']}->{d}"


def check_pass(mv, cv_side):
    """CV の立ち位置と技の種類の食い違いを直す。戻り値は直した内容の印（変えなければ None）。
    - 左右が入れ替わったのにパスの無い技（ベーシック・その場のターン）→ CBL 系に付け替えて「?」
      （その場のターンは CBL＋ターン。向きと手からインサイド/アウトサイドを決める）。それ以外の技は通る側だけ埋めて「?」
    - CBL 系なのに入れ替わっていない → 種類はそのまま（隠れて読めない・撮影位置が回り込むことがある）で「?」を付ける"""
    s = mv.get("sides") or {}
    a, b = s.get("followerStart"), s.get("followerEnd")
    if a is None or b is None:
        return None
    move = mv.get("move")
    if a != b and move not in CBL_MOVES and s.get("swapAt"):
        if move == "basic":
            mv["move"] = "cbl"
        elif move in IN_PLACE_TURNS:
            turn = mv.get("turn") or {}
            d = turn.get("direction")
            kind = turn_kind(turn, turn_hold(mv))
            if kind == "inside" or (kind is None and d == "left"):
                mv["move"] = "cbl_inside_turn"
            elif kind == "outside" or (kind is None and d == "right"):
                mv["move"] = "cbl_outside_turn"
            else:
                mv["move"] = "cbl"
        if mv.get("passSide") not in ("left", "right"):
            mv["passSide"] = cv_side
        return f"swapButNoPass:{move}->{mv['move']}"
    if a == b and move in CBL_MOVES:
        return f"passButNoSwap:{move}"
    return None


INSIDE_NEAR_BEATS = 4.0   # インサイドターンの行の外でも、この拍数（半分の 8 カウント）以内の入れ替わりはその技のパスとみなす


def check_inside_turns(out, beat, timing):
    """女性のインサイドターンは普通 CBL と組む（CBL＋インサイドターン: 女性は反対側へ抜けて 5-6-7 で内回り）。
    その場のインサイドターンの行で入れ替わりが無いとき:
    - 前後の行の、この行から半分の 8 カウント以内に CV の入れ替わりがあり、その行が CBL 系でない（入れ替わりの
      持ち主がいない）なら、この行を CBL＋インサイドに付け替える
    - そうでなければ種類はそのままで「?」を付ける
    戻り値は直した印のリスト"""
    fixes = []
    for k, mv in enumerate(out):
        turn = mv.get("turn") or {}
        sides = mv.get("sides")
        if mv.get("move") not in IN_PLACE_TURNS or turn.get("kind") != "inside" or not sides or sides.get("swapAt"):
            continue
        t0 = mv["start"]
        t1 = out[k + 1]["start"] if k + 1 < len(out) else t0 + mv["counts"] * beat
        near = None
        for j in (k - 1, k + 1):
            if not (0 <= j < len(out)) or out[j].get("move") in CBL_MOVES:
                continue
            for s in (out[j].get("sides") or {}).get("swapAt") or []:
                if t0 - INSIDE_NEAR_BEATS * beat <= s < t1 + INSIDE_NEAR_BEATS * beat:
                    near = (j, s)
        if near:
            fix = f"insideTurnNearSwap:{mv['move']}->cbl_inside_turn@{near[1]}"
            mv["move"] = "cbl_inside_turn"
            mv["passSide"] = mv.get("passSide") if mv.get("passSide") in ("left", "right") else None
            mv["name"] = turn_name(mv) or DEFAULT_NAME["cbl_inside_turn"]
            mv["steps"] = template_steps(mv, timing)
            mv["stepsSource"] = "template"
        else:
            fix = "insideTurnNoSwap"
        mv["passCheck"] = mv.get("passCheck") or fix
        mark_uncertain(mv)
        fixes.append(fix)
    return fixes


def mark_uncertain(mv):
    """自信を下げ、名前に「?」を付ける（アプリが推定バッジを出す）"""
    c = mv.get("confidence")
    mv["confidence"] = min(c, LOW_CONF) if _num(c) else LOW_CONF
    name = mv.get("name") or ""
    if not re.search(r"[?？]$", name):
        mv["name"] = name + "?"


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

def normalize(result, summary, duration=None, default_timing=None, tracks=None):
    """result（dict）の routine を整えて返す（result をその場で書き換える）。
    default_timing: Claude が on1/on2 を決めなかったときの数え方（None なら DEFAULT_TIMING）
    tracks: analyze_pair の tracks.json（主ペアの立ち位置を読む。None なら立ち位置と整合チェックは省く）"""
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
        out.append(mv)

    # 立ち位置（女性が画面の左右どちらで始まりどちらで終わるか）を tracks.json から付け、
    # 技の種類（パスの有無）と食い違う行を直す。tracks が無ければ立ち位置は付けない
    runs = pair_sides.settled_runs(pair_sides.follower_series(tracks)) if tracks else []
    if runs:
        crosses = pair_sides.crossings(runs)
        for mv, sides in zip(out, move_sides(out, runs, crosses, beat, duration, swap_times(summary))):
            mv["sides"] = sides
    fixes = []
    for k, mv in enumerate(out):
        t0 = mv["start"]
        t1 = out[k + 1]["start"] if k + 1 < len(out) else t0 + mv["counts"] * beat
        before = mv.get("move")
        flip = check_direction(mv, cv_spin(summary, t0, t1))
        if flip:
            mv["directionCheck"] = flip
            mark_uncertain(mv)
        # 手が分からない女性のターンは、男が上げた手から普通のつなぎを推す（「?」は付けない）
        infer_hold(mv, summary, t0, t1)
        fix = check_pass(mv, cv_pass_side(summary, t0, t1))
        if fix:
            mv["passCheck"] = fix
            fixes.append(fix)
            if mv["move"] != before and mv["move"] in DEFAULT_NAME:
                mv["name"] = DEFAULT_NAME[mv["move"]]
            mark_uncertain(mv)
        # リードする手: 片手でつないでいれば男性のその手、無ければ CV が見た頭上に上がった手
        mv["leadHand"] = leader_hand(turn_hold(mv) or mv.get("holdStart")) or cv_lead_hand(summary, t0, t1)
        turn = mv.get("turn")
        if isinstance(turn, dict):
            kind = turn_kind(turn, turn_hold(mv))
            turn.pop("kind", None)
            if kind:
                turn["kind"] = kind
                # CBL＋ターンの種類は向きと手で決まる方に合わせる（Claude の付けた inside/outside と食い違うことがある）
                if mv["move"] in ("cbl_inside_turn", "cbl_outside_turn"):
                    mv["move"] = f"cbl_{kind}_turn"
        q = bool(re.search(r"[?？]$", mv.get("name") or ""))
        tn = turn_name(mv)
        if tn:
            mv["name"] = tn if (tn.endswith("?") or not q) else tn + "?"
        steps = clean_steps(mv.get("steps"))
        if timing == "on2" and mv.get("move") in TEMPLATE_FIRST:
            # 決まった On2 の言い回しで（手・通る側・回る向きを欄の値から書く。Claude の steps は
            # On1 の数え方や「手を上げる」だけのことがあり、図・写真の説明と食い違う）
            steps = None
        mv["steps"] = steps or template_steps(mv, timing)
        mv["stepsSource"] = "claude" if steps else "template"

    fixes += check_inside_turns(out, beat, timing)

    routine["rawMoves"] = raw
    routine["moves"] = out
    routine["timing"] = timing
    routine["timingSource"] = timing_src
    routine["passChecks"] = len(fixes)
    routine["directionChecks"] = sum(1 for m in out if m.get("directionCheck"))
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
    # 主ペアの立ち位置は analyze_pair の tracks.json（measurements.json の隣の measurements.tracks.json）
    tracks_path = opts.get("tracks") or re.sub(r"\.json$", ".tracks.json", meas_path)
    tracks = pair_sides.load_tracks(tracks_path)
    before = len(((result.get("routine") or {}).get("rawMoves") or (result.get("routine") or {}).get("moves") or []))
    normalize(result, summary, duration, default_timing, tracks)
    after = len(((result.get("routine") or {}).get("moves") or []))
    tmp = result_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp, result_path)
    grid = (result.get("routine") or {}).get("grid")
    print(f"normalized routine: {before} -> {after} moves, grid={grid}", file=sys.stderr)


if __name__ == "__main__":
    main()
