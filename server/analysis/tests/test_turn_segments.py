"""
README 35 の単体テスト（YOLO は回さない）: 反転の連なり（セグメント）への区切り。
- segment_flips / cbl_half_segments: 純粋な関数
- TURN_SEGMENTS: CBL の半回転が冷却を張らず、2.5 秒以内に続く本物のターンを塞がない（False なら従来どおり塞ぐ）

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402
from test_turn_fp import BACK, FRONT, follower_turns, pair_frames  # noqa: E402


class SegmentFlipsTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(ap.segment_flips([], 1.0), [])

    def test_split_on_gap(self):
        self.assertEqual(ap.segment_flips([1.0, 1.4, 1.9, 3.5, 3.9, 6.0], 1.0), [(0, 2), (3, 4), (5, 5)])

    def test_gap_is_inclusive(self):
        self.assertEqual(ap.segment_flips([0.0, 1.0, 2.0], 1.0), [(0, 2)])

    def test_cbl_half_needs_two_flips_and_cbl_between(self):
        times = [1.4, 1.7, 3.0, 3.3, 3.6]
        segs = ap.segment_flips(times, 1.0)
        # 先頭は反転 2 つで CBL(1.5) が間にある → 半回転。後ろは 3 つなので CBL があっても半回転ではない
        self.assertEqual(ap.cbl_half_segments(segs, times, [1.5, 3.2], 0.1), [(0, 1)])
        self.assertEqual(ap.cbl_half_segments(segs, times, [2.3], 0.1), [])
        self.assertEqual(ap.cbl_half_segments(segs, times, [1.8], 0.1), [(0, 1)])   # 1 コマの余裕
        self.assertEqual(ap.cbl_half_segments(segs, times, [2.0], 0.1), [])


class SegmentCooldownTest(unittest.TestCase):
    # 1.4 / 1.7 の半回転（CBL 1.5）の後、2.9 / 3.2 に本物の 1 回転（半回転の 1.5 秒後 = 冷却の内）
    FRAMES = [(1.4, FRONT, False), (0.3, BACK, False), (1.2, FRONT, False), (0.3, BACK, False), (2.3, FRONT, False)]

    def setUp(self):
        self.saved = (ap.TURN_SEGMENTS, ap.TURN_SEG_GAP_SEC, ap.TURN_CBL_HALF_DROP)
        ap.TURN_CBL_HALF_DROP = True
        ap.TURN_SEG_GAP_SEC = 1.0

    def tearDown(self):
        ap.TURN_SEGMENTS, ap.TURN_SEG_GAP_SEC, ap.TURN_CBL_HALF_DROP = self.saved

    def test_default_is_off(self):
        self.assertFalse(self.saved[0])

    def test_old_flow_blocks_next_turn(self):
        ap.TURN_SEGMENTS = False
        self.assertEqual(follower_turns(pair_frames(self.FRAMES, cross_at=1.5)), [])

    def test_segments_do_not_block(self):
        ap.TURN_SEGMENTS = True
        self.assertEqual(follower_turns(pair_frames(self.FRAMES, cross_at=1.5)), [2.9])

    def test_without_cbl_both_flows_agree(self):
        for flag in (False, True):
            ap.TURN_SEGMENTS = flag
            self.assertEqual(follower_turns(pair_frames(self.FRAMES, cross_at=None)), [1.4])


if __name__ == "__main__":
    unittest.main()
