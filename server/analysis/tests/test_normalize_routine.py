"""
normalize_routine.py（振付シート用の routine の後処理）の単体テスト。

「これじゃ踊れんわ」— 1 秒おきの 1-8、4 秒の 1-16、3 回転・4½ 回転、長い説明文の技名、
「どう動くか」が無いカード、を直すための決定的な処理を確かめる。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import pair_sides  # noqa: E402
from normalize_routine import (  # noqa: E402
    NAME_MAX, SWAP_BEAT, apply_rotation_prior, clean_turn, fit_grid, fit_grid_to_swaps, grid_cycles, normalize,
    salsa_unit8, short_name, swap_heads,
    template_steps, turn_kind,
)
from eval_routine_grid import evaluate as evaluate_rows  # noqa: E402


def mv(start, move="basic", counts=8, **kw):
    return {"start": start, "move": move, "counts": counts, **kw}


class GridTest(unittest.TestCase):
    def test_audio_grid_snaps_starts_to_8_count_heads(self):
        # 120 BPM → 1×8 = 4 秒、最初の拍 0.5 秒。技の頭は 0.5 / 4.5 / 8.5 … に寄る
        res = {"routine": {"timing": "on1", "moves": [
            mv(0.6), mv(4.3, "cbl"), mv(8.9, "right_turn", turn={"by": "follower", "direction": "right", "rotations": 1}),
        ]}}
        normalize(res, {"beatGrid": {"bpm": 120, "beatIntervalSec": 0.5, "firstBeatSec": 0.5}}, duration=12.6)
        moves = res["routine"]["moves"]
        self.assertEqual([m["start"] for m in moves], [0.5, 4.5, 8.5])
        self.assertEqual([m["counts"] for m in moves], [8, 8, 8])
        self.assertEqual(res["routine"]["grid"]["source"], "audio")
        self.assertEqual(res["routine"]["bpm"], 120)

    def test_counts_follow_duration(self):
        # 2×8 分の長さがある行は counts 16 になる（Claude が 8 と書いていても）
        res = {"routine": {"moves": [mv(0.0), mv(4.0, "cbl"), mv(12.0)]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=16.0)
        self.assertEqual([m["counts"] for m in res["routine"]["moves"]], [8, 16, 8])

    def test_tiny_moves_are_merged_into_one_line(self):
        # 1 秒おきに 1-8 が並ぶ（同じ 8 カウントに入る）→ 1 行にまとめ、ターン・パスのある方を主にする
        res = {"routine": {"moves": [
            mv(0.0), mv(4.0, "basic", name="ベーシック"),
            mv(4.9, "cbl_inside_turn", name="CBL＋インサイドターン", passSide="left",
               turn={"by": "follower", "direction": "left", "rotations": 1.5}, holdEnd="LR"),
            mv(8.0),
        ]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=12.0)
        moves = res["routine"]["moves"]
        self.assertEqual(len(moves), 3)
        self.assertEqual(moves[1]["move"], "cbl_inside_turn")
        self.assertEqual(moves[1]["start"], 4.0)
        self.assertEqual(moves[1]["mergedFrom"], ["ベーシック"])
        self.assertEqual(moves[1]["holdEnd"], "LR")
        self.assertEqual(len(res["routine"]["rawMoves"]), 4)

    def test_silent_video_estimates_tempo_from_routine(self):
        # 無音（beatGrid なし）: 1×8 ≈ 2.4 秒で並んだ routine（時刻に少しずれ）から周期を推定して揃える
        starts = [0.0, 2.5, 4.7, 7.3, 9.6, 12.1, 14.4, 16.9]
        res = {"routine": {"moves": [mv(s) for s in starts]}}
        normalize(res, {"beatGrid": None}, duration=19.3)
        g = res["routine"]["grid"]
        self.assertEqual(g["source"], "routine")
        self.assertAlmostEqual(g["unitSec"], 2.4, delta=0.12)
        self.assertEqual(len(res["routine"]["moves"]), len(starts))
        self.assertTrue(all(m["counts"] == 8 for m in res["routine"]["moves"]))
        self.assertEqual(res["routine"]["bpmSource"], "routine")

    def test_fit_grid_prefers_period_with_heads_on_every_line(self):
        starts = [k * 3.0 + 0.4 for k in range(10)]
        period, phase = fit_grid(starts, 3.1)
        self.assertAlmostEqual(period, 3.0, delta=0.05)
        self.assertAlmostEqual(phase % period, 0.4, delta=0.1)

    def test_idempotent(self):
        res = {"routine": {"moves": [mv(0.2), mv(2.6, "cbl"), mv(3.1, "left_turn"), mv(5.1)]}}
        normalize(res, {}, duration=8.0)
        first = [dict(m) for m in res["routine"]["moves"]]
        normalize(res, {}, duration=8.0)
        self.assertEqual(res["routine"]["moves"], first)


def swaps_on_grid(period, head, n, beat_pos=SWAP_BEAT, jitter=(0.0,), skip=(), drift=0.0, span=None):
    """8 カウントの頭 head + k×period（drift ありなら grid_cycles に沿って）の beat_pos 拍目に入れ替わりを置く"""
    out = []
    span = span or period * n
    for k in range(n):
        if k in skip:
            continue
        # grid_cycles(t) = k + beat_pos/8 + head/period を解く（drift=0 なら直接）
        target = k + beat_pos / 8 + head / period
        lo, hi = 0.0, span * 2
        for _ in range(60):
            mid = (lo + hi) / 2
            if grid_cycles(mid, period, drift, span) < target:
                lo = mid
            else:
                hi = mid
        out.append(round(lo + jitter[k % len(jitter)], 3))
    return out


def cbl_events(times):
    return [{"t": t, "type": "CBL", "by": "pair"} for t in times]


class SwapGridTest(unittest.TestCase):
    JIT = (0.0, 0.25, -0.2, 0.1, -0.3, 0.15, 0.3, -0.1)

    def test_fits_period_and_phase_from_swaps(self):
        # 本当は 1×8 = 2.6 秒・頭 0.5 秒。Claude の routine の目安は 2.4 秒（ずれている）。
        # 入れ替わりは SWAP_BEAT 拍目付近（±0.3 秒）で、ところどころ抜けている
        sw = swaps_on_grid(2.6, 0.5, 50, jitter=self.JIT, skip={3, 9, 10, 22, 31, 40})
        fit = fit_grid_to_swaps(sw, 2.4, 130.0)
        self.assertIsNotNone(fit)
        self.assertAlmostEqual(fit["period"], 2.6, delta=0.01)
        heads = swap_heads(fit, 130.0)
        # 頭の時刻が本当の頭（0.5 + k×2.6）から 1 拍未満
        for h in heads:
            if 0 <= h <= 125:
                d = (h - 0.5) / 2.6
                self.assertLess(abs(d - round(d)) * 8, 1.0, h)

    def test_too_few_or_scattered_swaps_give_none(self):
        self.assertIsNone(fit_grid_to_swaps([1.0, 3.6, 6.2], 2.4, 10.0))
        # でたらめな時刻の（周期の無い）入れ替わり
        rng = random.Random(7)
        scattered = sorted(round(rng.uniform(0, 150), 2) for _ in range(40))
        self.assertIsNone(fit_grid_to_swaps(scattered, 2.4, 150.0))

    def test_slow_tempo_drift(self):
        # 終わりまでに等速の格子から 1½ 個ぶん先へ進む（テンポがゆっくり上がる）
        sw = swaps_on_grid(2.6, 0.5, 60, drift=1.5, span=156.0, jitter=(0.0, 0.05, -0.05))
        fit = fit_grid_to_swaps(sw, 2.6, 156.0)
        self.assertIsNotNone(fit)
        self.assertAlmostEqual(fit["drift"], 1.5, delta=0.3)
        # 終わりの方でも入れ替わりが SWAP_BEAT 拍目付近に来る
        heads = swap_heads(fit, 156.0)
        for s in sw[-10:]:
            h = max(x for x in heads if x <= s - 2 * 2.6 / 8)
            beat = (s - h) / (2.6 / 8)
            self.assertAlmostEqual(beat, SWAP_BEAT, delta=1.0)

    def test_no_drift_when_not_needed(self):
        sw = swaps_on_grid(2.6, 0.5, 50, jitter=self.JIT)
        self.assertEqual(fit_grid_to_swaps(sw, 2.4, 130.0)["drift"], 0.0)

    def test_silent_video_uses_swaps_for_tempo(self):
        # 本当の 1×8 = 2.6 秒。Claude は 2.4 秒おきに行を書いた（前回の正規化で bpm 200 と決めてある）
        n = 30
        sw = swaps_on_grid(2.6, 0.3, n, jitter=self.JIT)
        moves = [mv(round(k * 2.4, 2), "cbl") for k in range(n)]
        res = {"routine": {"bpm": 200, "bpmSource": "routine", "moves": moves}}
        normalize(res, {"beatGrid": None, "events": cbl_events(sw)}, duration=n * 2.6)
        g = res["routine"]["grid"]
        self.assertEqual(g["source"], "swaps")
        self.assertAlmostEqual(g["unitSec"], 2.6, delta=0.02)
        self.assertEqual(res["routine"]["bpm"], round(60 / g["beatSec"]))   # 古い bpm 200 を決め直す
        self.assertEqual(res["routine"]["bpmSource"], "swaps")
        starts = [m["start"] for m in res["routine"]["moves"]]
        for a, b in zip(starts[1:], starts[2:]):   # 先頭は 0 秒に切り詰められることがあるので 2 行目から
            n8 = round((b - a) / 2.6)
            self.assertGreaterEqual(n8, 1)
            self.assertAlmostEqual(b - a, n8 * 2.6, delta=0.05)
        # 入れ替わりは各 8 カウントの SWAP_BEAT 拍目付近 = 頭は入れ替わりの SWAP_BEAT 拍前
        self.assertAlmostEqual((starts[5] - 0.3) / 2.6 % 1 * 8 % 8, 0.0, delta=0.8)

    def test_off_by_one_cbl_rows_are_shifted_onto_swaps(self):
        # 入れ替わりは 2・5・8・… 番目の 8 カウント。Claude の CBL の行はその 1 つ前（1・4・7・…）に書かれている
        n = 30
        cbl_cells = set(range(2, n, 3))
        sw = swaps_on_grid(2.6, 0.0, n, skip=set(range(n)) - cbl_cells, jitter=self.JIT)
        moves = [mv(round(k * 2.6 + 0.1, 2), "cbl" if (k + 1) in cbl_cells else "basic") for k in range(n)]
        res = {"routine": {"moves": moves}}
        normalize(res, {"events": cbl_events(sw)}, duration=n * 2.6)
        self.assertEqual(res["routine"]["grid"]["source"], "swaps")
        out = res["routine"]["moves"]
        cbl_starts = [m["start"] for m in out if m["move"] == "cbl"]
        # CBL の行の時間内に入れ替わりがある
        ends = {m["start"]: m["start"] + m["counts"] * res["routine"]["grid"]["beatSec"] for m in out}
        hit = sum(1 for s in cbl_starts if any(s <= t < ends[s] for t in sw))
        self.assertGreaterEqual(hit, len(cbl_starts) - 1)

    def test_audio_grid_ignores_swaps(self):
        # 音声の格子があれば入れ替わりは使わない（従来どおり）
        sw = swaps_on_grid(2.6, 0.5, 20, jitter=self.JIT)
        res = {"routine": {"moves": [mv(0.6), mv(4.3, "cbl"), mv(8.9)]}}
        normalize(res, {"beatGrid": {"bpm": 120, "beatIntervalSec": 0.5, "firstBeatSec": 0.5},
                        "events": cbl_events(sw)}, duration=12.6)
        self.assertEqual(res["routine"]["grid"]["source"], "audio")
        self.assertEqual([m["start"] for m in res["routine"]["moves"]], [0.5, 4.5, 8.5])

    def test_idempotent_with_swaps(self):
        sw = swaps_on_grid(2.6, 0.5, 30, jitter=self.JIT)
        res = {"routine": {"moves": [mv(round(k * 2.4, 2), "cbl" if k % 3 else "basic") for k in range(30)]}}
        summary = {"events": cbl_events(sw)}
        normalize(res, summary, duration=80.0)
        first = [dict(m) for m in res["routine"]["moves"]]
        normalize(res, summary, duration=80.0)
        self.assertEqual(res["routine"]["moves"], first)


class EvalRoutineGridTest(unittest.TestCase):
    def test_counts_cbl_rows_and_swap_phase(self):
        gt = {"evalRange": [0, 20], "cbl": [
            {"t": 1.8, "kind": "cbl"},              # 行 0（0〜2.4）は CBL → 当たり。5.5 拍目くらい（≒ 6 カウント目）
            {"t": 4.2, "kind": "cbl"},              # 行 1（2.4〜4.8）は basic → 外れ
            {"t": 6.0, "kind": "swap", "optional": True},
        ], "turns": [{"t": 5.0, "by": "follower"}]}
        moves = [mv(0.0, "cbl"), mv(2.4, "basic"), mv(4.8, "right_turn", turn={"by": "follower", "rotations": 1})]
        r = evaluate_rows(moves, gt, 0.3, cv_swaps=[1.9, 4.3])
        self.assertEqual((r["cbl"]["hit"], r["cbl"]["n"]), (1, 2))
        self.assertEqual((r["swapAll"]["hit"], r["swapAll"]["n"]), (1, 3))
        self.assertEqual((r["cblRows"]["hit"], r["cblRows"]["n"]), (1, 1))
        self.assertEqual((r["turn"]["hit"], r["turn"]["n"]), (1, 1))
        self.assertEqual(r["phase"]["hist"][6], 2)    # 1.8 秒・4.2 秒 = 行の頭から 6 拍 → カウント 7
        self.assertEqual(r["phase"]["hist"][4], 1)    # 6.0 秒 = 行 2 の頭から 4 拍 → カウント 5
        self.assertAlmostEqual(r["phase"]["in57"], 1.0)
        self.assertEqual(r["cvPhase"]["inCblRow"], 1)


class TurnTest(unittest.TestCase):
    def test_caps_implausible_rotations_and_lowers_confidence(self):
        t, capped = clean_turn({"by": "follower", "direction": "right", "rotations": 4.5},
                               {"evidence": "inferred", "confidence": 0.3})
        self.assertEqual(t["rotations"], 2.0)
        self.assertTrue(capped)

    def test_triple_allowed_only_when_seen_and_confident(self):
        t, capped = clean_turn({"rotations": 3}, {"evidence": "seen", "confidence": 0.8})
        self.assertEqual(t["rotations"], 3.0)
        self.assertFalse(capped)

    def test_rounds_to_half(self):
        t, _ = clean_turn({"rotations": 1.3}, {})
        self.assertEqual(t["rotations"], 1.5)

    def test_capped_row_gets_low_confidence(self):
        res = {"routine": {"moves": [
            mv(0.0, "right_turn", confidence=0.6, evidence="inferred",
               turn={"by": "follower", "direction": "right", "rotations": 3}),
        ]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["turn"]["rotations"], 2.0)
        self.assertLessEqual(m["confidence"], 0.35)


class NameTest(unittest.TestCase):
    def test_short_names_kept(self):
        self.assertEqual(short_name("CBL＋インサイドターン", "cbl_inside_turn"), "CBL＋インサイドターン")

    def test_long_names_shortened(self):
        n = short_name("密着ホールドからのクロスボディリード", "cbl")
        self.assertLessEqual(len(n), NAME_MAX)
        self.assertIn("CBL", n)

    def test_parentheses_dropped_and_question_kept(self):
        self.assertEqual(short_name("ベーシック（42.99 に左右入れ替わり・未確認）", "basic"), "ベーシック")
        self.assertEqual(short_name("リバース・クロスボディリード?", "reverse_cbl"), "リバース・クロスボディリード?")
        self.assertEqual(short_name("リバース・クロスボディリード・ライトターン?", "reverse_cbl"), "逆CBL＋ライトターン?")
        self.assertTrue(short_name("ライトターン?", "right_turn").endswith("?"))

    def test_descriptive_name_falls_back(self):
        n = short_name("手を離したまま男性が自分の手の下をくぐって回る動き", "leader_turn")
        self.assertEqual(n, "男性ターン")
        n2 = short_name("サイドバイサイドで男性の右腕に女性を抱えて歩く", "other")
        self.assertLessEqual(len(n2), NAME_MAX)
        self.assertTrue(n2.endswith("…"))


class StepsTest(unittest.TestCase):
    def test_template_for_inside_turn_uses_turn(self):
        s = template_steps({"move": "cbl_inside_turn", "turn": {"by": "follower", "direction": "left", "rotations": 1.5}}, "on1")
        self.assertEqual([x["count"] for x in s], ["1-2-3", "5-6-7"])
        self.assertIn("左回り（反時計回り）1½回", s[1]["follower"])

    def test_claude_steps_preferred_and_trimmed(self):
        res = {"routine": {"moves": [mv(0.0, "other", steps=[
            {"count": "1-2-3", "leader": "左手を上げる", "follower": "前へ"},
            {"count": "5-6-7", "leader": "x" * 30, "follower": "右回り1回"},
            {"count": "1-2-3", "leader": "余分", "follower": "余分"},
        ])]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["stepsSource"], "claude")
        self.assertEqual(len(m["steps"]), 2)
        self.assertEqual(len(m["steps"][1]["leader"]), 12)

    def test_template_filled_when_missing(self):
        res = {"routine": {"timing": "on1", "moves": [mv(0.0, "basic")]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["stepsSource"], "template")
        self.assertEqual(m["steps"][0], {"count": "1-2-3", "leader": "前へ", "follower": "後ろへ"})

    def test_on2_spot_right_turn_starts_on_1_after_prep_on_5_6_7(self):
        # Eddie Torres On2: その場の右回りは前の 5-6-7 でプレップし、1 から回る（on2-timing-and-terms.md §4）
        s = template_steps({"move": "right_turn", "turn": {"by": "follower", "direction": "right", "rotations": 1}}, "on2")
        self.assertEqual([x["count"] for x in s], ["1-2-3", "5-6-7"])
        self.assertIn("前の5-6-7で準備", s[0]["leader"])
        self.assertIn("1から右回り", s[0]["follower"])
        self.assertEqual(s[1]["follower"], "6で後ろへ")

    def test_on2_left_turn_starts_on_2(self):
        s = template_steps({"move": "left_turn", "turn": {"by": "follower", "direction": "left", "rotations": 1}}, "on2")
        self.assertIn("2から左回り", s[0]["follower"])
        self.assertIn("5で着地", s[1]["follower"])

    def test_on2_cbl_leader_opens_7_to_1_follower_passes_on_2(self):
        # 男は 6 で前へブレイクして 7〜1 で左へ開き、女は 2 で男の左側を通って 3 前後で ½、5 で着地
        s = template_steps({"move": "cbl", "passSide": "left"}, "on2")
        self.assertIn("7-1で左へ開き", s[0]["leader"])
        self.assertEqual(s[0]["follower"], "2で男の左側を通り3で½回る")
        self.assertIn("5で着地", s[1]["follower"])
        self.assertIn("6で前へ", s[1]["leader"])

    def test_on2_cbl_inside_turn_starts_on_2_and_lands_on_5(self):
        s = template_steps({"move": "cbl_inside_turn", "passSide": "left", "leadHand": "L",
                            "turn": {"by": "follower", "direction": "left", "rotations": 1.5, "kind": "inside"}}, "on2")
        self.assertEqual(s[0]["follower"], "2で男の左側を通り左回り1½回（インサイド）")
        self.assertIn("左手を頭上へ上げ内へ回す", s[0]["leader"])
        self.assertIn("3-(4)-5で回り切り5で着地", s[1]["follower"])

    def test_on2_basic_breaks_on_2_and_6(self):
        s = template_steps({"move": "basic"}, "on2")
        self.assertEqual(s[0], {"count": "1-2-3", "leader": "2で右足を後ろへ", "follower": "2で左足を前へ"})
        self.assertEqual(s[1], {"count": "5-6-7", "leader": "6で左足を前へ", "follower": "6で右足を後ろへ"})

    def test_default_timing_is_on2_when_unclear(self):
        res = {"style": {"onBeat": "unclear"}, "routine": {"timing": "unclear", "moves": [
            mv(0.0, "basic", steps=[{"count": "1-2-3", "leader": "前へ", "follower": "後ろへ"}]),
            mv(4.0, "shine", steps=[{"count": "1-8", "leader": "腕を回す", "follower": "髪を払う"}]),
        ]}}
        grid = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}
        normalize(res, grid, duration=8.0)
        r = res["routine"]
        self.assertEqual((r["timing"], r["timingSource"]), ("on2", "default"))
        # ベーシックは On2 の決まった言い回しに置き換え、決まった形の無い技（シャイン等）の Claude の行はそのまま
        self.assertEqual(r["moves"][0]["stepsSource"], "template")
        self.assertEqual(r["moves"][0]["steps"][0]["leader"], "2で右足を後ろへ")
        self.assertEqual(r["moves"][1]["stepsSource"], "claude")
        # もう一度かけても同じ（前回入れた既定を Claude の判断と取り違えない）。--default-onbeat で変えられる
        normalize(res, grid, duration=8.0)
        self.assertEqual(res["routine"]["timingSource"], "default")
        normalize(res, grid, duration=8.0, default_timing="on1")
        self.assertEqual(res["routine"]["timing"], "on1")

    def test_on2_partner_moves_use_template_with_hand_side_and_direction(self):
        # Claude の「手を上げる / 右回り2回」ではなく、欄の値から手・通る側・回る向きを書く
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "cbl_inside_turn", passSide="left", holdStart="LR",
                                                         turn={"by": "follower", "direction": "left", "rotations": 1.5},
                                                         steps=[{"count": "5-6-7", "leader": "頭上で回す", "follower": "左回り1回"}])]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["stepsSource"], "template")
        self.assertEqual(m["leadHand"], "L")
        self.assertEqual(m["steps"][0]["leader"], "7-1で左へ開き左手を頭上へ上げ内へ回す")
        self.assertIn("男の左側を通り", m["steps"][0]["follower"])
        self.assertIn("左回り1½回（インサイド）", m["steps"][0]["follower"])

    def test_claude_on1_is_kept(self):
        res = {"style": {"onBeat": "on1"}, "routine": {"moves": [mv(0.0, "basic")]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        self.assertEqual((res["routine"]["timing"], res["routine"]["timingSource"]), ("on1", "claude"))
        self.assertEqual(res["routine"]["moves"][0]["steps"][0]["leader"], "前へ")


class TurnKindTest(unittest.TestCase):
    """右回り = 回る人自身の右 = 上から見て時計回り。女性のターンは向きだけでインサイド（左回り）/アウトサイド（右回り）。
    つなぎ手が変わっても呼び名は変えない（Dance Dojo の流儀。on2-timing-and-terms.md §3）"""

    def t(self, d, by="follower"):
        return {"by": by, "direction": d, "rotations": 1}

    def test_direction_decides_in_every_hold(self):
        for hold in ("LR", "RR", "RL", "LL", "double", "cross", "closed", "none", None):
            self.assertEqual(turn_kind(self.t("left"), hold), "inside", hold)
            self.assertEqual(turn_kind(self.t("right"), hold), "outside", hold)

    def test_unknown_direction_or_leader_turn(self):
        self.assertIsNone(turn_kind(self.t("left", by="leader"), "LR"))
        self.assertIsNone(turn_kind(self.t(None), "LR"))

    def test_names_follow_direction(self):
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右ターン×2", holdStart="LR", turn={"by": "follower", "direction": "right", "rotations": 2}),
            mv(4.0, "left_turn", name="左ターン", holdStart="RL", turn={"by": "follower", "direction": "left", "rotations": 1}),
            mv(8.0, "right_turn", name="右ターン", turn={"by": "follower", "direction": "right", "rotations": 1}),
            mv(12.0, "cbl_outside_turn", name="CBL＋アウトサイド", holdStart="LL",
               turn={"by": "follower", "direction": "left", "rotations": 1.5}),
            mv(16.0, "leader_turn", name="男性ターン", turn={"by": "leader", "direction": "left", "rotations": 1}),
        ]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=20.0)
        ms = res["routine"]["moves"]
        self.assertEqual([m["name"] for m in ms],
                         ["右回りターン×2", "左回りターン", "右回りターン", "CBL＋インサイド×1½", "男 左回り"])
        # 女性の左手（RL・LL）でも左回りはインサイド（以前は手で逆にしていた）
        self.assertEqual(ms[1]["turn"]["kind"], "inside")
        self.assertEqual(ms[3]["move"], "cbl_inside_turn")     # 向きで決まる方に合わせる
        self.assertEqual(ms[3]["turn"]["kind"], "inside")
        self.assertEqual(ms[2]["turn"]["kind"], "outside")     # 手が分からなくても向きで決まる
        # 本文は左回り/右回りが先、インサイド/アウトサイドは後ろに添える
        self.assertIn("右回り1回（アウトサイド）", ms[2]["steps"][0]["follower"])
        self.assertIn("左回り1½回（インサイド）", ms[3]["steps"][0]["follower"])


class RotationPriorTest(unittest.TestCase):
    """回転数の事前分布: CBL ½・CBL＋ターン 1½（2½）・その場 1（2）。強い証拠が無ければ最寄りへ寄せる"""

    def row(self, move, r, **kw):
        return {"move": move, "turn": {"by": "follower", "direction": "left", "rotations": r}, **kw}

    def test_cbl_turn_snaps_to_one_and_a_half(self):
        m = self.row("cbl_inside_turn", 1.0, evidence="seen", confidence=0.4)
        self.assertEqual(apply_rotation_prior(m, None, 0.32), "rotations:1.0->1.5(prior)")
        self.assertEqual(m["turn"]["rotations"], 1.5)
        self.assertEqual(m["turn"]["claudeRotations"], 1.0)
        m2 = self.row("cbl_inside_turn", 2.0)
        apply_rotation_prior(m2, None, 0.32)
        self.assertEqual(m2["turn"]["rotations"], 1.5)        # 1½ と 2½ の真ん中は普通の方（1½）
        m3 = self.row("cbl_inside_turn", 3.0, evidence="seen", confidence=0.5)
        apply_rotation_prior(m3, None, 0.32)
        self.assertEqual(m3["turn"]["rotations"], 2.5)

    def test_in_place_turn_prior(self):
        m = self.row("left_turn", 1.5)
        apply_rotation_prior(m, None, 0.32)
        self.assertEqual(m["turn"]["rotations"], 1.0)
        m2 = self.row("right_turn", 2.0)
        self.assertIsNone(apply_rotation_prior(m2, None, 0.32))   # ダブルは普通の回数

    def test_strong_evidence_keeps_value(self):
        # 画像で見えて自信が高い
        m = self.row("cbl_inside_turn", 1.0, evidence="seen", confidence=0.8)
        self.assertIsNone(apply_rotation_prior(m, None, 0.32))
        # CV が同じ向きで同じ回数を数えた（1 回で止める = チェック・ラップの入り）
        m2 = self.row("cbl_inside_turn", 1.0)
        self.assertIsNone(apply_rotation_prior(m2, {"dir": "left", "turns": 1.0, "dur": 0.7}, 0.32))
        # CV が逆向き・向きの混ざった回転なら証拠にしない
        m3 = self.row("cbl_inside_turn", 1.0)
        apply_rotation_prior(m3, {"dir": None, "turns": None, "dur": 2.7}, 0.32)
        self.assertEqual(m3["turn"]["rotations"], 1.5)

    def test_never_more_rotations_than_beats(self):
        # 1 回転に最低 1 拍。使える拍は 4（CV の回転区間が長ければその拍数）
        m = self.row("right_turn", 6.0, evidence="seen", confidence=0.9)
        self.assertEqual(apply_rotation_prior(m, None, 0.32), "rotations:6.0->4.0(beats)")
        m2 = self.row("right_turn", 6.0, evidence="seen", confidence=0.9)
        apply_rotation_prior(m2, {"dir": "left", "turns": 6.0, "dur": 0.32 * 5}, 0.32)
        self.assertEqual(m2["turn"]["rotations"], 5.0)

    def test_leader_turn_and_unknown_moves_untouched(self):
        self.assertIsNone(apply_rotation_prior({"move": "wrap", "turn": {"by": "follower", "rotations": 0.5}}, None, 0.32))
        self.assertIsNone(apply_rotation_prior({"move": "cbl", "turn": None}, None, 0.32))

    def test_card2_of_581ef6a2(self):
        # 581ef6a2 の 0:01.76: Claude「右回り2回」→ CV の向き（左）で直して CV の回数 1 → CBL＋インサイドなら 1½。
        # CV の spin は「左 1 → 右 3」と向きが混ざっていて回数の証拠にならない
        spin = {"t": 3.96, "type": "Turn", "by": "follower",
                "spin": {"from": 3.57, "to": 6.3, "runs": [{"dir": "left", "turns": 1.0}, {"dir": "right", "turns": 3.0}]}}
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "cbl_inside_turn", name="CBL＋インサイド", passSide="left", confidence=0.4, evidence="seen",
               turn={"by": "follower", "direction": "right", "rotations": 2})]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.32, "firstBeatSec": 0.0}, "events": [
            {**spin, "t": 1.0, "spin": {**spin["spin"], "from": 0.9, "to": 2.5}}]}, duration=2.56)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["turn"]["direction"], "left")
        self.assertEqual(m["turn"]["rotations"], 1.5)
        self.assertEqual(m["turn"]["rotationSource"], "prior")
        self.assertEqual(m["name"], "CBL＋インサイド×1½?")
        self.assertEqual(res["routine"]["rotationChecks"], 1)


class TempoRangeTest(unittest.TestCase):
    def test_half_tempo_is_doubled_and_range_clamped(self):
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 95), 8 * 60 / 190)    # 95 BPM → 190
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 186), 8 * 60 / 186)   # そのまま
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 300), 8 * 60 / 250)   # 速すぎ → 250
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 140), 8 * 60 / 150)   # 遅すぎ → 150
        self.assertIsNone(salsa_unit8(None))


def _tracks(sides_by_t, leader_pid=1):
    """女性の側（"left"/"right"）の時系列 → tracks.json の frames（pid 0/1 の腰の X）"""
    frames = []
    for t, side in sides_by_t:
        fx, lx = (0.7, 0.3) if side == "right" else (0.3, 0.7)
        frames.append({"t": t, "kept": [{"pid": leader_pid, "hipX": lx}, {"pid": 1 - leader_pid, "hipX": fx}]})
    return {"leaderPid": leader_pid, "frames": frames}


class PairSidesTest(unittest.TestCase):
    def test_runs_and_crossing_skip_single_frame_flip(self):
        series = [(0.0, "left"), (0.1, "left"), (0.2, "right"), (0.3, "left"), (0.4, "left"),
                  (1.0, "right"), (1.1, "right"), (1.2, "right")]
        runs = pair_sides.settled_runs(series)
        self.assertEqual([r["side"] for r in runs], ["left", "right"])
        cs = pair_sides.crossings(runs)
        self.assertEqual(len(cs), 1)
        self.assertAlmostEqual(cs[0]["t"], 0.7)
        self.assertEqual((cs[0]["from"], cs[0]["to"]), ("left", "right"))
        self.assertEqual(pair_sides.side_before(runs, 0.6), "left")
        self.assertEqual(pair_sides.side_after(runs, 0.6), "right")

    def test_follower_series_uses_leader_pid(self):
        tr = _tracks([(0.0, "right")], leader_pid=0)
        self.assertEqual(pair_sides.follower_series(tr), [(0.0, "right")])


class PassCheckTest(unittest.TestCase):
    """CV の立ち位置で、パスの無い技なのに左右が入れ替わった行を CBL 系に付け替える（0:01.76「右ターン×2」）"""
    GRID = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}

    def summary(self, cbl_ts, turns=()):
        ev = [{"t": t, "type": "CBL", "by": "pair", "pass": {"side": "left"},
               "handRaise": {"raised": True, "hand": "L"}} for t in cbl_ts]
        ev += list(turns)
        return {**self.GRID, "events": ev}

    def test_in_place_turn_with_swap_becomes_cbl_turn(self):
        # 0〜4 秒: 女は右 → 2.5 秒で左へ。4〜8 秒: 左のまま
        tracks = _tracks([(t / 10, "right") for t in range(0, 22)] + [(t / 10, "left") for t in range(28, 80)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右ターン×2?", turn={"by": "follower", "direction": "right", "rotations": 2}),
            mv(4.0, "basic", name="ベーシック"),
        ]}}
        normalize(res, self.summary([2.8]), duration=8.0, tracks=tracks)
        a, b = res["routine"]["moves"]
        self.assertEqual(a["sides"]["followerStart"], "right")
        self.assertEqual(a["sides"]["followerEnd"], "left")
        self.assertEqual(a["sides"]["swapAt"], [2.45])   # 隠れていた 2.1〜2.8 秒の中点
        self.assertEqual(a["move"], "cbl_outside_turn")
        self.assertEqual(a["passSide"], "left")
        self.assertEqual(a["leadHand"], "L")                   # CV が見た頭上の手
        self.assertTrue(a["passCheck"].startswith("swapButNoPass"))
        self.assertTrue(a["name"].endswith("?"))
        self.assertEqual(b["move"], "basic")
        self.assertNotIn("passCheck", b)
        self.assertEqual(res["routine"]["passChecks"], 1)

    def test_swap_without_cv_event_is_not_trusted(self):
        # 密着中の腰の重なり（CV の CBL イベントが無い）では付け替えない
        tracks = _tracks([(t / 10, "right") for t in range(0, 22)] + [(t / 10, "left") for t in range(28, 40)])
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "basic", name="ベーシック")]}}
        normalize(res, self.summary([]), duration=4.0, tracks=tracks)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["move"], "basic")
        self.assertEqual(m["sides"]["swapAt"], [])

    def test_cbl_without_swap_gets_question_mark_only(self):
        tracks = _tracks([(t / 10, "left") for t in range(0, 40)])
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "cbl", name="CBL", confidence=0.9)]}}
        normalize(res, self.summary([]), duration=4.0, tracks=tracks)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["move"], "cbl")
        self.assertEqual(m["name"], "CBL?")
        self.assertLessEqual(m["confidence"], 0.35)

    def test_inside_turn_takes_unclaimed_nearby_swap(self):
        # インサイドターンは CBL と組む: 前の行（シャイン）の終わりの入れ替わりは、この行の CBL＋インサイドのもの
        tracks = _tracks([(t / 10, "right") for t in range(0, 34)] + [(t / 10, "left") for t in range(38, 120)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "shine", name="シャイン"),
            mv(4.0, "left_turn", name="左ターン", holdStart="LR", turn={"by": "follower", "direction": "left", "rotations": 1}),
            mv(8.0, "basic", name="ベーシック"),
        ]}}
        normalize(res, self.summary([3.7]), duration=12.0, tracks=tracks)
        a, b, c = res["routine"]["moves"]
        self.assertEqual(a["sides"]["swapAt"], [3.55])
        self.assertEqual(b["move"], "cbl_inside_turn")
        self.assertEqual(b["name"], "CBL＋インサイド×1½?")   # 回転 1 は CBL＋ターンの普通の 1½ に寄せる
        self.assertEqual(b["turn"]["rotations"], 1.5)
        self.assertTrue(b["passCheck"].startswith("turnNearSwap"))

    def test_right_turn_takes_unclaimed_nearby_swap_as_cbl_outside(self):
        # 右回りも同じ（女の手に関係なく右回り = アウトサイド）
        tracks = _tracks([(t / 10, "right") for t in range(0, 34)] + [(t / 10, "left") for t in range(38, 120)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "shine", name="シャイン"),
            mv(4.0, "right_turn", name="右ターン", holdStart="RL", turn={"by": "follower", "direction": "right", "rotations": 1}),
            mv(8.0, "basic", name="ベーシック"),
        ]}}
        normalize(res, self.summary([3.7]), duration=12.0, tracks=tracks)
        b = res["routine"]["moves"][1]
        self.assertEqual(b["move"], "cbl_outside_turn")
        self.assertEqual(b["name"], "CBL＋アウトサイド×1½?")
        self.assertTrue(b["passCheck"].startswith("turnNearSwap:right_turn->cbl_outside_turn"))

    def test_left_turn_without_swap_stays_in_place_left_turn(self):
        # 入れ替わりの無い左回転は普通の「左回りターン」（on2-timing-and-terms.md §8-7）。「?」は付けない
        tracks = _tracks([(t / 10, "left") for t in range(0, 80)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "cbl", name="CBL"),
            mv(4.0, "left_turn", name="左ターン", holdStart="LR", turn={"by": "follower", "direction": "left", "rotations": 1}),
        ]}}
        normalize(res, self.summary([]), duration=8.0, tracks=tracks)
        b = res["routine"]["moves"][1]
        self.assertEqual(b["move"], "left_turn")
        self.assertEqual(b["name"], "左回りターン")
        self.assertEqual(b["turn"]["kind"], "inside")
        self.assertNotIn("passCheck", b)

    def test_no_tracks_no_sides(self):
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "basic")]}}
        normalize(res, self.summary([2.0]), duration=4.0)
        self.assertNotIn("sides", res["routine"]["moves"][0])

    def test_direction_follows_cv_spin_when_claude_disagrees(self):
        spin = {"t": 1.5, "type": "Turn", "by": "follower",
                "spin": {"from": 1.2, "to": 2.0, "runs": [{"dir": "left", "turns": 1.0}, {"dir": "right", "turns": 3.0}]}}
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右ターン×2", holdStart="LR", turn={"by": "follower", "direction": "right", "rotations": 2})]}}
        normalize(res, self.summary([], [spin]), duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["turn"]["direction"], "left")
        self.assertEqual(m["turn"]["claudeDirection"], "right")
        self.assertEqual(m["turn"]["rotations"], 1.0)
        self.assertEqual(m["turn"]["kind"], "inside")
        self.assertEqual(m["move"], "left_turn")                # 技の種類も向きに合わせる
        self.assertEqual(m["name"], "左回りターン?")
        self.assertIn("2から左回り1回（インサイド）", m["steps"][0]["follower"])
        self.assertEqual(res["routine"]["directionChecks"], 1)


class InferHoldTest(unittest.TestCase):
    """手が分からない女性のターンは、男が頭上に上げた手（CV）から普通のつなぎを推す（0:01.76「CBL＋女左回り?」）"""
    GRID = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}

    def run_one(self, direction, hand, hold=None, cv_hold=None, timeline=None):
        ev = [{"t": 2.0, "type": "CBL", "by": "pair", "hold": cv_hold, "handRaise": {"raised": True, "hand": hand}}]
        summary = {**self.GRID, "events": ev, "holdTimeline": timeline or []}
        move = "left_turn" if direction == "left" else "right_turn"
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, move, name="ターン", holdStart=hold, holdEnd=hold,
               turn={"by": "follower", "direction": direction, "rotations": 1})]}}
        normalize(res, summary, duration=4.0)
        return res["routine"]["moves"][0]

    def test_left_hand_raised_means_her_right_hand(self):
        m = self.run_one("left", "L")
        self.assertEqual(m["inferredHold"], "LR")
        self.assertEqual(m["holdSource"], "inferred")
        self.assertEqual(m["turn"]["kind"], "inside")
        self.assertEqual(m["name"], "左回りターン")           # 推しただけでは「?」を付けない
        self.assertIsNone(m["holdStart"])                    # 見えたつなぎの欄は書き換えない
        self.assertEqual(m["leadHand"], "L")
        self.assertEqual(self.run_one("right", "L")["turn"]["kind"], "outside")

    def test_right_hand_raised_gives_her_left_hand_but_same_kind(self):
        # 女の左手でつないでも、インサイド/アウトサイドは向きだけで決まる（以前は逆にしていた）
        m = self.run_one("left", "R")
        self.assertEqual(m["inferredHold"], "RL")
        self.assertEqual(m["leadHand"], "R")
        self.assertEqual(m["turn"]["kind"], "inside")
        self.assertEqual(self.run_one("right", "R")["turn"]["kind"], "outside")

    def test_no_inference_when_data_shows_cross_or_same_side_hold(self):
        for kw in ({"hold": "cross"}, {"hold": "none"}, {"cv_hold": "リーダー右手×フォロワー右手"},
                   {"timeline": [{"from": 1.0, "to": 1.5, "hold": "リーダー左手×フォロワー左手"}]}):
            m = self.run_one("left", "L", **kw)
            self.assertNotIn("inferredHold", m, kw)
            self.assertEqual(m["turn"]["kind"], "inside", kw)

    def test_seen_hold_wins(self):
        m = self.run_one("left", "L", hold="RL")   # 見えたつなぎ（女の左手）が優先。上げた手からは推さない
        self.assertNotIn("inferredHold", m)
        self.assertEqual(m["leadHand"], "R")
        self.assertEqual(m["turn"]["kind"], "inside")


if __name__ == "__main__":
    unittest.main()
