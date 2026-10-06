"""
make_strips.py の切り取り（union_crop / tile_size / build_sheet）の単体テスト。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import numpy as np  # noqa: E402

from make_strips import (  # noqa: E402
    DETAIL_BUDGET, MAX_UPSCALE, build_sheet, detail_tile_size, tile_size, union_crop, upper_body_crop,
)


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


class OutlierAndPartialTest(unittest.TestCase):
    def test_outlier_frame_does_not_widen(self):
        tr = _tracks(20)
        tr["frames"][5]["kept"][0]["bbox"] = [0.0, 0.4, 0.99, 0.8]   # 1コマの飛び
        x1, _, x2, _ = union_crop(tr, 0.0, 2.0, 1000, 2000)
        self.assertGreater(x1, 100)
        self.assertLess(x2, 900)

    def test_partial_sheet_has_no_blank_columns(self):
        frames = [np.zeros((1920, 1080, 3), np.uint8)]
        sheet = build_sheet(frames, [0.0])
        self.assertEqual(sheet.shape[1], 257)
        sheet2 = build_sheet(frames * 3, [0.0, 0.1, 0.2])
        self.assertEqual(sheet2.shape[1], 257 * 3)


def _kps_tracks():
    def person(pid, cx):
        kps = [[0.0, 0.0, 0.0] for _ in range(17)]
        for i, (dx, y) in {0: (0, 0.30), 5: (-0.05, 0.35), 6: (0.05, 0.35), 7: (-0.08, 0.30), 8: (0.08, 0.30),
                           9: (-0.09, 0.22), 10: (0.09, 0.40), 11: (-0.03, 0.50), 12: (0.03, 0.50)}.items():
            kps[i] = [cx + dx, y, 0.9]
        return {"pid": pid, "bbox": [cx - 0.1, 0.2, cx + 0.1, 0.8], "kps": kps}
    return {"leaderPid": 0, "frames": [{"t": i * 0.1, "kept": [person(0, 0.3), person(1, 0.6)]} for i in range(20)]}


class DetailTest(unittest.TestCase):
    def test_upper_body_crop_covers_wrists_not_legs(self):
        x1, y1, x2, y2 = upper_body_crop(_kps_tracks(), 0.0, 1.9, 1000, 2000)
        self.assertLessEqual(y1, int(0.22 * 2000))     # 頭上の手首が入る
        self.assertLess(y2, int(0.70 * 2000))          # 脚までは入らない
        self.assertLessEqual(x1, int(0.21 * 1000))
        self.assertGreaterEqual(x2, int(0.69 * 1000))

    def test_none_when_one_person_missing(self):
        tr = _kps_tracks()
        for f in tr["frames"]:
            f["kept"] = f["kept"][:1]
        self.assertIsNone(upper_body_crop(tr, 0.0, 1.9, 1000, 2000))
        self.assertIsNone(upper_body_crop(None, 0.0, 1.9, 1000, 2000))

    def test_detail_tile_within_budget_and_upscale(self):
        crop = (0, 0, 600, 700)
        tw, th = detail_tile_size(crop)
        self.assertLessEqual(tw * th * 6, DETAIL_BUDGET)
        self.assertLessEqual(tw, 600)
        self.assertAlmostEqual(tw / th, 600 / 700, delta=0.01)
        tw2, _ = detail_tile_size((0, 0, 100, 100))
        self.assertLessEqual(tw2, 200)

    def test_detail_sheet_is_3x2(self):
        frames = [np.zeros((1920, 1080, 3), np.uint8) for _ in range(6)]
        crop = (100, 300, 700, 1000)
        tile = detail_tile_size(crop)
        sheet = build_sheet(frames, [i * 0.3 for i in range(6)], crop, cols=3, tile=tile)
        self.assertEqual(sheet.shape[:2], (tile[1] * 2, tile[0] * 3))


if __name__ == "__main__":
    unittest.main()
