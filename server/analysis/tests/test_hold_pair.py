"""
手のつなぎ（nearest_hold_pair）の単体テスト（YOLO は回さない）:
- 向かい合う 2 人の握手はクロス（男左×女右・男右×女左）。同じ側同士は距離を HOLD_SAME_SIDE_PENALTY 倍して比べる
- 返す距離は生の値（HOLD_DIST との比較用）

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402


def frame(lw, fw):
    return {"kept": [{"pid": 0, "wrists": {"L": lw[0], "R": lw[1]}},
                     {"pid": 1, "wrists": {"L": fw[0], "R": fw[1]}}]}


class NearestHoldPair(unittest.TestCase):
    def test_cross_wins_when_slightly_farther(self):
        # 右×右 .050、右×左 .060（クロスが少し遠い）→ クロスを選ぶ
        df = frame((None, (0.5, 0.5)), ((0.44, 0.5), (0.55, 0.5)))
        pair, d = ap.nearest_hold_pair(df, 0)
        self.assertEqual(pair, "R-L")
        self.assertAlmostEqual(d, 0.06, places=3)

    def test_same_side_wins_when_clearly_closer(self):
        # 右×右 .010、右×左 .060 → 同じ側でも明らかに近ければ選ぶ
        df = frame((None, (0.5, 0.5)), ((0.44, 0.5), (0.51, 0.5)))
        pair, d = ap.nearest_hold_pair(df, 0)
        self.assertEqual(pair, "R-R")
        self.assertAlmostEqual(d, 0.01, places=3)

    def test_missing_wrist_skipped(self):
        df = frame(((0.5, 0.5), None), (None, (0.52, 0.5)))
        pair, _ = ap.nearest_hold_pair(df, 0)
        self.assertEqual(pair, "L-R")


class HoldWristsByFacing(unittest.TestCase):
    def kps(self, c):
        return [(0.5, 0.3, c), (0.5, 0.3, c), (0.5, 0.3, c)] + [(0.5, 0.5, 1.0)] * 14

    def test_back_swaps_when_coco_says_front(self):
        # 背中向きなら画面の左の手 = 本人の左手。COCO が左手首を画面の右に付けていたら入れ替える
        p = {"kps": self.kps(0.0), "wrists": {"L": (0.6, 0.5), "R": (0.4, 0.5)}}
        self.assertEqual(ap.hold_wrists(p), {"L": (0.4, 0.5), "R": (0.6, 0.5)})

    def test_front_keeps_coco_when_consistent(self):
        p = {"kps": self.kps(0.9), "wrists": {"L": (0.6, 0.5), "R": (0.4, 0.5)}}
        self.assertEqual(ap.hold_wrists(p), p["wrists"])

    def test_unreadable_facing_keeps_coco(self):
        p = {"kps": self.kps(0.4), "wrists": {"L": (0.6, 0.5), "R": (0.4, 0.5)}}
        self.assertEqual(ap.hold_wrists(p), p["wrists"])


if __name__ == "__main__":
    unittest.main()
