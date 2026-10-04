"""
analyze_pair.suppress_duplicates（同じ人への二重検出をまとめる）の単体テスト。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402


def person(bbox, torso, conf=0.9):
    """torso: (肩の中点 x, 肩の y, 腰の y, 肩幅)。kps は 17 点、肩・腰以外は 0"""
    cx, sy, hy, w = torso
    kps = [(0.0, 0.0, 0.0)] * 17
    kps[ap.LEFT_SHOULDER] = (cx + w / 2, sy, 0.9)
    kps[ap.RIGHT_SHOULDER] = (cx - w / 2, sy, 0.9)
    kps[ap.LEFT_HIP] = (cx + w / 3, hy, 0.9)
    kps[ap.RIGHT_HIP] = (cx - w / 3, hy, 0.9)
    x0, y0, x1, y1 = bbox
    return {"bbox": bbox, "kps": kps, "conf": conf, "bboxArea": (x1 - x0) * (y1 - y0)}


class SuppressDuplicatesTest(unittest.TestCase):
    def test_duplicate_box_on_same_person_is_dropped(self):
        # 男の本物の枠と、少し大きい二重の枠（IoU 0.65、骨格はほぼ同じ）。女性は横に離れている
        man = person((0.30, 0.10, 0.60, 0.90), (0.45, 0.30, 0.55, 0.12), conf=0.92)
        dup = person((0.28, 0.08, 0.66, 0.95), (0.452, 0.302, 0.553, 0.121), conf=0.55)
        woman = person((0.58, 0.20, 0.80, 0.90), (0.69, 0.35, 0.55, 0.09), conf=0.88)
        self.assertGreater(ap.bbox_iou(man["bbox"], dup["bbox"]), 0.5)
        # まとめないと面積上位 2 人が男と二重枠になり、女性が外れる
        self.assertNotIn(woman, ap.pick_main_pair([man, dup, woman]))
        kept, dropped = ap.suppress_duplicates([man, dup, woman])
        self.assertEqual(kept, [man, woman])
        self.assertEqual(dropped, [dup])
        self.assertIn(woman, ap.pick_main_pair(kept))

    def test_higher_confidence_box_is_kept(self):
        a = person((0.30, 0.10, 0.60, 0.90), (0.45, 0.30, 0.55, 0.12), conf=0.5)
        b = person((0.29, 0.10, 0.63, 0.92), (0.451, 0.301, 0.551, 0.12), conf=0.9)
        kept, dropped = ap.suppress_duplicates([a, b])
        self.assertEqual(kept, [b])
        self.assertEqual(dropped, [a])

    def test_close_hold_partner_is_not_dropped(self):
        # 密着ホールド・CBL の交差: bbox は大きく重なる（IoU > 0.5）が、肩・腰の位置は胴の長さほど違う
        man = person((0.30, 0.10, 0.62, 0.92), (0.44, 0.28, 0.55, 0.12))
        woman = person((0.34, 0.15, 0.64, 0.93), (0.52, 0.36, 0.60, 0.10))
        self.assertGreater(ap.bbox_iou(man["bbox"], woman["bbox"]), 0.5)
        kept, dropped = ap.suppress_duplicates([man, woman])
        self.assertEqual(kept, [man, woman])
        self.assertEqual(dropped, [])

    def test_aspect_scales_x_distance(self):
        # 縦長の動画（幅 / 高さ = 0.5625）では x のずれが縮む。正規化座標のままだと x のずれを大きく見積もる
        a = person((0.30, 0.10, 0.60, 0.90), (0.45, 0.30, 0.55, 0.12))
        b = person((0.32, 0.10, 0.62, 0.90), (0.49, 0.30, 0.55, 0.12))
        self.assertGreater(ap.torso_distance(a, b, 1.0), ap.torso_distance(a, b, 0.5625))

    def test_off_by_default(self):
        # 正解表 6 本で合計が下がったので既定では使わない（見つけて数えるだけ）
        self.assertFalse(ap.DEDUP_DUPLICATES)


if __name__ == "__main__":
    unittest.main()
