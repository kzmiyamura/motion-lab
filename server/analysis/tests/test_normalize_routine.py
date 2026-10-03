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

from normalize_routine import (  # noqa: E402
    NAME_MAX, clean_turn, fit_grid, fit_grid_to_swaps, grid_cycles, normalize, short_name, swap_heads,
    template_steps,
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


def swaps_on_grid(period, head, n, beat_pos=7.0, jitter=(0.0,), skip=(), drift=0.0, span=None):
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
        # 入れ替わりは 7 拍目付近（±0.3 秒）で、ところどころ抜けている
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
        # 終わりの方でも入れ替わりが 7 拍目付近に来る
        heads = swap_heads(fit, 156.0)
        for s in sw[-10:]:
            h = max(x for x in heads if x <= s - 2 * 2.6 / 8)
            beat = (s - h) / (2.6 / 8)
            self.assertAlmostEqual(beat, 7.0, delta=1.0)

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
        # 入れ替わりは各 8 カウントの 7 拍目付近 = 頭は入れ替わりの 7 拍前
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
        self.assertIn("左回り1½回転", s[1]["follower"])

    def test_claude_steps_preferred_and_trimmed(self):
        res = {"routine": {"moves": [mv(0.0, "cbl", steps=[
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
        res = {"routine": {"moves": [mv(0.0, "basic")]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["stepsSource"], "template")
        self.assertEqual(m["steps"][0], {"count": "1-2-3", "leader": "前へ", "follower": "後ろへ"})

    def test_on2_puts_follower_move_on_1(self):
        s = template_steps({"move": "right_turn", "turn": {"by": "follower", "direction": "right", "rotations": 1}}, "on2")
        self.assertEqual(s[0]["count"], "1-2-3")
        self.assertIn("右回り", s[0]["follower"])


if __name__ == "__main__":
    unittest.main()
