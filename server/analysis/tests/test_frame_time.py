"""
コマの時刻を動画のタイムスタンプ（PTS）から取る（analyze_pair.pts_offsets、docs/salsa-knowledge/README.md 26）の単体テスト。

- 可変フレームレートでゆっくり溜まる「コマ番号 / fps − PTS」のずれは直す
- コマごとの不規則な間隔（画面録画）は入れない（中央値でならす）
- PTS が使えない（空・戻る・NaN）なら None（呼び出し側は コマ番号 / fps に戻る）

実行: python -m unittest discover -s server/analysis/tests
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from analyze_pair import pts_offsets  # noqa: E402


class PtsOffsetsTest(unittest.TestCase):
    FPS = 30.0

    def test_raw_pts_when_not_smoothed(self):
        pts = [0.0, 0.03, 0.1, 0.12, 0.2]
        self.assertEqual(pts_offsets(pts, self.FPS, smooth_sec=0), pts)

    def test_slow_drift_is_followed(self):
        # 本当の時刻が コマ番号 / fps より 1 秒あたり 2% 遅れていく
        pts = [i / self.FPS * 0.98 for i in range(600)]
        out = pts_offsets(pts, self.FPS, smooth_sec=1.0)
        for i in range(30, 570, 50):
            self.assertAlmostEqual(out[i], pts[i], delta=0.02)

    def test_frame_jitter_is_smoothed_out(self):
        # 一定のずれ 0.5 秒 + コマごとの ±0.012 秒の揺れ → 揺れは入らない
        jit = (0.012, -0.012, 0.0)
        pts = [i / self.FPS + 0.5 + jit[i % 3] for i in range(300)]
        out = pts_offsets(pts, self.FPS, smooth_sec=1.0)
        for i in range(0, 300, 7):
            self.assertAlmostEqual(out[i], i / self.FPS + 0.5, delta=1e-9)
        # 時刻は増えていく
        self.assertTrue(all(b > a for a, b in zip(out, out[1:])))

    def test_unusable_pts_give_none(self):
        self.assertIsNone(pts_offsets([], self.FPS))
        self.assertIsNone(pts_offsets([0.0, 0.1, 0.05, 0.2], self.FPS))
        self.assertIsNone(pts_offsets([0.0, math.nan, 0.2], self.FPS))


if __name__ == "__main__":
    unittest.main()
