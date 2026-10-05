"""
analyze_pair.apply_cbl_pass_half（CBL に続けて回る女性のターンへ通過の½回転を足す）の単体テスト。
実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402


def cbl(t_cross):
    return {"t": t_cross - 0.1, "tCross": t_cross, "type": "CBL", "by": "pair"}


def turn(start, by="follower", rotations=1, runs=None):
    e = {"t": start, "type": "Turn", "by": by, "rotations": rotations,
         "span": {"from": start, "to": start + 1.0, "source": "flips10fps"},
         "spin": {"runs": runs if runs is not None else [{"dir": "left", "turns": float(rotations)}]}}
    return e


class CblPassHalfTest(unittest.TestCase):
    def test_adds_half_when_turn_starts_one_beat_after_cbl(self):
        ev = ap.apply_cbl_pass_half([cbl(10.0), turn(10.5)])
        t = ev[1]
        self.assertEqual(t["rotations"], 1.5)
        self.assertEqual(t["spin"]["runs"][0]["turns"], 1.5)
        self.assertEqual(t["passHalf"], 0.5)

    def test_only_first_run_and_only_once(self):
        runs = [{"dir": "right", "turns": 1.5}, {"dir": "left", "turns": 1.0}]
        ev = [cbl(10.0), turn(10.4, rotations=2, runs=runs)]
        ap.apply_cbl_pass_half(ev)
        ap.apply_cbl_pass_half(ev)
        self.assertEqual(ev[1]["rotations"], 2.5)
        self.assertEqual([r["turns"] for r in ev[1]["spin"]["runs"]], [2.0, 1.0])

    def test_no_change_when_pass_is_inside_span_or_far_away(self):
        for start in (10.1, 9.8, 10.9, 14.0):
            ev = ap.apply_cbl_pass_half([cbl(10.0), turn(start)])
            self.assertEqual(ev[1]["rotations"], 1, start)
            self.assertNotIn("passHalf", ev[1])

    def test_leader_turn_is_untouched(self):
        ev = ap.apply_cbl_pass_half([cbl(10.0), turn(10.5, by="leader")])
        self.assertEqual(ev[1]["rotations"], 1)

    def test_spin_from_seq_without_runs(self):
        e = turn(10.5)
        e["spin"] = {"seq": "LL"}
        ap.apply_cbl_pass_half([cbl(10.0), e])
        self.assertEqual(e["spin"]["runs"][0]["turns"], 1.5)


if __name__ == "__main__":
    unittest.main()
