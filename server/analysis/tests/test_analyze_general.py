"""
analyze_general の純粋な関数（追跡・ピーク選び・キーフレームの時刻選び・動きの大きさ）の単体テスト。
実行: python -m pytest server/analysis/tests/test_analyze_general.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_general as ag  # noqa: E402


def box(cx, cy, w=0.1, h=0.3):
    return {"bbox": [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]}


class TrackTest(unittest.TestCase):
    def test_same_person_keeps_id(self):
        tracks, nid = {}, 0
        ids, nid = ag.assign_tracks(tracks, [box(0.3, 0.5), box(0.7, 0.5)], 0, nid)
        self.assertEqual(ids, [0, 1])
        ids2, nid = ag.assign_tracks(tracks, [box(0.32, 0.5), box(0.69, 0.5)], 1, nid)
        self.assertEqual(ids2, [0, 1])
        self.assertEqual(nid, 2)

    def test_order_of_detections_does_not_matter(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [box(0.3, 0.5), box(0.7, 0.5)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [box(0.7, 0.5), box(0.3, 0.5)], 1, nid)
        self.assertEqual(ids, [1, 0])

    def test_far_detection_becomes_new_person(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [box(0.1, 0.5)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [box(0.9, 0.5)], 1, nid)
        self.assertEqual(ids, [1])

    def test_lost_person_returns_within_gap(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [box(0.5, 0.5)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [box(0.52, 0.5)], 3, nid)  # 2 コマ見えなかった
        self.assertEqual(ids, [0])

    def test_lost_person_expires_after_gap(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [box(0.5, 0.5)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [box(0.5, 0.5)], ag.TRACK_MAX_GAP + 2, nid)
        self.assertEqual(ids, [1])

    def test_one_track_is_not_shared(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [box(0.5, 0.5)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [box(0.5, 0.5), box(0.55, 0.5)], 1, nid)
        self.assertEqual(sorted(ids), [0, 1])


class PeakTest(unittest.TestCase):
    def test_picks_largest_local_maxima_apart(self):
        times = [i * 0.1 for i in range(100)]
        values = [0.0] * 100
        values[20], values[21] = 5.0, 4.9   # 同じ山（近い）
        values[60] = 3.0
        values[90] = 1.0
        peaks = ag.pick_peaks(times, values, 2, min_gap=1.0)
        self.assertEqual([round(t, 1) for t, _ in peaks], [2.0, 6.0])

    def test_sorted_by_time_and_limited(self):
        times = [float(i) for i in range(10)]
        values = [0, 3, 0, 5, 0, 1, 0, 4, 0, 2]
        peaks = ag.pick_peaks(times, values, 3, min_gap=1.0)
        self.assertEqual([t for t, _ in peaks], [1.0, 3.0, 7.0])

    def test_flat_or_empty(self):
        self.assertEqual(ag.pick_peaks([], [], 3), [])
        self.assertEqual(ag.pick_peaks([0, 1, 2], [0, 0, 0], 3), [])


class KeyframeTimesTest(unittest.TestCase):
    def test_at_most_max_and_sorted_and_spaced(self):
        times = [i * 0.1 for i in range(600)]
        values = [0.0] * 600
        for i in (50, 150, 250, 350, 450, 550):
            values[i] = 5.0
        picks = ag.select_keyframe_times(60.0, times, values)
        ts = [t for t, _ in picks]
        self.assertLessEqual(len(ts), ag.MAX_KEYFRAMES)
        self.assertEqual(ts, sorted(ts))
        for a, b in zip(ts, ts[1:]):
            self.assertGreaterEqual(b - a, ag.KEYFRAME_MIN_GAP - 1e-6)
        kinds = {r for _, r in picks}
        self.assertEqual(kinds, {"peak", "even"})

    def test_no_motion_gives_even_only(self):
        picks = ag.select_keyframe_times(30.0, [0.0, 1.0], [0.0, 0.0])
        self.assertEqual({r for _, r in picks}, {"even"})
        self.assertEqual(len(picks), ag.MAX_KEYFRAMES)

    def test_short_video_fewer_frames(self):
        picks = ag.select_keyframe_times(3.0, [0.0, 1.0, 2.0], [0.0, 0.0, 0.0])
        self.assertLessEqual(len(picks), 4)
        self.assertGreaterEqual(len(picks), 1)
        for t, _ in picks:
            self.assertTrue(0 <= t <= 3.0)

    def test_empty_duration(self):
        self.assertEqual(ag.select_keyframe_times(0.0, [], []), [])


def pose(dx=0.0, dy=0.0):
    pts = [[0.5, 0.2, 0.9]] * 17
    pts = [list(p) for p in pts]
    pts[5], pts[6] = [0.45, 0.4, 0.9], [0.55, 0.4, 0.9]
    pts[11], pts[12] = [0.46, 0.7, 0.9], [0.54, 0.7, 0.9]
    return [[x + dx, y + dy, c] for x, y, c in pts]


class SpeedTest(unittest.TestCase):
    def test_still_is_zero(self):
        self.assertAlmostEqual(ag.person_speed(pose(), pose(), 0.1), 0.0)

    def test_torso_length_per_second(self):
        # 胴 0.3、全点が 0.03 動く（0.1 秒）→ 0.03 / 0.3 / 0.1 = 1.0
        self.assertAlmostEqual(ag.person_speed(pose(), pose(dy=0.03), 0.1), 1.0, places=3)

    def test_low_confidence_points_ignored(self):
        cur = pose(dy=0.03)
        for i in range(17):
            cur[i][2] = 0.1
        self.assertIsNone(ag.person_speed(pose(), cur, 0.1))

    def test_bad_dt(self):
        self.assertIsNone(ag.person_speed(pose(), pose(), 0))

    def test_smooth_keeps_length_and_flattens(self):
        out = ag.smooth([0, 0, 9, 0, 0], 3)
        self.assertEqual(len(out), 5)
        self.assertAlmostEqual(out[2], 3.0)


if __name__ == "__main__":
    unittest.main()
