"""
analyze_pair.detect_turns（肩の並びの反転からターンを拾う）の単体テスト。YOLO は回さない。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

FRONT, BACK = 0.15, -0.15


def frames(segments, pid=1, fps=10):
    """[(秒数, shDx), ...] を順に並べた 10fps の draw_frames"""
    out, t = [], 0.0
    for dur, d in segments:
        for _ in range(int(round(dur * fps))):
            out.append({"t": round(t, 2), "kept": [{"pid": pid, "shDx": d}]})
            t += 1 / fps
    return out


class DetectTurnsTest(unittest.TestCase):
    def test_single_turn(self):
        f = frames([(1.0, FRONT), (0.3, BACK), (1.0, FRONT)])
        turns = ap.detect_turns(f, 1)
        self.assertEqual(len(turns), 1)
        self.assertAlmostEqual(turns[0][0], 1.0, places=1)
        self.assertEqual(turns[0][1], 1)

    def test_fast_spin_inside_cooldown_is_kept(self):
        # 1.0 秒に1回転、その 1.5 秒後（冷却 2.5 秒の内側）から反転 5 回の速い連続回転（2½ 回転）
        f = frames([(1.0, FRONT), (0.3, BACK), (1.2, FRONT),
                    (0.3, BACK), (0.3, FRONT), (0.3, BACK), (0.3, FRONT), (1.5, BACK)])
        turns = ap.detect_turns(f, 1)
        self.assertEqual(len(turns), 2)
        self.assertAlmostEqual(turns[1][0], 2.5, places=1)
        self.assertEqual(turns[1][1], 2)

    def test_turn_starting_at_tail_of_spin_is_recounted(self):
        # 前のターンの冷却（2.5 秒）が明けたのが連続回転（2.8〜4.0 秒の反転 5 回）の終わり際（3.7 秒）:
        # 冷却だけなら 3.7 秒の 1 回転になるところを、回転の始まりから 2 回転と数え直す
        f = frames([(1.0, FRONT), (0.3, BACK), (1.5, FRONT),
                    (0.3, BACK), (0.3, FRONT), (0.3, BACK), (0.3, FRONT), (1.5, BACK)])
        turns = ap.detect_turns(f, 1)
        self.assertEqual([round(t, 1) for t, _ in turns], [1.0, 2.8])
        self.assertEqual(turns[1][1], 2)

    def test_long_jitter_chain_is_not_merged(self):
        # 反転が 8 個続く揺れ（TURN_FAST_MAX_FLIPS を超える）は速い連続回転として扱わない
        f = frames([(1.0, FRONT), (0.3, BACK), (1.2, FRONT)] + [(0.3, BACK), (0.3, FRONT)] * 4 + [(1.5, FRONT)])
        before = ap.TURN_FAST_MIN_FLIPS
        try:
            ap.TURN_FAST_MIN_FLIPS = 99
            expected = ap.detect_turns(f, 1)
        finally:
            ap.TURN_FAST_MIN_FLIPS = before
        self.assertEqual(ap.detect_turns(f, 1), expected)


if __name__ == "__main__":
    unittest.main()
