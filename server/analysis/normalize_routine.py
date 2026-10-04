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
   CV の左右入れ替わり（summary.events の CBL）が 8 カウントの同じ位置（On2 の CBL なら女が 2 で男の横を通る）に
   最もよく揃う周期・位相（・ゆっくりしたテンポの変化）を、Claude の routine の間隔を目安に探す。
   入れ替わりが少ない・揃わないときは、routine の間隔の中央値から推定し技の頭の時刻に合わせる（従来）
2. 位相（8カウントの頭がどこか）: 音声なら技の頭の時刻が最もよく乗る拍。入れ替わりで当てたならそれで決まる。
   各技の start を最寄りの 8 カウントの頭へ寄せる。入れ替わりで当てたときは、Claude の行の順番を保ったまま
   CBL 系の行が入れ替わりのある 8 カウントに来るよう前後にずらす（Claude の行の時刻が 1 行ずれることがある）。
   音声の格子でも、位相は音のまま、行の割り当てだけ同じように CV の入れ替わりに合わせる
3. 同じ頭に寄った技は 1 行にまとめる（ターン・パスがある方を主にする）。counts は次の技の頭までの 8 の倍数
4. 回転数の普通の回数（事前分布: CBL ½・CBL＋ターン 1½（ダブルは 2½）・その場のターン 1（ダブル 2）、
   docs/salsa-knowledge/on2-timing-and-terms.md §5・§8-4）は、数が無いときの穴埋めにだけ使う（寄せて減らさない）。
   2 回転を上限にし（強い証拠があれば 3 回転まで）、使える拍より多い回転は採らない（多回転でも 1 回転 ≈ 1 拍が最短。
   CV の回転区間があればその拍数、無ければ半分の 8 カウント = 4 拍）。削ったら自信を下げて「?」が付くようにする
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
   8 カウント以内の持ち主の無い入れ替わりを取って CBL＋インサイドにし、それも無ければ「?」を付ける。
   1×8 に入れ替わりが入った other / wrap / copa の行は CBL 系にし、2 回なら「CBL×2」（通る側が逆なら「CBL＋逆CBL」）
   女性のターンが主: 男のターンの行・ベーシック・持ち替えの行に女性の CV のターンがあれば女性のターンを turn にし、
   男のターンは leaderTurn に移す（「?」を付ける）
9. 回る向き: 右回り = 回る人自身の右へ = 上から見て時計回り。女性のターンは向きだけでインサイド/アウトサイドを
   決める（turn.kind。左回り = インサイド・右回り = アウトサイド。つなぎ手が変わっても同じ。サルサの主流の
   Dance Dojo の呼び方。docs/salsa-knowledge/on2-timing-and-terms.md §3）。本文（steps・回転の欄）は
   左回り/右回りを主に書き、インサイド/アウトサイドは技名とラベルに添える。
   手がデータに無くても、CV が男の頭上の手を見ていれば普通のつなぎ（男の左手×女の右手 / 男の右手×女の左手）を
   推してリードする手に使う（inferredHold・holdSource="inferred"。同じ側の手どうし・クロスが見えていれば推さない）

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
# 区間ごとの局所位相（30〜40 秒おきの区分線形の補正）も試したが入れていない（1230b3d5 で同点か悪化）。
# 正解の通過が後半ほど遅く数えられるのは、CV の入れ替わりの遅れが 0.9 秒 → 0.2 秒と縮むためで、CV の入れ替わり
# 自体は今の格子で平らに並ぶ（docs/salsa-knowledge/README.md 反映済み 7）
SWAP_BEAT = 4.25           # CV の入れ替わり時刻が来る、8 カウントの頭からの拍数（下の説明）
# SWAP_BEAT: Eddie Torres の On2 の CBL では、男は 6 で前へブレイクして 7〜1 で左へ約 90° 開き、
# 女は 1〜3 で横断して 2 で男の左側を通る（腰の左右が入れ替わる）。½ 回って 3 前後で線に戻り、5 で着地する
# （docs/salsa-knowledge/on2-timing-and-terms.md §2.2・§8-2）。
# CV の入れ替わり時刻（detect_cbl）は「入れ替わった後に 2 人とも見えた最初のコマ」なので本当の入れ替わりより
# 遅れる（正解表で平均 +3 拍ほど）。値は正解表で決めた（1230b3d5 は On2。eval_routine_grid.py、ジョブ 581ef6a2 /
# 2f4b6919）: 4.25 で正解の入れ替わりの平均がカウント 2.2（581ef6a2）/ 2.2（2f4b6919）。4.0 → 2.0、5.0 → 3.0。
# 以前は On1 の数え方を写した「5 で通る」（7.0）にしていた。その頃と比べて（立ち位置を読む拍・その場のターンを
# 近くの入れ替わりで CBL＋ターンにする処理も合わせて）行の一致は 581ef6a2 で 0.879 → 0.914、2f4b6919 で
# 0.807 → 0.786、正解の CBL を覆う行の再現率は 0.90 → 0.97 / 0.83 → 0.83。
# 4.0 は 2f4b6919 で行の一致 0.754、5.0（通過 = 3）は 581ef6a2 で 0.845 に落ち、3.0（通過 = 1）は両方で大きく
# 落ちる（8 カウントの境目が入れ替わりの集まりの真ん中に来る）
SWAP_BEAT_REFINED = 3.5    # refine_events.py が入れ替わりの時刻を通過の瞬間（隠れていた区間の真ん中）に取り直したとき。
                           # 581ef6a2 で 2.0〜4.25 を振って 3.5 が最良（それでも 4.25 の 10fps より下。取り直しは既定で無効）
REFINED_MIN_SHARE = 0.5    # CV の入れ替わりのうちこの割合以上が取り直し済み（tCoarse あり）なら SWAP_BEAT_REFINED を使う
BPM_MIN = 150.0            # サルサとして数えるテンポの範囲（踊られるのは大半が 160〜220。video-analysis-cues.md §2.6）
BPM_MAX = 250.0
HALF_TEMPO = (75.0, 125.0)  # この範囲のテンポは 2 拍を 1 拍と数えた値（半分のテンポ）なので 2 倍にする
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
    # 半分のテンポ（2 拍を 1 拍）はここでは直さない: analyze_beats.py が 140〜230 BPM の中でしか探さないので起きない
    if not _num(beat) or not (MIN_UNIT8 / 8 <= beat <= MAX_UNIT8 / 8):
        return None
    first = g.get("firstBeatSec")
    return 8 * beat, beat, float(first) if _num(first) else 0.0


def salsa_unit8(u):
    """1×8 の秒数の目安を、サルサのテンポ（BPM_MIN〜BPM_MAX）に直す。半分のテンポ（75〜125 BPM 相当）は倍速にし、
    範囲の外は端に寄せる。None はそのまま"""
    if not _num(u) or u <= 0:
        return u
    bpm = 8 * 60 / u
    if HALF_TEMPO[0] <= bpm <= HALF_TEMPO[1]:
        bpm *= 2
    bpm = min(max(bpm, BPM_MIN), BPM_MAX)
    return 8 * 60 / bpm


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
    """measurements.json の summary.events から CV の左右入れ替わり（CBL）の時刻。
    SWAP_BEAT は腰の交差の時刻で合わせてあるので、通過に寄せた t ではなく tCross（あれば）を使う"""
    ev = (summary or {}).get("events") or []
    return sorted(cross_t(e) for e in ev if isinstance(e, dict) and e.get("type") == "CBL" and _num(e.get("t")))


def cross_t(e):
    """CBL イベントの腰の交差の時刻（tCross が無い古い出力は t）"""
    return e["tCross"] if _num(e.get("tCross")) else e["t"]


def swap_beat_for(summary):
    """CV の入れ替わりの時刻が来る拍。refine_events.py で取り直した（tCoarse がある）入れ替わりが多ければ
    SWAP_BEAT_REFINED、そうでなければ 10fps の遅れ込みの SWAP_BEAT"""
    ev = [e for e in (summary or {}).get("events") or []
          if isinstance(e, dict) and e.get("type") == "CBL" and _num(e.get("t"))]
    refined = sum(1 for e in ev if _num(e.get("tCoarse")))
    return SWAP_BEAT_REFINED if ev and refined >= REFINED_MIN_SHARE * len(ev) else SWAP_BEAT


def swap_times_any(summary):
    """入れ替わりの時刻（取り直した時刻と元の 10fps の時刻の両方）。tracks.json の左右の入れ替わりと照らすのに使う"""
    out = set(swap_times(summary))
    for e in (summary or {}).get("events") or []:
        if isinstance(e, dict) and e.get("type") == "CBL" and _num(e.get("tCoarse")):
            out.add(e["tCoarse"])
    return sorted(out)


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


def fit_grid_to_swaps(swaps, unit_guess, duration, turns=(), swap_beat=SWAP_BEAT):
    """CV の入れ替わり時刻に 8 カウントの格子を当てる。CBL なら入れ替わりは毎回 8 カウントの同じ所
    （On2 は 2 で女が男の横を通る）に来るので、周期を目安の ±SWAP_PERIOD_RANGE で振って位相が最も揃う周期を取る。
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

    # 周期は目安の ±SWAP_PERIOD_RANGE、かつサルサのテンポ（BPM_MIN〜BPM_MAX）の中で探す
    lo = max(MIN_UNIT8, 8 * 60 / BPM_MAX, unit_guess * (1 - SWAP_PERIOD_RANGE))
    hi = min(MAX_UNIT8, 8 * 60 / BPM_MIN, unit_guess * (1 + SWAP_PERIOD_RANGE))
    if lo > hi:
        return None
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
    head0 = (mean - swap_beat / 8) % 1
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


def swap_cells(heads, swaps, swap_beat=SWAP_BEAT):
    """各 8 カウントに CV の入れ替わりがあるか。入れ替わりは頭から swap_beat 拍目に来る想定なので、
    そこから前後半周期（±4 拍）の入れ替わりをその 8 カウントのものとする"""
    has = [False] * len(heads)
    for s in swaps:
        for j in range(len(heads) - 1):
            b = (heads[j + 1] - heads[j]) / 8
            c = heads[j] + swap_beat * b
            if c - 4 * b <= s < c + 4 * b:
                has[j] = True
                break
    return has


AUDIO_ALIGN = True   # 音声の格子でも、行の割り当てを CV の入れ替わりに合わせる（位相は音のまま）


def audio_swap_cells(heads, swaps):
    """音声の格子（位相は音で決まっている）で、各 8 カウントに CV の入れ替わり（腰の交差）が入っているか。
    入れ替わりは入っている 8 カウント（頭〜次の頭）のもの。
    「6 拍目以降の入れ替わりは、次の 8 カウントに入れ替わりが無ければ次のもの」とする溢れの規則も試したが、
    正解表 6 本で cbl .894 → .848・img1884 .857 → .571 と悪くなったので入れていない（README 反映済み 16）"""
    n = len(heads)
    has = [False] * n
    for s in swaps:
        j = bisect.bisect_right(heads, s) - 1
        if 0 <= j < n - 1:
            has[j] = True
    return has


def align_to_swaps(moves, heads, swaps, swap_beat=SWAP_BEAT, has=None):
    """Claude の行（時刻順）を 8 カウントへ順番を保って割り当てる。各行はまず元の時刻の最寄りの頭が候補で、
    CBL 系の行が入れ替わりのある 8 カウントに、そうでない行が入れ替わりの無い 8 カウントに来るよう
    前後にずらしてよい（Claude の行の時刻が 1 行ぶんずれていることがあるため）。
    罰: ずらした分 × SWAP_SHIFT_WEIGHT、食い違い × SWAP_ALIGN_WEIGHT。同じ 8 カウントに 2 行 → まとめる"""
    n = len(heads)
    if has is None:
        has = swap_cells(heads, swaps, swap_beat)
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
    # 女性のターンが主の行にまとめた男のターンは leaderTurn に残す（1 行に書けるターンは 1 つ）
    if (out.get("turn") or {}).get("by") in ("follower", "both") and not out.get("leaderTurn"):
        lt = next((g["turn"] for g in group if g is not main and isinstance(g.get("turn"), dict)
                   and g["turn"].get("by") == "leader"), None)
        if lt:
            out["leaderTurn"] = {"direction": lt.get("direction"), "rotations": lt.get("rotations")}
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
# 女性のターンのインサイド/アウトサイドは回る向きだけで決める（つなぎ手に関係なく）:
#   左回り（反時計回り）= インサイド・右回り（時計回り）= アウトサイド。
#   サルサの主流（Dance Dojo）は「Right to left parallel」「握手」でも右回りを Outside Turn、交差持ちの左回り
#   （Butterfly）も Inside Turn の変化形と呼ぶ。腕の通り道で呼ぶ流儀（Wikipedia の Direction of movement・
#   スウィング・バチャータ）は持ち手が変わると呼び名が逆になるが少数派（docs/salsa-knowledge/on2-timing-and-terms.md §3）。
#   流派で呼び名が揺れるので、本文は左回り/右回りを主に書き、インサイド/アウトサイドはラベルとして添える。
#   （c48a154・fd85662 では女性が左手でつなぐと逆にしていたが、この決まりに戻した）

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


def turn_kind(turn, hold=None):
    """女性のターンのインサイド/アウトサイド（上の決まり: 左回り = インサイド・右回り = アウトサイド）。
    hold は使わない（つなぎ手で呼び名を変えない。引数は呼び出し側の互換のため残す）。向きが分からなければ None"""
    if not isinstance(turn, dict) or turn.get("by") not in ("follower", "both"):
        return None
    d = turn.get("direction")
    if d not in DIR_SHORT:
        return None
    return "inside" if d == "left" else "outside"


def rot_text(n):
    """回転数（½ 刻み）: 1 → 「1回」、1.5 → 「1½回」"""
    if not _num(n) or n <= 0:
        return ""
    h = round_half(n)
    whole = int(h)
    frac = "½" if h - whole >= 0.5 else ""
    return f"{whole if whole else ''}{frac}回"


def turn_text(turn, default_dir=None, kind=None):
    """カードの本文に書く回り方。向きを主に、インサイド/アウトサイドは後ろに添える。
    例: 「左回り1½回（インサイド）」「右回り（時計回り）2回」"""
    if not isinstance(turn, dict):
        return ""
    d = turn.get("direction") or default_dir
    n = rot_text(turn.get("rotations"))
    if kind in KIND_WORD and d in DIR_SHORT:
        return f"{DIR_SHORT[d]}{n}（{KIND_WORD[kind]}）"
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
        # その場のターンは向きで呼ぶ（「左回りターン」）。インサイド/アウトサイドは CBL＋ターンの名前に使い、
        # その場のターンでは回転の欄にラベルとして添えるだけ（on2-timing-and-terms.md §8-6・§8-7）
        return f"{DIR_SHORT[d]}ターン{suffix}" if d in DIR_SHORT else None
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
    """On2（Eddie Torres 式。踏むのは 1-2-3 / 5-6-7、ブレイクは 2 と 6）の言い方。
    docs/salsa-knowledge/on2-timing-and-terms.md §2.2・§4・§8 に合わせる:
    - ベーシック: 男は 2 で右足を後ろ・6 で左足を前、女はその逆（2 で左足を前・6 で右足を後ろ）
    - CBL 系: 男は前の 8 カウントの 6 で前へブレイクして 7〜1 で左へ約 90° 開く（行の頭 = 1 で開き切る）。
      女は 1〜3 で横断し 2 で男の横を通る（「7-1で開く」の 7 は前の 8 カウントの 7）。素の CBL は 3 前後で ½ 回って線に戻り、5 で着地。
      ターン付き（インサイド/アウトサイド）は 2 で回り始め 2-3-(4)-5 で 1½、5 で着地
    - その場の右回り（スポット）: 前の 8 カウントの 5-6-7 でプレップし、1（早ければ 8）から回る。1-2-3
    - その場の左回り: 2 から回る（2-3）、5 で着地
    - コパ: 2 で男の前へ入り 3 で背中を見せて止まり、4 で出口、5 で元の側へ戻る
    - 男自身の回転は男の前半（On2 では 5-6-7）
    リードする手（男の左手/右手）・女が男のどちら側を抜けるか・回る向き（左回り/右回りを主に、インサイド/アウトサイドを
    添える）を欄の値から書く。分からない要素は書かない（「手を上げる」等）"""
    move = mv.get("move")
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else None
    who = (turn or {}).get("by")
    kind = (turn or {}).get("kind")
    ftxt = turn_text(turn, kind=kind) if who in ("follower", "both") else ""
    hand = HAND_WORD.get(mv.get("leadHand"), "手")
    ps = SIDE_WORD.get(mv.get("passSide"))
    via = f"男の{ps}側を通り" if ps else "男の横を通り"
    a, b = "1-2-3", "5-6-7"
    if move == "basic":
        rows = [(a, "2で右足を後ろへ", "2で左足を前へ"), (b, "6で左足を前へ", "6で右足を後ろへ")]
    elif move == "cbl":
        rows = [(a, f"7-1で左へ開き{hand}で送る", f"2で{via}3で½回る"),
                (b, "5で向き直り6で前へ", "5で着地し6で後ろへ")]
    elif move in ("cbl_inside_turn", "cbl_outside_turn"):
        d = "left" if move == "cbl_inside_turn" else "right"
        lead = f"{hand}を頭上へ上げ内へ回す" if d == "left" else f"{hand}を外へ振り出し頭上で回す"
        rows = [(a, f"7-1で左へ開き{lead}", f"2で{via}{turn_text(turn, d, kind)}"),
                (b, "5で向き直り6で前へ", "3-(4)-5で回り切り5で着地・6で後ろへ")]
    elif move == "reverse_cbl":
        rows = [(a, f"7-1で右へ開き{hand}で送る", f"2で{via}" + (f"{ftxt}" if ftxt else "3で½回る")),
                (b, "5で向き直り6で前へ", "5で着地し6で後ろへ")]
    elif move in IN_PLACE_TURNS:
        d = (turn or {}).get("direction")
        if d not in DIR_SHORT:
            d = "right" if move in ("right_turn", "outside_turn") else "left"
        txt = turn_text(turn, d, kind)
        if d == "right":
            # スポットの右回り: プレップは前の 8 カウントの 5-6-7（手が 6 で下・7 で上・1 で頂点）、1 から回る
            rows = [(a, f"{hand}を頭上で回す（前の5-6-7で準備）", f"1から{txt}・3で正対"),
                    (b, "6で前へ", "6で後ろへ")]
        else:
            rows = [(a, f"2で下がり{hand}を上げ内へ回す", f"2から{txt}"),
                    (b, "6で前へ", "5で着地し6で後ろへ")]
    elif move == "leader_turn":
        rows = [(a, "2で後ろへ", "2で前へ"), (b, f"5-6-7で自分で{turn_text(turn) or '回る'}", "6で後ろへ")]
    elif move == "copa":
        rows = [(a, f"7-1で左へ開き{hand}で引き込む", "2で男の前へ入り3で背を向けて止まる"),
                (b, f"{hand}で引き戻す", "5で½回って元の側へ戻る")]
    elif move == "hand_change":
        rows = [(a, "手を持ち替える", "2で前へ"), (b, "6で前へ", "6で後ろへ")]
    elif move == "shine":
        rows = [("1-8", "手を離して各自", "手を離して各自")]
    elif move == "wrap":
        rows = [(a, f"{hand}を上げ内へ巻き込む", "2-3で左回りで巻かれる"), (b, "腕で包む", "男の横に並ぶ")]
    elif move == "hammerlock":
        rows = [(a, f"{hand}を腰の高さで回す", "1から回り手が背中へ"), (b, "背中で手を止める", "6で後ろへ")]
    elif move == "shadow":
        rows = [(a, "女の後ろへ", "2で前へ"), (b, "同じ向きで踊る", "同じ向き")]
    elif move == "dip":
        rows = [(a, "支える", "後ろへ倒れる"), (b, "起こす", "戻る")]
    else:
        if not ftxt and not (turn and who == "leader"):
            return []
        if ftxt:
            rows = [(a, f"{hand}でリード", f"2から{ftxt}")]
        else:
            rows = [(b, f"5-6-7で自分で{turn_text(turn)}", "その場")]
    return [{"count": c, "leader": l, "follower": f} for c, l, f in rows]


# ---------------------------------------------------------------- 立ち位置（tracks.json）とパスの整合

SIDE_START_BEATS = 0.0    # 行の始まりの立ち位置: 頭（カウント 1、女が通る 2 の手前）までに最後に確かめた側
SIDE_END_BEATS = -2.5     # 行の終わりの立ち位置: 次の行の頭からこの拍数（負 = 手前）以降に最初に確かめた側
# （カウント 6½ 以降 = 5 で着地して 6 で後ろへブレイクした後）
# 正解表（1230b3d5・ジョブ 581ef6a2、SWAP_BEAT 4.0）で開始 -2〜1.5 拍・終了 -3.5〜0.5 拍を振り、開始 -1〜0.5・
# 終了 -2.5〜0.5 が行の一致 0.897・入れ替わりの再現率 0.935 で最良。On2 で意味の通る 0 / -2.5 にした
# （以前の「5 で通る」格子では 1.0 / -0.5 が最良だった）
# 行ごとの局所位相（swapAt を 5 拍目に寄せてカウントを付け直す）は試して入れていない（1230b3d5・581ef6a2、
# 以下は以前の「5 で通る」格子での記録）:
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
    開始は 1 拍目までに最後に確かめた側、終了は 6½ 拍目以降に最初に確かめた側（On2 なら 2 で通って
    5 で着地するので、通過の途中を読まない）。swapAt はその行の中で左右が入れ替わった時刻
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
        if t0 - 0.5 <= cross_t(e) < t1:
            side =(e.get("pass") or {}).get("side")
            if side in ("left", "right"):
                return side
    return None


def cv_lead_hand(summary, t0, t1):
    """行の中の CV の CBL イベントで男性が頭上に上げた手（L/R）。無ければ None"""
    for e in (summary or {}).get("events") or []:
        if not isinstance(e, dict) or e.get("type") != "CBL" or not _num(e.get("t")):
            continue
        if t0 - 0.5 <= cross_t(e) < t1:
            hr =e.get("handRaise") or {}
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


# 回転数の事前分布（技ごとの普通の回数。先頭ほど普通。docs/salsa-knowledge/on2-timing-and-terms.md §5・§8-4）:
# CBL ½、CBL＋インサイド/アウトサイド 1½（ダブルは 2½）、その場のターン 1（ダブル 2）、男のターン 1（2）
ROT_PRIOR = {
    "cbl": (0.5,),
    "cbl_inside_turn": (1.5, 2.5), "cbl_outside_turn": (1.5, 2.5),
    "reverse_cbl": (0.5, 1.5, 2.5),
    "right_turn": (1.0, 2.0), "left_turn": (1.0, 2.0), "inside_turn": (1.0, 2.0), "outside_turn": (1.0, 2.0),
    "leader_turn": (1.0, 2.0),
}
MIN_BEATS_PER_ROT = 1.0    # 多回転でも 1 回転に最低 1 拍（シングルは ≈ 2 拍）。これより多い回転は採らない
TURN_WINDOW_BEATS = 4.0     # CV の回転区間が無いときに回転に使える拍（半分の 8 カウント。On2 の 2-3-(4)-5 等）


def cv_spin_info(summary, t0, t1, by="follower"):
    """行の中で回り始めた CV のターン（全フレームで数え直した spin）: {"dir", "turns", "dur"}。
    dir/turns は全部の run が同じ向きのときだけ（左に回ってから右に回り直した等は数が当てにならないので None）。
    dur は回っていた区間の秒数（無ければ None）。ターンが無ければ None"""
    for e in (summary or {}).get("events") or []:
        if not isinstance(e, dict) or e.get("type") != "Turn" or e.get("by") != by:
            continue
        sp = e.get("spin") or {}
        a, b = sp.get("from", e.get("t")), sp.get("to")
        if not _num(a) or not (t0 - 0.3 <= a < t1):
            continue
        runs = [r for r in sp.get("runs") or [] if r.get("dir") in DIR_SHORT and _num(r.get("turns"))]
        dirs = {r["dir"] for r in runs}
        one = len(dirs) == 1
        return {"dir": next(iter(dirs)) if one else None,
                "turns": sum(r["turns"] for r in runs) if one else None,
                "dur": (b - a) if _num(b) and b > a else None}
    return None


def apply_rotation_prior(mv, spin, beat):
    """回転数の目安（ROT_PRIOR）は穴埋めと上限だけに使う。戻り値は直した印（変えなければ None）。
    - 数が無いとき: CV の回転（同じ向きの run だけ）があればその数、無ければ技の普通の回数で埋める
    - 数があるときは目安の最寄りへ寄せない（Claude・CV の数が目安より多くても下げない）。以前は寄せていたが、
      正解表で寄せた行は 5 行とも悪化した（8c312c6d 4.1 2→1½・正解 3 等。目安より多く回るのが普通）。
      6 本の回転数の誤差 .469 → .406（docs/salsa-knowledge/README.md 反映済み 16）
    - 拍の上限: 回転に使える拍（TURN_WINDOW_BEATS。CV の回転区間がそれより長ければその拍数。CV の区間は見えていた
      間だけなので下限であって上限ではない）÷ MIN_BEATS_PER_ROT。MAX_ROT と合わせて二重の歯止め
    元の値は turn.claudeRotations、寄せた理由は turn.rotationSource（prior / beats）に残す"""
    turn = mv.get("turn")
    if not isinstance(turn, dict):
        return None
    prior = ROT_PRIOR.get(mv.get("move"))
    if mv.get("move") == "leader_turn" and turn.get("by") != "leader":
        prior = None
    if not _num(turn.get("rotations")):
        # 数が無いときだけ目安で埋める（CV の数があればそれ）
        cv = spin.get("turns") if spin and spin.get("dir") in (turn.get("direction"), None) else None
        fill = cv if _num(cv) and cv > 0 else (prior[0] if prior else None)
        if fill is None:
            return None
        turn["rotations"] = fill
        turn["rotationSource"] = "cv" if fill == cv else "prior"
        return f"rotations:None->{fill}({turn['rotationSource']})"
    r = turn["rotations"]
    new, src = r, None
    if beat and beat > 0:
        dur = (spin or {}).get("dur")
        beats = max(TURN_WINDOW_BEATS, dur / beat if _num(dur) else 0.0)
        cap = max(0.5, math.floor(beats / MIN_BEATS_PER_ROT * 2) / 2)
        if new > cap:
            new, src = cap, "beats"
    if new == r:
        return None
    turn.setdefault("claudeRotations", r)
    turn["rotations"] = new
    turn["rotationSource"] = src
    return f"rotations:{r}->{new}({src})"


FOLLOWER_FIRST_MOVES = {"basic", "hand_change", "leader_turn"}   # 女性の CV のターンがあれば女性のターンを付ける行


def prefer_follower_turn(mv, fspin):
    """1 行に書けるターンは 1 つなので、女性のターンを主（turn）にし、男のターンは leaderTurn に移す。
    - 行のターンが男（leader_turn 等）で、行の中で女性の CV のターン（向きのそろった 1 回転以上）が回り始めていれば、
      女性のターンを turn に、男のターンを leaderTurn に
    - ベーシック・持ち替えの行に女性の CV のターンがあれば、ターンを付ける
    どちらも CV の向き・回転数で、その場のターン（left_turn / right_turn）にして「?」を付ける（入れ替わりがあれば
    この後の check_pass が CBL＋ターンにする）。戻り値は直した印（変えなければ None）。
    正解表では 2fda2815 5.9（CBL 直後の女性の左 1½ が男のライトターンの行に入る）・screenrec 16.4・img1884 44.1 等"""
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else None
    by = (turn or {}).get("by")
    if by in ("follower", "both") or not fspin or fspin.get("dir") not in DIR_SHORT or not _num(fspin.get("turns")) \
            or fspin["turns"] < 1:
        return None
    move = mv.get("move")
    if not (by == "leader" or move in FOLLOWER_FIRST_MOVES):
        return None
    if by == "leader":
        mv["leaderTurn"] = {"direction": turn.get("direction"), "rotations": turn.get("rotations")}
    d = fspin["dir"]
    mv["turn"] = {"by": "follower", "direction": d, "rotations": max(0.5, min(MAX_ROT, round_half(fspin["turns"]))),
                  "directionSource": "cv", "rotationSource": "cv"}
    mv["move"] = f"{d}_turn"
    mv["name"] = DEFAULT_NAME[mv["move"]]
    return f"followerTurn:{move}->{mv['move']}"


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


SWAP_TO_CBL_MOVES = {"other", "wrap", "copa"}   # CV の入れ替わりが入っていたら CBL 系に寄せる技（名前の付けにくい速い組み合わせ）


def cv_swaps_in(summary, t0, t1):
    """行の中の CV の CBL イベント（腰の交差の時刻の順）"""
    ev = [e for e in (summary or {}).get("events") or []
          if isinstance(e, dict) and e.get("type") == "CBL" and _num(e.get("t")) and t0 <= cross_t(e) < t1]
    return sorted(ev, key=cross_t)


def check_multi_swap(mv, swaps):
    """1×8 に入れ替わりが 2 回ある（通って戻る・CBL を 4 拍で 2 回）と Claude は別の名前（move = other 等）にしがちで、
    振付シートでも評価でも入れ替わりの行にならない（2fda2815 3.2「CBL→アンダーアーム?」、screenrec 9.7・19.8
    「アラウンド・ザ・ワールド?」等）。CV の入れ替わりが入った other / wrap / copa の行は CBL 系に寄せる
    （女性のターンがあれば CBL＋インサイド/アウトサイド、無ければ CBL）。
    入れ替わりが 2 つ以上の other / wrap / copa / cbl の行は「CBL×2」、2 回の通る側（pass.side）が逆なら「CBL＋逆CBL」。
    元の名前は claudeName に残す。戻り値は直した印（変えなければ None）"""
    move = mv.get("move")
    if not swaps or move not in SWAP_TO_CBL_MOVES | {"cbl"}:
        return None
    if move == "cbl" and len(swaps) < 2:
        return None
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else {}
    d = turn.get("direction") if turn.get("by") in ("follower", "both") else None
    new = "cbl"
    if len(swaps) < 2 and d in DIR_SHORT:
        new = "cbl_inside_turn" if d == "left" else "cbl_outside_turn"
    mv.setdefault("claudeName", mv.get("name"))
    mv["move"] = new
    if len(swaps) >= 2:
        sides = [(e.get("pass") or {}).get("side") for e in swaps[:2]]
        rev = sides[0] in ("left", "right") and sides[1] in ("left", "right") and sides[0] != sides[1]
        mv["name"] = "CBL＋逆CBL" if rev else "CBL×2"
        mv["swapCount"] = len(swaps)
    else:
        mv["name"] = DEFAULT_NAME[new]
    if mv.get("passSide") not in ("left", "right"):
        mv["passSide"] = (swaps[0].get("pass") or {}).get("side") if (swaps[0].get("pass") or {}).get("side") in ("left", "right") else None
    return f"multiSwap:{move}->{new}x{len(swaps)}"


INSIDE_NEAR_BEATS = 4.0  # インサイドターンの行の外でも、この拍数（半分の 8 カウント）以内の入れ替わりはその技のパスとみなす


def check_inside_turns(out, beat, timing, summary=None):
    """移動しながらの女性のターンは普通 CBL と組む（CBL＋インサイド/アウトサイド: 女性は 2 で男の横を抜けながら
    2-3-(4)-5 で 1½）。その場のターン（左回り・右回り）の行で入れ替わりが無いとき:
    - 前後の行の、この行から半分の 8 カウント以内に CV の入れ替わりがあり、その行が CBL 系でない（入れ替わりの
      持ち主がいない）なら、この行を CBL＋インサイド（左回り）/ CBL＋アウトサイド（右回り）に付け替えて「?」を付ける
      （インサイド/アウトサイドを手で決めていた頃は、女の左手の右回りも「インサイド」としてここで付け替えていた）
    - そうでなければ、その場のターンのまま。入れ替わりの無い左回転・右回転は普通の技（MG の Left turn / Right turn）
      なので「?」は付けない（on2-timing-and-terms.md §8-7）。以前はインサイドに「?」を付けていた
    戻り値は直した印のリスト（付け替えたものだけ）"""
    fixes = []
    for k, mv in enumerate(out):
        turn = mv.get("turn") or {}
        sides = mv.get("sides")
        kind = turn.get("kind")
        if mv.get("move") not in IN_PLACE_TURNS or kind not in KIND_WORD or not sides or sides.get("swapAt"):
            continue
        target = f"cbl_{kind}_turn"
        t0 = mv["start"]
        t1 = out[k + 1]["start"] if k + 1 < len(out) else t0 + mv["counts"] * beat
        near = None
        for j in (k - 1, k + 1):
            # CBL 系の行の入れ替わりはその行のもの。2 つ以上あるとき近い端の 1 つを取るのも試したが、正解表で
            # 行の一致が 0.914 → 0.862（581ef6a2）/ 0.786 → 0.768（2f4b6919）に落ちたので入れていない
            if not (0 <= j < len(out)) or out[j].get("move") in CBL_MOVES:
                continue
            for s in (out[j].get("sides") or {}).get("swapAt") or []:
                if t0 - INSIDE_NEAR_BEATS * beat <= s < t1 + INSIDE_NEAR_BEATS * beat:
                    near = (j, s)
        if near:
            fix = f"turnNearSwap:{mv['move']}->{target}@{near[1]}"
            mv["move"] = target
            mv["passSide"] = mv.get("passSide") if mv.get("passSide") in ("left", "right") else None
            rot = apply_rotation_prior(mv, cv_spin_info(summary, t0, t1), beat)
            if rot:
                mv["rotationCheck"] = rot
            mv["name"] = turn_name(mv) or DEFAULT_NAME[target]
            mv["steps"] = template_steps(mv, timing)
            mv["stepsSource"] = "template"
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

def normalize(result, summary, duration=None, default_timing=None, tracks=None, swap_beat=None):
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
    sb = swap_beat if _num(swap_beat) else swap_beat_for(summary)
    if beats:
        period, beat, first = beats
        phase = best_phase(starts, period, [first + beat * k for k in range(8)])
        tempo_src = "audio"
    else:
        guess = salsa_unit8(unit8_from_routine(moves)) or DEFAULT_UNIT8
        swaps = swap_times(summary)
        swap_fit = fit_grid_to_swaps(swaps, guess, duration or (max(starts) + guess), turn_times(summary),
                                     swap_beat=sb)
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
        cells = align_to_swaps(moves, heads, swaps, sb)
    elif tempo_src == "audio" and AUDIO_ALIGN and swap_times(summary):
        # 音声の格子も、位相はそのまま、Claude の行の割り当てだけ CV の入れ替わりのある 8 カウントに合わせる
        # （無音の格子と同じ align_to_swaps。Claude の行が 1 行ずれて CBL が隣の行に入るのを直す）
        swaps = swap_times(summary)
        cells = align_to_swaps(moves, heads, swaps, sb, has=audio_swap_cells(heads, swaps))
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
        for mv, sides in zip(out, move_sides(out, runs, crosses, beat, duration, swap_times_any(summary))):
            mv["sides"] = sides
    fixes = []
    for k, mv in enumerate(out):
        t0 = mv["start"]
        t1 = out[k + 1]["start"] if k + 1 < len(out) else t0 + mv["counts"] * beat
        ft = prefer_follower_turn(mv, cv_spin_info(summary, t0, t1))
        if ft:
            mv["turnCheck"] = ft
            mark_uncertain(mv)
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
        ms = check_multi_swap(mv, cv_swaps_in(summary, t0, t1))
        if ms:
            mv["swapCheck"] = ms
            fixes.append(ms)
            mark_uncertain(mv)
        # 回転数を技の普通の回数へ（技の種類が決まった後で）
        rot = apply_rotation_prior(mv, cv_spin_info(summary, t0, t1), beat)
        if rot:
            mv["rotationCheck"] = rot
        # リードする手: 片手でつないでいれば男性のその手、無ければ CV が見た頭上に上がった手
        mv["leadHand"] = leader_hand(turn_hold(mv) or mv.get("holdStart")) or cv_lead_hand(summary, t0, t1)
        turn = mv.get("turn")
        if isinstance(turn, dict):
            kind = turn_kind(turn, turn_hold(mv))
            turn.pop("kind", None)
            if kind:
                turn["kind"] = kind
                # 技の種類を回る向きに合わせる（Claude の付けた inside/outside・右/左ターンと食い違うことがある。
                # CV の向きで直した行も。例: Claude の「右ターン」で CV が左回り → left_turn）
                if mv["move"] in ("cbl_inside_turn", "cbl_outside_turn"):
                    mv["move"] = f"cbl_{kind}_turn"
                elif mv["move"] in IN_PLACE_TURNS:
                    # その場のターンは右回り/左回りで呼ぶ（インサイド/アウトサイドは CBL と組んだ形の名前。
                    # on2-timing-and-terms.md §8-7: 入れ替わりの無い左回転は left_turn）
                    mv["move"] = f"{turn['direction']}_turn"
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

    fixes += check_inside_turns(out, beat, timing, summary)

    routine["rawMoves"] = raw
    routine["moves"] = out
    routine["timing"] = timing
    routine["timingSource"] = timing_src
    routine["passChecks"] = len(fixes)
    routine["directionChecks"] = sum(1 for m in out if m.get("directionCheck"))
    routine["rotationChecks"] = sum(1 for m in out if m.get("rotationCheck"))
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
        routine["grid"]["swapBeat"] = sb
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
    sb = float(opts["swap-beat"]) if opts.get("swap-beat") else None   # 評価用の上書き
    normalize(result, summary, duration, default_timing, tracks, sb)
    after = len(((result.get("routine") or {}).get("moves") or []))
    tmp = result_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp, result_path)
    grid = (result.get("routine") or {}).get("grid")
    print(f"normalized routine: {before} -> {after} moves, grid={grid}", file=sys.stderr)


if __name__ == "__main__":
    main()
