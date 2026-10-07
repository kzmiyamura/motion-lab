"""
analyze_pair.drop_background_persons（背景の別人を主ペアから外す）の単体テスト。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

DANCER = [0.15, 0.20, 0.58, 0.76]      # 手前の踊り手
PARTNER = [0.35, 0.28, 0.60, 0.78]     # 本物のパートナー
BACKGROUND = [0.60, 0.26, 0.90, 0.52]  # 奥に立つ別人（高さ 0.26・足元が高い）


def _frame(i, boxes):
    return {"t": i * 0.1, "kept": [{"bbox": b, "shr2d": 1.0} for b in boxes], "rejected": []}


class BackgroundPersonTest(unittest.TestCase):
    def setUp(self):
        self._solo = ap.BG_SOLO_ADJ_SEC
        ap.BG_SOLO_ADJ_SEC = 0.0

    def tearDown(self):
        ap.BG_SOLO_ADJ_SEC = self._solo

    def test_long_run_is_dropped_and_moved_to_rejected(self):
        frames = [_frame(i, [DANCER, BACKGROUND]) for i in range(15)] + [_frame(i, [DANCER, PARTNER]) for i in range(15, 25)]
        n = ap.drop_background_persons(frames)
        self.assertEqual(n, 15)
        for df in frames[:15]:
            self.assertEqual(len(df["kept"]), 1)
            self.assertEqual(df["kept"][0]["bbox"], DANCER)
            self.assertEqual(df["rejected"][0]["bbox"], BACKGROUND)
        for df in frames[15:]:
            self.assertEqual(len(df["kept"]), 2)

    def test_short_flicker_is_kept(self):
        frames = [_frame(i, [DANCER, PARTNER]) for i in range(10)]
        frames[4] = _frame(4, [DANCER, BACKGROUND])    # 1コマだけ（接近・部分遮蔽の点滅）
        self.assertEqual(ap.drop_background_persons(frames), 0)
        self.assertEqual(len(frames[4]["kept"]), 2)

    def test_real_pair_with_different_height_is_kept(self):
        frames = [_frame(i, [[0.30, 0.34, 0.50, 0.78], [0.50, 0.28, 0.70, 0.82]]) for i in range(30)]
        self.assertEqual(ap.drop_background_persons(frames), 0)

    def test_solo_adjacent_flag(self):
        # 相方を見失った直後に別人を1コマ拾う。既定（無効）では残し、フラグを立てると外す
        def seq():
            fr = [_frame(i, [DANCER]) for i in range(5)]
            fr += [_frame(5, [DANCER, BACKGROUND])]
            fr += [_frame(i, [DANCER, PARTNER]) for i in range(6, 12)]
            return fr
        frames = seq()
        self.assertEqual(ap.drop_background_persons(frames), 0)
        ap.BG_SOLO_ADJ_SEC = 0.3
        frames = seq()
        self.assertEqual(ap.drop_background_persons(frames), 1)
        self.assertEqual(len(frames[5]["kept"]), 1)

    def test_disabled_by_flag(self):
        frames = [_frame(i, [DANCER, BACKGROUND]) for i in range(15)]
        old = ap.BG_FILTER
        ap.BG_FILTER = False
        try:
            self.assertEqual(ap.drop_background_persons(frames), 0)
        finally:
            ap.BG_FILTER = old


if __name__ == "__main__":
    unittest.main()
