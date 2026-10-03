"""
refine_events.py の純粋な部分（窓の計画・通過の時刻・体の向きの角度）の単体テスト。YOLO は回さない。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from refine_events import (  # noqa: E402
    heading_series, heading_summary, last_old_before, merge_intervals, old_sign_at, pick_indices, plan_windows,
    refine_crossing,
)


class CrossingTest(unittest.TestCase):
    def test_midpoint_of_hidden_gap(self):
        # 10fps では 1.0 秒に入れ替わりを確定したが、密に見ると 0.60 秒まで前の側、0.80 秒から新しい側
        dense = [(0.50, 0.10), (0.55, 0.08), (0.60, 0.05), (0.80, -0.06), (0.85, -0.09), (1.0, -0.12)]
        r = refine_crossing(dense, 1.0, +1)
        self.assertAlmostEqual(r["t"], 0.70, places=2)
        self.assertEqual(r["basis"], "dense")
        self.assertAlmostEqual(r["gap"], 0.20, places=2)

    def test_overlapping_frames_are_not_read(self):
        # 腰がほぼ重なったコマ（|dx| < MIN_DX）は側を読まない
        dense = [(0.5, 0.10), (0.6, 0.005), (0.7, -0.004), (0.8, -0.1)]
        self.assertAlmostEqual(refine_crossing(dense, 0.8, +1)["t"], 0.65, places=2)

    def test_falls_back_to_coarse_old_side(self):
        dense = [(0.9, -0.1), (1.0, -0.12)]
        r = refine_crossing(dense, 1.0, +1, last_old_coarse=0.4)
        self.assertAlmostEqual(r["t"], 0.65, places=2)
        self.assertEqual(r["basis"], "coarseOld")

    def test_no_new_side_keeps_coarse(self):
        self.assertIsNone(refine_crossing([(0.5, 0.1), (0.9, 0.1)], 1.0, +1))
        self.assertIsNone(refine_crossing([(0.5, 0.1)], 1.0, None))

    def test_coarse_helpers(self):
        series = [(0.0, 0.2), (0.1, 0.15), (0.2, 0.01), (0.3, -0.1)]
        self.assertEqual(old_sign_at(series, 0.3), 1)
        self.assertAlmostEqual(last_old_before(series, 0.3, 1), 0.1)


class WindowTest(unittest.TestCase):
    def test_cbl_window_starts_at_last_old_frame_and_turns_follow(self):
        series = [(t / 10, 0.2) for t in range(0, 50)] + [(5.0, -0.2), (5.1, -0.2)]
        events = [
            {"t": 8.0, "type": "Turn", "by": "follower", "spin": {"from": 7.8, "to": 9.0}},
            {"t": 5.0, "type": "CBL", "by": "pair"},
            {"t": 9.5, "type": "Turn", "by": "pair"},          # 誰のターンか分からないものは取り直さない
        ]
        wins = plan_windows(events, series)
        self.assertEqual([w[0] for w in wins], ["cbl", "turn"])
        kind, i, w0, w1, extra = wins[0]
        self.assertEqual(i, 1)
        self.assertAlmostEqual(w0, 4.9 - 0.15)
        self.assertAlmostEqual(w1, 5.4)
        self.assertEqual(extra["oldSign"], 1)
        self.assertAlmostEqual(wins[1][2], 7.4)
        self.assertAlmostEqual(wins[1][3], 9.4)

    def test_rerun_uses_original_time(self):
        series = [(t / 10, 0.2) for t in range(0, 50)] + [(5.0, -0.2)]
        wins = plan_windows([{"t": 4.6, "tCoarse": 5.0, "type": "CBL"}], series)
        self.assertEqual(wins[0][4]["t"], 5.0)

    def test_merge_and_pick(self):
        self.assertEqual(merge_intervals([("cbl", 0, 1.0, 2.0, {}), ("turn", 1, 1.5, 3.0, {}), ("cbl", 2, 4.0, 5.0, {})]),
                         [[1.0, 3.0], [4.0, 5.0]])
        idx = pick_indices(40.0, 27.0, 1.0, 2.0)
        self.assertTrue(26 <= len(idx) <= 28)
        self.assertEqual(pick_indices(25.0, 27.0, 0.0, 0.2), [0, 1, 2, 3, 4, 5])


class HeadingTest(unittest.TestCase):
    @staticmethod
    def spin(deg_per_step, steps, face_known=True):
        """右回り（角度が増える）に回る人の (t, shDx, face)。face は顔が画面右なら +1"""
        import math
        out = []
        for k in range(steps):
            phi = math.radians(k * deg_per_step)
            c, s = math.cos(phi), math.sin(phi)
            face = 0
            if face_known and c > -0.3:      # 背中側では顔が見えない
                face = -1 if s > 0.05 else (1 if s < -0.05 else 0)
            out.append((k * 0.037, 0.08 * c, face))
        return out

    def test_right_double_turn(self):
        h = heading_summary(heading_series(self.spin(25, 30), 0.08))
        self.assertEqual(h["dir"], "right")
        self.assertEqual(h["turns"], 2.0)
        self.assertGreater(h["netDeg"], 650)

    def test_left_turn_is_negative(self):
        samples = [(t, dx, -f) for t, dx, f in self.spin(25, 16)]
        h = heading_summary(heading_series(samples, 0.08))
        self.assertEqual(h["dir"], "left")
        self.assertEqual(h["turns"], 1.0)

    def test_still_person_has_no_turn(self):
        samples = [(k * 0.04, 0.08, 0) for k in range(20)]
        h = heading_summary(heading_series(samples, 0.08))
        self.assertEqual(h["turns"], 0)
        self.assertIsNone(h["dir"])


if __name__ == "__main__":
    unittest.main()
