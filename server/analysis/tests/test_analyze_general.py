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
        self.assertEqual(len(picks), ag.keyframe_budget(30.0))

    def test_short_video_fewer_frames(self):
        picks = ag.select_keyframe_times(3.0, [0.0, 1.0, 2.0], [0.0, 0.0, 0.0])
        self.assertLessEqual(len(picks), 4)
        self.assertGreaterEqual(len(picks), 1)
        for t, _ in picks:
            self.assertTrue(0 <= t <= 3.0)

    def test_empty_duration(self):
        self.assertEqual(ag.select_keyframe_times(0.0, [], []), [])


RED, BLUE = [1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]
RED_ISH = [0.8, 0.2, 0.0, 0.0]


def cbox(cx, cy, hist, h=0.5, w=0.15, shape=None):
    d = {"bbox": [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], "hist": hist}
    if shape is not None:
        d["shape"] = shape
    return d


class ReidTest(unittest.TestCase):
    def test_lost_for_1_5_seconds_gets_same_id(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.5, 0.5, RED)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [cbox(0.55, 0.5, RED_ISH)], 15, nid)  # 10fps で 1.5 秒後
        self.assertEqual(ids, [0])
        self.assertEqual(nid, 1)

    def test_lost_person_forgotten_after_two_seconds(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.5, 0.5, RED)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [cbox(0.5, 0.5, RED)], ag.TRACK_MAX_GAP + 1, nid)
        self.assertEqual(ids, [1])

    def test_clothes_color_decides_between_two_nearby_people(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.40, 0.5, RED), cbox(0.52, 0.5, BLUE)], 0, nid)
        # 赤い人が隠れ、青い人だけが、赤い人の位置寄りに映った（位置だけなら赤い人の方が近い）
        ids, nid = ag.assign_tracks(tracks, [cbox(0.44, 0.5, BLUE)], 1, nid)
        self.assertEqual(ids, [1])

    def test_very_different_color_is_a_new_person(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.5, 0.5, RED)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [cbox(0.5, 0.5, BLUE)], 1, nid)
        self.assertEqual(ids, [1])

    def test_very_different_size_is_a_new_person(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.5, 0.5, RED, h=0.6)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [cbox(0.5, 0.5, RED, h=0.2)], 1, nid)  # 画面の端の小さい人・鏡の像
        self.assertEqual(ids, [1])

    def test_body_shape_breaks_tie(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.40, 0.5, None, shape=(0.2, 0.3)), cbox(0.50, 0.5, None, shape=(0.4, 0.5))], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [cbox(0.43, 0.5, None, shape=(0.4, 0.5))], 1, nid)
        self.assertEqual(ids, [1])

    def test_consecutive_frames_trust_position_over_similar_clothes(self):
        # 同じ黒い服の 2 人が組んで踊る: 色が似ていて、検出の色がぶれて逆の人寄りに見えても、連続するコマでは位置で付ける
        a, b = [0.5, 0.5, 0.0, 0.0], [0.4, 0.4, 0.1, 0.1]
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.40, 0.5, a), cbox(0.55, 0.5, b)], 0, nid)
        near_b, near_a = [0.42, 0.42, 0.08, 0.08], [0.48, 0.48, 0.02, 0.02]
        ids, nid = ag.assign_tracks(tracks, [cbox(0.41, 0.5, near_b), cbox(0.56, 0.5, near_a)], 1, nid)
        self.assertEqual(ids, [0, 1])

    def test_after_a_long_loss_appearance_counts_fully(self):
        a, b = [0.5, 0.5, 0.0, 0.0], [0.4, 0.4, 0.1, 0.1]
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [cbox(0.40, 0.5, a), cbox(0.55, 0.5, b)], 0, nid)
        near_b, near_a = [0.42, 0.42, 0.08, 0.08], [0.48, 0.48, 0.02, 0.02]
        ids, nid = ag.assign_tracks(tracks, [cbox(0.41, 0.5, near_b), cbox(0.56, 0.5, near_a)], 8, nid)
        self.assertEqual(ids, [1, 0])

    def test_works_without_color_or_shape(self):
        tracks, nid = {}, 0
        _, nid = ag.assign_tracks(tracks, [box(0.5, 0.5)], 0, nid)
        ids, nid = ag.assign_tracks(tracks, [box(0.52, 0.5)], 10, nid)
        self.assertEqual(ids, [0])


def rows(frames, cx, hist, h=0.6):
    return [{"f": f, "center": (cx, 0.5), "h": h, "hist": hist, "shape": (0.3, 0.4)} for f in frames]


class StitchTest(unittest.TestCase):
    def test_fragments_of_same_person_are_merged(self):
        feats = {0: rows(range(0, 50), 0.4, RED), 5: rows(range(80, 120), 0.45, RED_ISH)}  # 3 秒の途切れ
        mp = ag.stitch_tracklets(feats)
        self.assertEqual(mp[0], mp[5])

    def test_simultaneous_people_never_merge(self):
        feats = {0: rows(range(0, 100), 0.4, RED), 1: rows(range(0, 100), 0.45, RED)}
        mp = ag.stitch_tracklets(feats)
        self.assertNotEqual(mp[0], mp[1])

    def test_different_clothes_not_merged(self):
        feats = {0: rows(range(0, 50), 0.4, RED), 1: rows(range(60, 100), 0.4, BLUE)}
        mp = ag.stitch_tracklets(feats)
        self.assertNotEqual(mp[0], mp[1])

    def test_long_gap_not_merged(self):
        feats = {0: rows(range(0, 20), 0.4, RED), 1: rows(range(200, 240), 0.4, RED)}
        mp = ag.stitch_tracklets(feats)
        self.assertNotEqual(mp[0], mp[1])

    def test_chain_of_three_fragments(self):
        feats = {0: rows(range(0, 30), 0.4, RED), 3: rows(range(40, 70), 0.42, RED),
                 7: rows(range(80, 110), 0.44, RED_ISH)}
        mp = ag.stitch_tracklets(feats)
        self.assertEqual(len({mp[0], mp[3], mp[7]}), 1)
        self.assertEqual(mp[7], 0)  # 新 id は一番小さい旧 id


class MainPersonsTest(unittest.TestCase):
    def stat(self, pid, frames, h, first=0.0, last=30.0, ts=None):
        return {"id": pid, "frames": frames, "firstT": first, "lastT": last, "meanHeight": h,
                "ts": ts if ts is not None else [first + i * (last - first) / max(1, frames - 1) for i in range(frames)]}

    def test_small_edge_person_and_passersby_are_minor(self):
        stats = [self.stat(0, 280, 0.62), self.stat(1, 300, 0.60), self.stat(2, 120, 0.22), self.stat(3, 2, 0.1)]
        main, minor = ag.summarize_main_persons(stats, 330, 33.0)
        self.assertEqual({m["id"] for m in main}, {0, 1})
        self.assertEqual(set(minor), {2, 3})
        self.assertAlmostEqual(main[0]["coverage"], 300 / 330, places=2)

    def test_gaps_are_reported(self):
        ts = [i * 0.1 for i in range(0, 100)] + [i * 0.1 for i in range(150, 300)]  # 10〜15 秒が見えない
        main, _ = ag.summarize_main_persons([self.stat(0, len(ts), 0.6, 0.0, 29.9, ts)], 300, 30.0)
        gaps = main[0]["gaps"]
        self.assertTrue(any(abs(g["from"] - 9.9) < 0.2 and abs(g["to"] - 15.0) < 0.2 for g in gaps))

    def test_short_lived_big_person_is_not_main(self):
        stats = [self.stat(0, 300, 0.6), self.stat(1, 20, 0.6)]  # 6% しか映っていない
        main, minor = ag.summarize_main_persons(stats, 330, 33.0)
        self.assertEqual([m["id"] for m in main], [0])
        self.assertEqual(minor, [1])

    def test_empty(self):
        self.assertEqual(ag.summarize_main_persons([], 0, 0.0), ([], []))


class MountainKeyframeTest(unittest.TestCase):
    def series(self, duration=30.0, dt=0.1):
        times = [round(i * dt, 2) for i in range(int(duration / dt))]
        return times, [0.2] * len(times)

    def test_budget_scales_with_duration_and_is_capped(self):
        self.assertTrue(16 <= ag.keyframe_budget(30.0) <= 20)
        self.assertLessEqual(ag.keyframe_budget(600.0), 24)
        self.assertLess(ag.keyframe_budget(10.0), ag.keyframe_budget(30.0))
        self.assertEqual(ag.keyframe_budget(0.0), 0)

    def test_every_mountain_gets_a_keyframe(self):
        times, values = self.series()
        tops = [3.0, 8.5, 12.0, 21.0, 22.4, 23.9, 25.1, 26.3, 29.0]  # 22〜27 秒に山が固まっている
        for k, t in enumerate(tops):
            i = times.index(t)
            values[i] = 3.0 + 0.1 * (k % 3)
            values[i - 1] = values[i + 1] = 1.5
        picks = ag.select_keyframe_times(30.0, times, values)
        pts = [t for t, _ in picks]
        for t in tops:
            self.assertTrue(any(abs(t - p) <= 0.6 for p in pts), f"mountain at {t} has no keyframe: {pts}")

    def test_close_mountains_are_merged_into_one_picture(self):
        times, values = self.series()
        for t in (10.0, 10.5, 11.0):  # 0.5 秒おきの 3 つの山
            values[times.index(t)] = 3.0
        picks = [t for t, r in ag.select_keyframe_times(30.0, times, values) if r == "peak" and 9.0 < t < 12.0]
        self.assertEqual(len(picks), 1)

    def test_even_fills_only_quiet_stretches(self):
        times, values = self.series()
        for t in (5.0, 6.5, 8.0, 9.5, 11.0):
            values[times.index(t)] = 3.0
        picks = ag.select_keyframe_times(30.0, times, values)
        evens = [t for t, r in picks if r == "even"]
        self.assertTrue(evens and all(t > 11.5 or t < 4.5 for t in evens))
        self.assertEqual(len(picks), ag.keyframe_budget(30.0))
        ts = [t for t, _ in picks]
        for a, b in zip(ts, ts[1:]):
            self.assertGreaterEqual(b - a, ag.KEYFRAME_MIN_GAP - 1e-6)

    def test_mountains_function(self):
        times = [float(i) for i in range(10)]
        values = [0, 0, 5, 6, 0, 0, 0, 7, 0, 0]
        segs = ag.mountains(times, values)
        self.assertEqual([(a, b, p) for a, b, p, _ in segs], [(2.0, 3.0, 3.0), (7.0, 7.0, 7.0)])
        self.assertEqual(ag.mountains([], []), [])
        self.assertEqual(ag.mountains([0.0, 1.0], [0.0, 0.0]), [])


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
