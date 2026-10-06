"""
make_strips.py の切り取り（union_crop / tile_size / build_sheet）の単体テスト。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import numpy as np  # noqa: E402

from make_strips import MAX_UPSCALE, build_sheet, tile_size, union_crop  # noqa: E402


def _tracks(n=10, leader=0):
    frames = []
    for i in range(n):
        frames.append({"t": i * 0.1, "kept": [
            {"pid": 0, "bbox": [0.30, 0.40, 0.45, 0.80]},
            {"pid": 1, "bbox": [0.45 + i * 0.01, 0.30, 0.60, 0.80]},
        ]})
    return {"leaderPid": leader, "frames": frames}


class UnionCropTest(unittest.TestCase):
    def test_union_with_margins(self):
        w, h = 1000, 2000
        x1, y1, x2, y2 = union_crop(_tracks(), 0.0, 0.9, w, h)
        # 和集合: x 0.30..0.60, y 0.30..0.80
        bw, bh = 0.30 * w, 0.50 * h
        self.assertEqual(x1, int(0.30 * w - bw * 0.15))
        self.assertEqual(y1, int(0.30 * h - bh * 0.25))
        self.assertGreaterEqual(y2, int(0.80 * h + bh * 0.10) - 1)
        self.assertGreater(y1 - 0, 0)

    def test_no_pair_returns_none(self):
        tr = {"leaderPid": 0, "frames": [{"t": 0.0, "kept": [{"pid": 0, "bbox": [0.1, 0.1, 0.3, 0.9]}]}]}
        self.assertIsNone(union_crop(tr, 0.0, 1.0, 1000, 2000))
        self.assertIsNone(union_crop(None, 0.0, 1.0, 1000, 2000))
        self.assertIsNone(union_crop({"frames": []}, 0.0, 1.0, 1000, 2000))

    def test_clamped_to_frame(self):
        tr = {"leaderPid": 0, "frames": [{"t": 0.0, "kept": [
            {"pid": 0, "bbox": [0.0, 0.0, 0.5, 1.0]}, {"pid": 1, "bbox": [0.5, 0.0, 1.0, 1.0]}]}]}
        self.assertEqual(union_crop(tr, 0.0, 0.1, 400, 800), (0, 0, 400, 800))


class TileSizeTest(unittest.TestCase):
    def test_pixels_not_above_old_and_aspect_kept(self):
        w, h, cols = 1080, 1920, 7
        old = (1800 // cols) * round(h * (1800 // cols) / w)
        crop = (300, 600, 800, 1500)
        tw, th = tile_size(w, h, cols, crop)
        self.assertLessEqual(tw * th, old)
        self.assertAlmostEqual(tw / th, 500 / 900, delta=0.02)

    def test_upscale_capped(self):
        # 切り取りが小さい（100x150px）なら拡大は 2 倍まで
        tw, th = tile_size(1080, 1920, 7, (0, 0, 100, 150))
        self.assertLessEqual(tw, MAX_UPSCALE * 100)
        self.assertLessEqual(th, MAX_UPSCALE * 150 + 1)

    def test_no_crop_matches_old(self):
        self.assertEqual(tile_size(1080, 1920, 7, None), (257, 457))

    def test_sheet_smaller_pixels_and_people_bigger(self):
        frames = [np.zeros((1920, 1080, 3), np.uint8) for _ in range(21)]
        times = [i * 0.1 for i in range(21)]
        full = build_sheet(frames, times)
        cropped = build_sheet(frames, times, (300, 600, 800, 1500))
        self.assertLessEqual(cropped.shape[0] * cropped.shape[1], full.shape[0] * full.shape[1])
        # 切り取り側のタイルは元の画素の 2 倍以下、かつ全体縮小（257px で 1080 → 0.24 倍）より大きい
        self.assertGreater(cropped.shape[1] / 7 / 500, 257 / 1080)


if __name__ == "__main__":
    unittest.main()
