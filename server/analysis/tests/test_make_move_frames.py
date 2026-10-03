"""
make_move_frames.py の技の区間（move_windows / beat_interval / frame_times）の単体テスト。

振付シートの1行 = 1技に、その技の頭から次の技の頭までの写真が付くことを確かめる。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from make_move_frames import (  # noqa: E402
    DEFAULT_BEAT_SEC, MAX_SPAN_SEC, MIN_SPAN_SEC, beat_interval, frame_times, move_windows,
)


class BeatIntervalTest(unittest.TestCase):
    def test_routine_bpm_first(self):
        self.assertAlmostEqual(beat_interval({"bpm": 96}, {"beatGrid": {"beatIntervalSec": 0.3}}), 0.625)

    def test_beat_grid_fallback(self):
        self.assertAlmostEqual(beat_interval({"bpm": None}, {"beatGrid": {"beatIntervalSec": 0.33}}), 0.33)
        self.assertAlmostEqual(beat_interval({}, {"beatGrid": {"bpm": 120}}), 0.5)

    def test_default_when_unknown(self):
        self.assertAlmostEqual(beat_interval({"bpm": 0}, {"beatGrid": None}), DEFAULT_BEAT_SEC)
        self.assertAlmostEqual(beat_interval(None, None), DEFAULT_BEAT_SEC)


class MoveWindowsTest(unittest.TestCase):
    def test_gap_free_routine_uses_next_start(self):
        moves = [{"start": 0.0, "counts": 8}, {"start": 2.5, "counts": 8}, {"start": 5.0, "counts": 16}]
        w = move_windows(moves, 0.5)
        self.assertEqual(w[0], (0.0, 2.5))
        self.assertEqual(w[1], (2.5, 5.0))
        # 最後の技は counts × 拍間隔
        self.assertEqual(w[2], (5.0, 13.0))

    def test_last_move_clamped_to_duration_and_max(self):
        w = move_windows([{"start": 10.0, "counts": 64}], 0.5, duration=30.0)
        self.assertEqual(w[0], (10.0, 10.0 + MAX_SPAN_SEC))
        w = move_windows([{"start": 10.0, "counts": 8}], 0.5, duration=12.0)
        self.assertEqual(w[0], (10.0, 12.0))

    def test_min_span_when_next_is_too_close(self):
        w = move_windows([{"start": 3.0}, {"start": 3.2}], 0.5)
        self.assertEqual(w[0], (3.0, 3.0 + MIN_SPAN_SEC))

    def test_missing_or_out_of_range_start(self):
        moves = [{"counts": 8}, {"start": 4.0}, {"start": 50.0}]
        w = move_windows(moves, 0.5, duration=20.0)
        self.assertIsNone(w[0])
        self.assertEqual(w[1], (4.0, 8.0))  # counts 省略 → 8拍
        self.assertIsNone(w[2])

    def test_unordered_start_skips_to_next_later_move(self):
        moves = [{"start": 5.0}, {"start": 4.0}, {"start": 7.0}]
        w = move_windows(moves, 0.5)
        self.assertEqual(w[0], (5.0, 7.0))


class FrameTimesTest(unittest.TestCase):
    def test_five_frames_for_one_eight(self):
        t = frame_times(0.0, 2.05, 8)
        self.assertEqual(len(t), 5)
        self.assertAlmostEqual(t[0], 0.0)
        self.assertAlmostEqual(t[-1], 2.0)

    def test_six_frames_for_longer_moves(self):
        self.assertEqual(len(frame_times(0.0, 6.0, 16)), 6)


if __name__ == "__main__":
    unittest.main()
