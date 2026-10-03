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
   Claude の routine の「1×8 あたりの秒数」の中央値から推定し、技の頭の時刻に最もよく合う周期に微調整する
2. 位相（8カウントの頭がどこか）を、技の頭の時刻が最もよく乗る値に決め、各技の start を最寄りの 8 カウントの頭へ寄せる
3. 同じ頭に寄った技は 1 行にまとめる（ターン・パスがある方を主にする）。counts は次の技の頭までの 8 の倍数
4. 回転数は ½ 刻みに丸め、2 回転を上限にする（画像で見えていて自信 0.7 以上なら 3 回転まで）。
   削ったら自信を下げて「?」が付くようにする
5. 技名は全角 14 文字以内に縮める（括弧書きを落とし「クロスボディリード」→「CBL」等）
6. 各技に、カウントごとに男女が何をするかの短い行（steps）を付ける。Claude が書いていればそれを使い、
   無ければ技の種類・回転・通る側から決まった言い回しで埋める

元の行は routine.rawMoves に残す（何度実行しても rawMoves から作り直すので結果は同じ）。

Usage: python normalize_routine.py <result.json> <measurements.json>
  result.json をその場で書き換える。routine.moves が無ければ何もしない
"""
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

DEFAULT_NAME = {
    "basic": "ベーシック", "cbl": "CBL", "cbl_inside_turn": "CBL＋インサイド",
    "cbl_outside_turn": "CBL＋アウトサイド", "reverse_cbl": "逆CBL", "right_turn": "右ターン",
    "left_turn": "左ターン", "inside_turn": "インサイドターン", "outside_turn": "アウトサイドターン",
    "leader_turn": "男性ターン", "copa": "コパ", "hand_change": "持ち替え", "wrap": "ラップ",
    "hammerlock": "ハンマーロック", "shadow": "シャドウ", "dip": "ディップ", "shine": "シャイン",
    "other": "その他",
}
LIGHT_MOVES = {"basic", "shine", "other", "hand_change"}


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
    """技の種類から決まる、男女のカウントごとの動き（On1 の言い方。On2 は女性の動きを 1-2-3 に）"""
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
    if timing == "on2" and len(rows) == 2:
        rows = [(rows[0][0], rows[1][1], rows[1][2]), (rows[1][0], rows[0][1], rows[0][2])]
    return [{"count": c, "leader": l, "follower": f} for c, l, f in rows]


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

def normalize(result, summary, duration=None):
    """result（dict）の routine を整えて返す（result をその場で書き換える）"""
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
    timing = routine.get("timing") or (result.get("style") or {}).get("onBeat")

    beats = grid_from_beats(summary)
    starts = [m["start"] for m in moves]
    if beats:
        period, beat, first = beats
        phase = best_phase(starts, period, [first + beat * k for k in range(8)])
        tempo_src = "audio"
    else:
        period, phase = fit_grid(starts, unit8_from_routine(moves) or DEFAULT_UNIT8)
        beat = period / 8
        tempo_src = "routine"

    # 各技を最寄りの 8 カウントの頭へ。同じ頭（または前の行より前）に寄ったら前の行にまとめる
    groups = []
    for m in moves:
        g = round((m["start"] - phase) / period)
        if groups and g <= groups[-1][0]:
            groups[-1][1].append(m)
        else:
            groups.append((g, [m]))

    if duration is None or not _num(duration):
        duration = moves[-1]["start"] + period
    out = []
    for k, (g, grp) in enumerate(groups):
        mv = merge_group(grp)
        t0 = max(0.0, phase + g * period)
        n8 = (groups[k + 1][0] - g) if k + 1 < len(groups) else max(1, round((duration - t0) / period))
        mv["start"] = round(t0, 2)
        mv["counts"] = 8 * max(1, n8)
        turn, capped = clean_turn(mv.get("turn"), mv)
        mv["turn"] = turn
        if capped:
            c = mv.get("confidence")
            mv["confidence"] = min(c, LOW_CONF) if _num(c) else LOW_CONF
        mv["name"] = short_name(mv.get("name"), mv.get("move"))
        steps = clean_steps(mv.get("steps"))
        mv["steps"] = steps or template_steps(mv, timing)
        mv["stepsSource"] = "claude" if steps else "template"
        out.append(mv)

    routine["rawMoves"] = raw
    routine["moves"] = out
    routine["grid"] = {
        "unitSec": round(period, 3), "beatSec": round(beat, 4), "phaseSec": round(phase % period, 3),
        "source": tempo_src,
    }
    if not _num(routine.get("bpm")) or routine.get("bpm") <= 0:
        routine["bpm"] = round(60 / beat)
        routine["bpmSource"] = tempo_src
    return result


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    result_path, meas_path = sys.argv[1:3]
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
    normalize(result, summary, duration)
    after = len(((result.get("routine") or {}).get("moves") or []))
    tmp = result_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp, result_path)
    grid = (result.get("routine") or {}).get("grid")
    print(f"normalized routine: {before} -> {after} moves, grid={grid}", file=sys.stderr)


if __name__ == "__main__":
    main()
