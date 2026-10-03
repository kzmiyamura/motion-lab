"""
turn_judge.py の区間の選び方・向きの記号の読み方・書き戻し（merge）の単体テスト。

実行: python -m pytest server/analysis/tests/test_turn_judge.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from turn_judge import (  # noqa: E402
    MAX_FRAMES, MAX_EVENTS, STEP_SEC, densest_cluster, direction_from_facing, merge, parse_facing, select_events,
    turn_window,
)


def _frames(pid, signs, t0=0.0, step=0.1):
    """pid の shDx の符号の並びから tracks のコマを作る"""
    return [{"t": round(t0 + i * step, 2), "kept": [{"pid": pid, "shDx": 0.05 * s, "bbox": [0.4, 0.2, 0.6, 0.9]}]}
            for i, s in enumerate(signs)]


class FacingTest(unittest.TestCase):
    def test_right_turn_sequence(self):
        # 本人の右回り（上から見て時計回り）: 正面 → 鼻が画面左 → 背中 → 鼻が画面右 → 正面
        self.assertEqual(direction_from_facing("F L B R F"), ("right", 4))

    def test_left_turn_sequence(self):
        self.assertEqual(direction_from_facing("F>R>B>L>F"), ("left", 4))

    def test_repeats_and_unknown_are_ignored(self):
        self.assertEqual(parse_facing("F F ? L L B"), ["F", "?", "L", "B"])
        self.assertEqual(direction_from_facing("F F ? L L B")[0], "right")

    def test_jump_of_180_does_not_decide(self):
        self.assertEqual(direction_from_facing("F B F B"), (None, 0))

    def test_back_and_forth_is_undecided(self):
        # 半回転して同じ側から戻る（F→L→B→L→F）は右 2・左 2 で決めない
        self.assertEqual(direction_from_facing("F L B L F"), (None, 0))


class WindowTest(unittest.TestCase):
    def test_default_window_starts_before_event(self):
        frames = _frames(1, [1] * 40)
        lo, hi, step, n = turn_window(frames, 1, 2.0)
        self.assertEqual((lo, step, n), (1.4, STEP_SEC, MAX_FRAMES))
        self.assertAlmostEqual(hi - lo, (MAX_FRAMES - 1) * STEP_SEC)

    def test_shifts_to_late_flip_cluster(self):
        # 検出時刻 1.0 の後、2.1〜2.4 秒に反転がかたまる（本当に回っている所）→ そこを中心に取り直す
        signs = [1] * 21 + [-1, 1, -1, 1] + [1] * 15
        lo, hi, _, _ = turn_window(_frames(1, signs), 1, 1.0)
        self.assertLessEqual(lo, 2.1)
        self.assertGreaterEqual(hi, 2.4)
        self.assertGreater(lo, 0.4)

    def test_cbl_window_is_centered_on_crossing(self):
        lo, _, _, n = turn_window(_frames(1, [1, -1, 1, -1] * 10), 1, 2.0, kind="cbl")
        self.assertEqual((lo, n), (1.4, MAX_FRAMES))

    def test_dense_spin_from_full_frames_is_used(self):
        lo, hi, _, _ = turn_window([], 1, 5.0, spin={"from": 6.0, "to": 6.6})
        self.assertAlmostEqual((lo + hi) / 2, 6.3, places=2)

    def test_densest_cluster(self):
        self.assertEqual(densest_cluster([1.0, 2.0, 2.2, 2.4, 4.0]), (3, 2.2))
        self.assertEqual(densest_cluster([]), (0, None))


class SelectTest(unittest.TestCase):
    def test_turns_and_raised_cbl_without_nearby_turn(self):
        events = [
            {"t": 1.0, "type": "CBL", "handRaise": {"raised": True}},        # 近くに女性のターン → 聞かない
            {"t": 1.5, "type": "Turn", "by": "follower"},
            {"t": 5.0, "type": "CBL", "handRaise": {"raised": True}},        # 聞く
            {"t": 8.0, "type": "CBL", "handRaise": {"raised": False}},       # 手が上がっていない → 聞かない
            {"t": 9.0, "type": "Turn", "by": "leader"},
        ]
        got = select_events(events, leader_pid=0)
        self.assertEqual(got, [(1, "turn", "follower", 1), (2, "cbl", "follower", 1), (4, "turn", "leader", 0)])

    def test_unknown_leader_asks_nothing(self):
        self.assertEqual(select_events([{"t": 1, "type": "Turn", "by": "unknown"}], None), [])

    def test_cap(self):
        events = [{"t": float(i), "type": "Turn", "by": "follower"} for i in range(MAX_EVENTS + 6)]
        self.assertEqual(len(select_events(events, 0)), MAX_EVENTS)


class MergeTest(unittest.TestCase):
    def _meas(self):
        return {"summary": {"events": [
            {"t": 1.0, "type": "Turn", "by": "follower", "rotations": 1,
             "spin": {"seq": "LL", "runs": [{"dir": "left", "turns": 1.0}]}},
            {"t": 4.0, "type": "Turn", "by": "follower", "rotations": 2,
             "spin": {"seq": "LLLL", "runs": [{"dir": "left", "turns": 2.0}]}},
            {"t": 7.0, "type": "CBL", "by": "pair"},
        ]}}

    LISTING = [{"id": "e01", "index": 0, "kind": "turn"}, {"id": "e02", "index": 1, "kind": "turn"},
               {"id": "e03", "index": 2, "kind": "cbl"}]

    def test_medium_or_better_overrides_and_keeps_cv(self):
        m = self._meas()
        tally = merge(m, self.LISTING, {"events": [
            {"id": "e01", "turner": "follower", "direction": "right", "rotations": 1.5, "confidence": "high",
             "facing": "F L B R F L B"},
            {"id": "e02", "turner": "follower", "direction": "right", "rotations": 1, "confidence": "low"},
            {"id": "e03", "turner": "follower", "direction": "left", "rotations": 1.5, "confidence": "medium"},
        ]})
        e1, e2, e3 = m["summary"]["events"]
        self.assertEqual(e1["spin"]["runs"], [{"dir": "right", "turns": 1.5}])
        self.assertEqual(e1["spin"]["runsCV"], [{"dir": "left", "turns": 1.0}])
        self.assertEqual((e1["dirCV"], e1["dirSource"], e1["rotations"], e1["rotationsCV"]), ("left", "claude", 1.5, 1))
        # low は CV のまま「?」
        self.assertEqual((e2["spin"]["runs"][0]["dir"], e2["dirSource"], e2["rotations"]), ("left", "cv?", 2))
        # CBL は記録だけ
        self.assertEqual(e3["turnJudge"]["direction"], "left")
        self.assertNotIn("dirSource", e3)
        self.assertEqual((tally["claude"], tally["cvUnsure"], tally["changedDir"]), (1, 1, 1))
        self.assertEqual(m["summary"]["turnJudge"], tally)

    def test_facing_contradiction_downgrades_to_low(self):
        m = self._meas()
        tally = merge(m, self.LISTING[:1], {"events": [
            {"id": "e01", "turner": "follower", "direction": "right", "rotations": 1, "confidence": "high",
             "facing": "F R B L F"},
        ]})
        e1 = m["summary"]["events"][0]
        self.assertEqual((e1["dirSource"], e1["turnJudge"]["confidence"], tally["seqConflict"]), ("cv?", "low", 1))

    def test_other_turner_or_missing_answer_keeps_cv(self):
        m = self._meas()
        merge(m, self.LISTING[:2], {"events": [
            {"id": "e01", "turner": "leader", "direction": "right", "rotations": 1, "confidence": "high"},
        ]})
        e1, e2 = m["summary"]["events"][:2]
        self.assertEqual((e1["dirSource"], e1["spin"]["runs"][0]["dir"]), ("cv?", "left"))
        self.assertEqual(e2["dirSource"], "cv?")
        self.assertNotIn("turnJudge", e2)


if __name__ == "__main__":
    unittest.main()
