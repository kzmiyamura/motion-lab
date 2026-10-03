"""
normalize_routine.py（振付シート用の routine の後処理）の単体テスト。

「これじゃ踊れんわ」— 1 秒おきの 1-8、4 秒の 1-16、3 回転・4½ 回転、長い説明文の技名、
「どう動くか」が無いカード、を直すための決定的な処理を確かめる。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from normalize_routine import (  # noqa: E402
    NAME_MAX, clean_turn, fit_grid, normalize, short_name, template_steps,
)


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
