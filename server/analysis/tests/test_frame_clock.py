"""
コマ番号 ↔ 時刻（PTS）の共通の部品 frame_time.FrameClock と、それを使う refine_events.pick_indices の単体テスト
（docs/salsa-knowledge/README.md 27）。

- PTS が取れない動画は従来の コマ番号 / fps に戻る
- 可変フレームレート（コマ番号 / fps が PTS より進む）でも、時刻 → コマ番号は PTS の時計で引く
- cv2 の POS_MSEC（PTS そのもの）と解析の時刻（ならした PTS）を行き来できる

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from frame_time import FrameClock, pts_offsets  # noqa: E402
from refine_events import pick_indices  # noqa: E402

FPS = 30.0


def vfr_pts(n=900, rate=0.9):
    """本当の時刻が コマ番号 / fps の rate 倍で進む（後ろほど コマ番号 / fps が先に行く）可変フレームレート"""
    return [i / FPS * rate for i in range(n)]


class FrameClockTest(unittest.TestCase):
    def test_index_clock_without_pts(self):
        c = FrameClock(FPS)
        self.assertFalse(c.is_pts)
        self.assertAlmostEqual(c.time(45), 1.5)
        self.assertEqual(c.index_at(1.5), 45)
        self.assertEqual(c.indices_between(1.0, 1.1), [30, 31, 32, 33])
        self.assertEqual(c.to_pts(2.0), 2.0)
        self.assertEqual(c.from_pts(2.0), 2.0)

    def test_vfr_lookup_uses_pts(self):
        raw = vfr_pts()
        c = FrameClock(FPS, pts_offsets(raw, FPS), raw)
        self.assertTrue(c.is_pts)
        # 20 秒のコマは コマ番号 / fps なら 600 番だが、PTS では 20 / 0.9 × 30 ≈ 667 番
        i = c.index_at(20.0)
        self.assertLessEqual(abs(i - 667), 1)
        self.assertAlmostEqual(c.time(i), 20.0, delta=0.03)
        idx = c.indices_between(20.0, 21.0)
        self.assertTrue(all(19.999 <= c.time(k) <= 21.001 for k in idx))
        self.assertLessEqual(abs(len(idx) - 33), 1)

    def test_msec_round_trip(self):
        # 画面録画のようにコマごとに揺れる PTS: ならした時刻 ↔ PTS を行き来しても同じコマに戻る
        jit = (0.012, -0.012, 0.0)
        raw = [i / FPS + 0.4 + jit[i % 3] for i in range(300)]
        c = FrameClock(FPS, pts_offsets(raw, FPS), raw)
        for i in (10, 77, 150, 299):
            self.assertAlmostEqual(c.to_pts(c.time(i)), raw[i], delta=1e-9)
            self.assertAlmostEqual(c.from_pts(raw[i]), c.time(i), delta=1e-9)
            self.assertEqual(c.index_at(c.from_pts(raw[i])), i)

    def test_out_of_range_extrapolates(self):
        raw = [i / FPS + 0.5 for i in range(30)]
        c = FrameClock(FPS, pts_offsets(raw, FPS), raw)
        self.assertAlmostEqual(c.time(40), 40 / FPS + 0.5)
        self.assertEqual(c.index_at(-3.0), 0)
        self.assertEqual(c.index_at(40 / FPS + 0.5), 40)

    def test_from_tracks_fills_between_sampled_frames(self):
        # analyze_pair の tracks は 4 コマおきに (frameIdx, t)。間のコマは線形に埋める（refine_events が動画をなめ直さない）
        raw = vfr_pts()
        full = FrameClock(FPS, pts_offsets(raw, FPS), raw)
        frames = [{"frameIdx": i, "t": full.time(i), "kept": []} for i in range(0, 900, 4)]
        c = FrameClock.from_tracks(frames, FPS, n_frames=900)
        self.assertEqual(len(c), 900)
        for i in (1, 2, 3, 301, 302, 897, 899):
            self.assertAlmostEqual(c.time(i), full.time(i), delta=0.002)
        self.assertEqual(c.index_at(full.time(450)), 450)
        # tracks が無ければ コマ番号 / fps
        self.assertFalse(FrameClock.from_tracks([], FPS).is_pts)

    def test_times_are_monotone(self):
        # PTS が途中で 0.5 秒飛ぶ（コマ落ち）と、中央値でならした時刻はその前後で戻りうる → 単調にそろえる
        raw = [i / FPS for i in range(100)] + [100 / FPS + 0.5 + i / FPS for i in range(100)]
        c = FrameClock(FPS, pts_offsets(raw, FPS), raw)
        self.assertTrue(all(b > a for a, b in zip(c.times, c.times[1:])))


class LateSeekCap:
    """cv2.VideoCapture の代わり: 30fps の等間隔のコマで、POS_MSEC のシークが狙いより late 秒遅れたコマに着く
    （可変フレームレートの mp4 で cv2 が実際にする。README 27）。read() の後の get(POS_MSEC) は読んだコマの PTS"""

    def __init__(self, late=0.3, n=600):
        self.late, self.n, self.i = late, n, 0

    def set(self, prop, v):
        import cv2
        if prop == cv2.CAP_PROP_POS_FRAMES:
            self.i = int(v)
        else:
            self.i = max(0, int(round((v / 1000 + self.late) * FPS)))

    def read(self):
        if self.i >= self.n:
            return False, None
        self.cur = self.i / FPS
        self.i += 1
        return True, self.cur   # フレームの中身 = その PTS

    def get(self, prop):
        return self.cur * 1000


class SeekTest(unittest.TestCase):
    def test_plain_seek_lands_late(self):
        cap = LateSeekCap()
        cap.set(None, 5000)
        _, f = cap.read()
        self.assertAlmostEqual(f, 5.3, places=6)

    def test_seek_read_lands_at_or_before(self):
        from frame_time import seek_read
        frame, p = seek_read(LateSeekCap(), 5.0)
        self.assertLessEqual(p, 5.0 + 1e-6)
        self.assertGreater(p, 3.5)
        self.assertEqual(frame, p)

    def test_grab_at_returns_frame_shown_at_t(self):
        from frame_time import grab_at
        for late in (0.0, 0.3, 1.2):
            frame, p = grab_at(LateSeekCap(late), 5.01)
            self.assertAlmostEqual(p, 150 / FPS, places=6)   # 5.0 秒のコマ（次の 5.033 秒はまだ出ていない）
            self.assertEqual(frame, p)

    def test_grab_at_start_and_end(self):
        from frame_time import grab_at
        self.assertEqual(grab_at(LateSeekCap(0.3), 0.0)[1], 0.0)
        frame, p = grab_at(LateSeekCap(0.3, n=100), 50.0)   # 動画の後ろ → 無し（従来の cap.read() 失敗と同じ）
        self.assertIsNone(frame)
        frame, p = grab_at(LateSeekCap(0.3, n=100), 3.2)    # 終わり際は遅れて着けなくても手前から読む
        self.assertAlmostEqual(p, 96 / FPS, places=6)


class PickIndicesClockTest(unittest.TestCase):
    def test_same_as_index_clock_without_pts(self):
        self.assertEqual(pick_indices(40.0, 27.0, 1.0, 2.0, FrameClock(40.0)), pick_indices(40.0, 27.0, 1.0, 2.0))

    def test_vfr_window_is_read_on_pts(self):
        raw = vfr_pts()
        c = FrameClock(FPS, pts_offsets(raw, FPS), raw)
        idx = pick_indices(FPS, 27.0, 20.0, 21.0, c)
        self.assertTrue(idx)
        self.assertTrue(all(19.999 <= c.time(k) <= 21.001 for k in idx))
        # コマ番号 / fps で引くと 2 秒手前（18〜18.9 秒）のコマになっていた
        old = pick_indices(FPS, 27.0, 20.0, 21.0)
        self.assertLess(c.time(old[0]) - 20.0, -1.5)


if __name__ == "__main__":
    unittest.main()
