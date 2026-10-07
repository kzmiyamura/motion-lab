"""
analyze_pair.detect_leading_cut（冒頭の静止画・場面の切れ目の検出）の単体テスト。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402


def _write_video(path, colors, fps=30):
    w, h = 96, 160
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    rng = np.random.default_rng(0)
    for c in colors:
        img = np.full((h, w, 3), c, np.uint8)
        img = np.clip(img.astype(int) + rng.integers(-3, 4, img.shape), 0, 255).astype(np.uint8)
        vw.write(img)
    vw.release()


class LeadingCutTest(unittest.TestCase):
    def test_cut_after_a_few_frames_is_found(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "cut.mp4")
            _write_video(p, [(200, 60, 60)] * 4 + [(40, 160, 220)] * 40)
            t = ap.detect_leading_cut(p)
            self.assertIsNotNone(t)
            self.assertAlmostEqual(t, 4 / 30, delta=0.05)   # 5 コマ目（変化後の最初のコマ）

    def test_no_cut_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "still.mp4")
            _write_video(p, [(200, 60, 60)] * 44)
            self.assertIsNone(ap.detect_leading_cut(p))

    def test_gradual_change_is_not_a_cut(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "fade.mp4")
            _write_video(p, [(200 - 3 * i, 60 + 3 * i, 60) for i in range(44)])
            self.assertIsNone(ap.detect_leading_cut(p))

    def test_missing_file_returns_none(self):
        self.assertIsNone(ap.detect_leading_cut("no-such-file.mp4"))


if __name__ == "__main__":
    unittest.main()
