"""
make_move_frames.py の技の区間（move_windows / beat_interval / frame_times）の単体テスト。

振付シートの1行 = 1技に、その技の頭から次の技の頭までの写真が付くことを確かめる。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import numpy as np  # noqa: E402

from make_move_frames import (  # noqa: E402
    CROP_ASPECT, DEFAULT_BEAT_SEC, MAX_SPAN_SEC, MIN_SPAN_SEC, TILE_H, TILE_W, beat_interval, crop_box,
    expand_to_aspect, frame_times, move_windows, pair_bounds, pair_pids, render_tile, strip_of,
)


def _frame(t, *people):
    """tracks.json の1フレーム。people = (pid, bbox) の並び"""
    return {"t": t, "kept": [{"pid": pid, "bbox": list(b)} for pid, b in people]}


class PairCropTest(unittest.TestCase):
    # 縦長の画面収録（888x1920）。主ペアは真ん中あたり、後ろの観客（pid 無し）は画面の端
    W, H = 888, 1920
    FRAMES = [
        _frame(t / 10, (0, (0.30, 0.30, 0.50, 0.75)), (1, (0.50, 0.28, 0.70, 0.78)), (None, (0.0, 0.1, 0.1, 0.9)))
        for t in range(0, 50)
    ]

    def test_pair_pids_follow_leader(self):
        self.assertEqual(pair_pids({"leaderPid": 1}), (1, 0))
        self.assertEqual(pair_pids({"leaderPid": None}), (0, 1))
        self.assertEqual(pair_pids({}), (0, 1))

    def test_bounds_ignore_non_pair_people(self):
        box, n = pair_bounds(self.FRAMES, (0, 1), 1.0, 2.0)
        self.assertEqual(n, 13)  # 0.85〜2.15 秒のフレーム（区間の前後 0.15 秒を含む）
        self.assertAlmostEqual(box[0], 0.30)
        self.assertAlmostEqual(box[2], 0.70)
        self.assertAlmostEqual(box[1], 0.28)
        self.assertAlmostEqual(box[3], 0.78)

    def test_crop_is_tight_and_keeps_aspect(self):
        x1, y1, x2, y2 = crop_box(self.FRAMES, (0, 1), 1.0, 2.0, None, self.W, self.H)
        self.assertAlmostEqual((x2 - x1) / (y2 - y1), CROP_ASPECT, delta=0.01)
        # 画面上部の UI（ステータスバー・ヘッダー: 高さの上 15%）と下のボタン列は落ちる
        self.assertGreater(y1, 0.15 * self.H)
        self.assertLess(y2, 0.95 * self.H)
        # ペアは範囲に収まる（頭上の余白込み）
        self.assertLessEqual(x1, 0.30 * self.W)
        self.assertGreaterEqual(x2, 0.70 * self.W)
        self.assertLess(y1, 0.28 * self.H)

    def test_wide_pair_is_clamped_to_frame(self):
        # 2人が画面の幅いっぱい → 幅は画面で頭打ち（足りない分は描画時に黒で埋める）
        x1, y1, x2, y2 = expand_to_aspect((0.02, 0.25, 0.98, 0.85), self.W, self.H)
        self.assertEqual((x1, x2), (0, self.W))
        self.assertGreaterEqual(y1, 0)
        self.assertLessEqual(y2, self.H)

    def test_crop_shifts_inside_frame(self):
        x1, y1, x2, y2 = expand_to_aspect((0.0, 0.0, 0.2, 0.3), 1920, 1080)
        self.assertEqual((x1, y1), (0, 0))
        self.assertLessEqual(x2, 1920)

    def test_falls_back_to_whole_video_box_when_window_is_empty(self):
        global_box, _ = pair_bounds(self.FRAMES, (0, 1))
        self.assertEqual(
            crop_box(self.FRAMES, (0, 1), 30.0, 32.0, global_box, self.W, self.H),
            expand_to_aspect(global_box, self.W, self.H),
        )

    def test_per_frame_crop_follows_the_pair(self):
        # カメラが寄る・回り込む: 前半はペアが左、後半は右。コマごとに前後だけを見るので、
        # 区間全体で合わせるよりずっと狭く切れる
        frames = [_frame(t / 10, (0, (0.05, 0.3, 0.25, 0.7)), (1, (0.25, 0.3, 0.45, 0.7))) for t in range(0, 20)]
        frames += [_frame(t / 10, (0, (0.55, 0.3, 0.75, 0.7)), (1, (0.75, 0.3, 0.95, 0.7))) for t in range(20, 40)]
        W, H = 1920, 1080
        whole = crop_box(frames, (0, 1), 0.0, 4.0, None, W, H)
        early = crop_box(frames, (0, 1), 0.0, 4.0, None, W, H, t=0.5)
        late = crop_box(frames, (0, 1), 0.0, 4.0, None, W, H, t=3.5)
        self.assertLess(early[2] - early[0], (whole[2] - whole[0]) * 0.7)
        self.assertLess(early[2], 0.6 * W)
        self.assertGreater(late[0], 0.4 * W)
        # コマの前後に枠が無ければ区間全体の範囲
        self.assertEqual(crop_box(frames, (0, 1), 0.0, 4.0, None, W, H, t=9.0), whole)

    def test_no_tracks_means_no_crop(self):
        self.assertIsNone(crop_box([], (0, 1), 0.0, 2.0, None, self.W, self.H))

    def test_render_tile_size(self):
        frame = np.full((self.H, self.W, 3), 128, np.uint8)
        crop = crop_box(self.FRAMES, (0, 1), 1.0, 2.0, None, self.W, self.H)
        self.assertEqual(render_tile(frame, crop, 1.0).shape, (TILE_H, TILE_W, 3))
        # ペア不明はフレーム全体を高さ TILE_H で
        self.assertEqual(render_tile(frame, None, 1.0).shape[0], TILE_H)
        tiles = [render_tile(frame, crop, t) for t in (1.0, 1.5)]
        self.assertEqual(strip_of(tiles).shape[0], 360)


class BeatIntervalTest(unittest.TestCase):
    def test_routine_bpm_first(self):
        self.assertAlmostEqual(beat_interval({"bpm": 96}, {"beatGrid": {"beatIntervalSec": 0.3}}), 0.625)

    def test_beat_grid_fallback(self):
        self.assertAlmostEqual(beat_interval({"bpm": None}, {"beatGrid": {"beatIntervalSec": 0.33}}), 0.33)
        self.assertAlmostEqual(beat_interval({}, {"beatGrid": {"bpm": 120}}), 0.5)

    def test_default_when_unknown(self):
        self.assertAlmostEqual(beat_interval({"bpm": 0}, {"beatGrid": None}), DEFAULT_BEAT_SEC)
        self.assertAlmostEqual(beat_interval(None, None), DEFAULT_BEAT_SEC)


class MoveWindowsTest(unittest.TestCase):
    def test_gap_free_routine_uses_next_start(self):
        moves = [{"start": 0.0, "counts": 8}, {"start": 2.5, "counts": 8}, {"start": 5.0, "counts": 16}]
        w = move_windows(moves, 0.5)
        self.assertEqual(w[0], (0.0, 2.5))
        self.assertEqual(w[1], (2.5, 5.0))
        # 最後の技は counts × 拍間隔
        self.assertEqual(w[2], (5.0, 13.0))

    def test_last_move_clamped_to_duration_and_max(self):
        w = move_windows([{"start": 10.0, "counts": 64}], 0.5, duration=30.0)
        self.assertEqual(w[0], (10.0, 10.0 + MAX_SPAN_SEC))
        w = move_windows([{"start": 10.0, "counts": 8}], 0.5, duration=12.0)
        self.assertEqual(w[0], (10.0, 12.0))

    def test_min_span_when_next_is_too_close(self):
        w = move_windows([{"start": 3.0}, {"start": 3.2}], 0.5)
        self.assertEqual(w[0], (3.0, 3.0 + MIN_SPAN_SEC))

    def test_missing_or_out_of_range_start(self):
        moves = [{"counts": 8}, {"start": 4.0}, {"start": 50.0}]
        w = move_windows(moves, 0.5, duration=20.0)
        self.assertIsNone(w[0])
        self.assertEqual(w[1], (4.0, 8.0))  # counts 省略 → 8拍
        self.assertIsNone(w[2])

    def test_unordered_start_skips_to_next_later_move(self):
        moves = [{"start": 5.0}, {"start": 4.0}, {"start": 7.0}]
        w = move_windows(moves, 0.5)
        self.assertEqual(w[0], (5.0, 7.0))


class FrameTimesTest(unittest.TestCase):
    def test_five_frames_for_one_eight(self):
        t = frame_times(0.0, 2.05, 8)
        self.assertEqual(len(t), 5)
        self.assertAlmostEqual(t[0], 0.0)
        self.assertAlmostEqual(t[-1], 2.0)

    def test_six_frames_for_longer_moves(self):
        self.assertEqual(len(frame_times(0.0, 6.0, 16)), 6)


if __name__ == "__main__":
    unittest.main()
