"""
make_move_frames.py の「めくり」用の密なコマ（flip[]）のテスト。

アプリの めくり 表示は上半分で技のコマをパラパラ漫画のように流す。1 拍に 1 コマ＋見どころのコマを
小さめの JPEG で別に作り、index.json の flip[] に載せる（frames[] は変えない）。

実行: python -m pytest server/analysis/tests/test_make_move_frames_flip.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import make_move_frames as mmf  # noqa: E402
from make_move_frames import (  # noqa: E402
    AND_LABEL, FLIP_H, FLIP_JPEG_QUALITY, FLIP_MAX_FRAMES, FLIP_W, flip_label, flip_times, render_flip_tile,
)

BEAT = 0.32


class FlipTimesTest(unittest.TestCase):
    def test_one_frame_per_half_beat_for_one_eight(self):
        out = flip_times(0.0, 8 * BEAT, BEAT, 8, [])
        self.assertEqual(len(out), 16)
        # 1, 1&, 2, 2& … 8, 8&（& は直前の拍・label「&」・half）
        self.assertEqual([o[1] for o in out], [c for c in range(1, 9) for _ in (0, 1)])
        for k, o in enumerate(out):
            self.assertAlmostEqual(o[0], k * BEAT / 2)
            self.assertFalse(o[3])
            self.assertEqual(o[4], k % 2 == 1)
            self.assertEqual(o[2], AND_LABEL if k % 2 else "")

    def test_key_moments_are_merged_and_win_over_close_beats(self):
        keys = [(0.0, 1, "スタート"), (4.1 * BEAT, 5, "通過"), (6.75 * BEAT, 7, "右回り中")]
        out = flip_times(0.0, 8 * BEAT, BEAT, 8, keys)
        times = [o[0] for o in out]
        self.assertEqual(times, sorted(times))
        # 拍 0（スタートと重なる）と拍 4（通過の 0.1 拍前）は見どころに置き換わる
        self.assertEqual(sum(1 for o in out if abs(o[0]) < 1e-9), 1)
        self.assertFalse(any(not o[3] and abs(o[0] - 4 * BEAT) < 1e-9 for o in out))
        # 6.75 拍目は 6.5・7 拍目から 0.25 拍離れているので、どちらのコマも残る
        self.assertTrue(any(not o[3] and abs(o[0] - 6.5 * BEAT) < 1e-9 for o in out))
        self.assertTrue(any(not o[3] and abs(o[0] - 7 * BEAT) < 1e-9 for o in out))
        labels = [o[2] for o in out if o[3]]
        self.assertEqual(labels, ["スタート", "通過", "右回り中"])
        self.assertEqual(len(out), 16 - 2 + 3)
        self.assertFalse(any(o[4] for o in out if o[3]))  # 見どころは & にしない

    def test_without_beat_only_key_moments(self):
        keys = [(0.0, None, "スタート"), (1.0, None, "終わり")]
        self.assertEqual([o[0] for o in flip_times(0.0, 1.05, None, 8, keys)], [0.0, 1.0])

    def test_last_beat_stays_inside_the_window(self):
        # 区間の終わりの 0.05 秒手前（次の技の頭と重ねない）
        out = flip_times(10.0, 10.0 + 8 * BEAT, BEAT, 8, [])
        self.assertLess(max(o[0] for o in out), 10.0 + 8 * BEAT - 0.05 + 1e-9)

    def test_long_moves_are_capped_but_keep_key_moments(self):
        keys = [(k * 0.9 + 0.13, None, f"k{k}") for k in range(5)]
        out = flip_times(0.0, 12.0, 0.25, 48, keys)
        self.assertLessEqual(len(out), FLIP_MAX_FRAMES)
        self.assertEqual(sum(1 for o in out if o[3]), 5)

    def test_sixteen_counts_drop_and_frames_before_beats(self):
        # 24 拍: 半拍で 49 コマ＋見どころ 5 > 上限 → & から間引き、拍のコマは残る
        keys = [(k * 0.9 + 0.13, None, f"k{k}") for k in range(5)]
        out = flip_times(0.0, 24 * BEAT + 0.05, BEAT, 24, keys)
        self.assertEqual(len(out), FLIP_MAX_FRAMES)
        beats = [o for o in out if not o[3] and not o[4]]
        self.assertGreaterEqual(len(beats), 25 - 5)  # 見どころと重なった拍だけ抜ける
        self.assertTrue(any(o[4] for o in out))
        self.assertEqual(sum(1 for o in out if o[3]), 5)

    def test_flip_label_uses_on2_words_for_beat_frames(self):
        self.assertEqual(flip_label({"move": "basic"}, 2, AND_LABEL), AND_LABEL)
        self.assertEqual(flip_label({"move": "basic"}, 2, ""), "男が下がる")
        self.assertEqual(flip_label({"move": "cbl"}, 1, ""), "男が開く")
        self.assertEqual(flip_label({"move": "basic"}, 3, ""), "")
        self.assertEqual(flip_label({"move": "cbl"}, 5, "通過"), "通過")


class FlipTileTest(unittest.TestCase):
    def test_tile_size_and_modest_jpeg(self):
        rng = np.random.default_rng(0)
        frame = (rng.random((1920, 888, 3)) * 255).astype(np.uint8)
        frame = cv2.GaussianBlur(frame, (31, 31), 0)  # 写真に近い（ノイズだけの画像は JPEG が大きすぎる）
        for crop in [(100, 300, 700, 1200), None]:
            tile = render_flip_tile(frame, crop)
            self.assertEqual(tile.shape, (FLIP_H, FLIP_W, 3))
            ok, buf = cv2.imencode(".jpg", tile, [cv2.IMWRITE_JPEG_QUALITY, FLIP_JPEG_QUALITY])
            self.assertTrue(ok)
            self.assertLess(len(buf), 60_000)

    def test_no_time_stamp(self):
        # 真っ白なフレーム → 時刻の黒い帯が無い（流したときにちらつかない）
        frame = np.full((720, 480, 3), 255, np.uint8)
        tile = render_flip_tile(frame, (0, 0, 480, 720))
        self.assertGreater(tile[5:30, 5:60].mean(), 240)


class FlipEndToEndTest(unittest.TestCase):
    """小さな合成動画で main() を回し、index.json に frames[] と flip[] が並ぶことを確かめる"""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.video = os.path.join(self.dir, "v.avi")
        w = cv2.VideoWriter(self.video, cv2.VideoWriter_fourcc(*"MJPG"), 20, (320, 480))
        if not w.isOpened():
            self.skipTest("cv2.VideoWriter が使えない")
        for k in range(20 * 6):
            img = np.full((480, 320, 3), (k * 2) % 255, np.uint8)
            w.write(img)
        w.release()
        self.result = os.path.join(self.dir, "result.json")
        with open(self.result, "w", encoding="utf-8") as f:
            json.dump({"routine": {"bpm": 187.5, "grid": {"beatSec": BEAT}, "moves": [
                {"move": "basic", "start": 0.2, "counts": 8},
                {"move": "cbl", "start": 0.2 + 8 * BEAT, "counts": 8},
            ]}}, f)
        self.out = os.path.join(self.dir, "mf")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_main(self, *extra):
        argv = ["make_move_frames.py", self.video, os.path.join(self.dir, "none.tracks.json"), self.result,
                os.path.join(self.dir, "none.json"), self.out, "/p", *extra]
        with mock.patch.object(sys, "argv", argv):
            mmf.main()
        with open(os.path.join(self.out, "index.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_flip_is_added_next_to_frames(self):
        idx = self.run_main()
        self.assertTrue(idx["complete"])
        self.assertEqual(len(idx["moves"]), 2)
        for m in idx["moves"]:
            self.assertEqual(len(m["frames"]), 5)   # 見どころのコマは今までどおり
            self.assertGreaterEqual(len(m["flip"]), 14)   # 半拍に 1 コマ
            halves = [s for s in m["flip"] if s.get("half")]
            self.assertGreaterEqual(len(halves), 6)
            self.assertTrue(all(s["label"] == "&" for s in halves))
            ts = [s["t"] for s in m["flip"]]
            self.assertEqual(ts, sorted(ts))
            for s in m["flip"]:
                self.assertTrue(s["url"].startswith("/p/"))
                path = os.path.join(self.out, s["url"][len("/p/"):])
                self.assertTrue(os.path.exists(path))
                self.assertLess(os.path.getsize(path), 60_000)
                self.assertIn(s["count"], range(1, 9))
            self.assertTrue(any(s.get("key") for s in m["flip"]))

    def test_no_flip_keeps_the_old_output(self):
        idx = self.run_main("--no-flip")
        for m in idx["moves"]:
            self.assertNotIn("flip", m)
            self.assertEqual(len(m["frames"]), 5)
        self.assertFalse(any("_f" in n for n in os.listdir(self.out)))


if __name__ == "__main__":
    unittest.main()
