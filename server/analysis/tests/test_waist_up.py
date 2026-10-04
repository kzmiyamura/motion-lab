"""
README 29 の単体テスト（YOLO は回さない）: 腰から上の寄りの動画で、腰が画面の下に切れている人を肩だけで計測する
（measure_person の WAIST_UP_FALLBACK）と、その人を使う下流（重複の判定・部位の色・リーダーの投票・CBL・通る側）。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

W, H = 800, 466  # cap1790 と同じ横長
RNG = np.random.default_rng(0)


def raw_person(cx, sy, sw, hip_y=None, hip_conf=0.9, nose=True, bottom=None, top=None):
    """px 座標の 1 人分（YOLO の生の出力の形）: (box_xyxyn, kps_xy, kps_conf)。
    cx = 肩の中点 x、sy = 肩の y、sw = 肩幅、hip_y = 腰の y（None なら肩から 1.61 肩幅下）"""
    xy = np.zeros((17, 2), dtype=float)
    conf = np.full(17, 0.05)
    xy[ap.LEFT_SHOULDER] = (cx + sw / 2, sy)
    xy[ap.RIGHT_SHOULDER] = (cx - sw / 2, sy)
    conf[[ap.LEFT_SHOULDER, ap.RIGHT_SHOULDER]] = 0.9
    hy = sy + 1.61 * sw if hip_y is None else hip_y
    xy[ap.LEFT_HIP] = (cx + sw / 3, hy)
    xy[ap.RIGHT_HIP] = (cx - sw / 3, hy)
    conf[[ap.LEFT_HIP, ap.RIGHT_HIP]] = hip_conf
    if nose:
        xy[0] = (cx, sy - 0.45 * sw)
        conf[0] = 0.9
    y0 = (sy - 0.8 * sw) / H if top is None else top
    y1 = bottom if bottom is not None else min(1.0, (hy + 2.0 * sw) / H)
    box = np.array([(cx - sw) / W, y0, (cx + sw) / W, y1])
    return box, xy, conf


def measure(cx, sy, sw, **kw):
    box, xy, conf = raw_person(cx, sy, sw, **kw)
    return ap.measure_person(box, xy, conf, 0.9, W, H)


class MeasurePersonTest(unittest.TestCase):
    def setUp(self):
        self.saved = ap.WAIST_UP_FALLBACK

    def tearDown(self):
        ap.WAIST_UP_FALLBACK = self.saved

    def test_full_body_is_unchanged(self):
        m = measure(400, 100, 60, hip_y=200)
        self.assertAlmostEqual(m["hipX"], 0.5)
        self.assertAlmostEqual(m["hipY"], round(200 / H, 4))
        self.assertAlmostEqual(m["shr2d"], round(60 / 40, 4))
        self.assertNotIn("torso", m)
        self.assertFalse(ap.shoulders_only(m))

    def test_waist_up_person_is_measured_from_shoulders(self):
        # 肩は画面の 0.82、腰は画面の外（低信頼）、bbox は画面の下端まで
        m = measure(300, 380, 80, hip_conf=0.1, bottom=1.0)
        self.assertIsNotNone(m)
        self.assertTrue(ap.shoulders_only(m))
        self.assertIsNone(m["shr2d"])
        self.assertAlmostEqual(m["hipX"], round(300 / W, 4))  # 肩の中点
        torso = max(80 * ap.SHOULDER_TORSO_RATIO, 0.45 * 80 * ap.NECK_TORSO_RATIO)
        self.assertAlmostEqual(m["torsoN"], round(torso / H, 4))
        self.assertAlmostEqual(m["hipY"], round((380 + torso) / H, 4))  # 胴は真下
        self.assertGreater(m["hipY"], 1.0)
        self.assertAlmostEqual(m["shDx"], round(80 / W, 4))  # ターンの向き（肩の並び）はそのまま

    def test_occluded_hips_in_full_body_video_are_still_dropped(self):
        # 全身が映る動画で腰が隠れた（重なり）人: bbox は画面の下端まで届かない
        self.assertIsNone(measure(300, 100, 60, hip_conf=0.1))

    def test_hips_inside_frame_are_not_guessed(self):
        # bbox は下端に接しているが、肩が高く、推した腰は画面の中（腰は隠れているだけ）
        self.assertIsNone(measure(300, 60, 50, hip_conf=0.1, bottom=1.0))

    def test_profile_uses_neck_length(self):
        # 横向きで肩幅が縮んでも、鼻〜肩の中点から胴の長さを推す
        box, xy, conf = raw_person(300, 380, 80, hip_conf=0.1, bottom=1.0)
        xy[ap.LEFT_SHOULDER] = (305, 380)
        xy[ap.RIGHT_SHOULDER] = (295, 380)
        est = ap.shoulder_torso_px(xy, conf)
        self.assertAlmostEqual(est, 0.45 * 80 * ap.NECK_TORSO_RATIO, places=3)
        conf[0] = 0.1  # 鼻が読めなければ肩幅だけ
        self.assertAlmostEqual(ap.shoulder_torso_px(xy, conf), 10 * ap.SHOULDER_TORSO_RATIO, places=3)

    def test_switch_off(self):
        ap.WAIST_UP_FALLBACK = False
        self.assertIsNone(measure(300, 380, 80, hip_conf=0.1, bottom=1.0))

    def test_low_shoulders_are_dropped(self):
        box, xy, conf = raw_person(300, 380, 80, bottom=1.0)
        conf[ap.LEFT_SHOULDER] = 0.1
        self.assertIsNone(ap.measure_person(box, xy, conf, 0.9, W, H))


def kept(cx, sy, sw, pid, hist, **kw):
    """measure_person の結果を draw_frames の kept の形に（kps は正規化 + conf）"""
    box, xy, conf = raw_person(cx, sy, sw, **kw)
    m = ap.measure_person(box, xy, conf, 0.9, W, H)
    m["kps"] = [(float(xy[k][0]) / W, float(xy[k][1]) / H, float(conf[k])) for k in range(17)]
    m["pid"] = pid
    m["hist"] = (np.array(hist, dtype=float) + RNG.uniform(0, 0.05, len(hist))).astype(np.float32)
    m["app"] = None
    return m


def waist_up_frames(cross_at=2.0, n=60):
    """男（pid 0、肩幅 110、頭が高い）と女性（pid 1、肩幅 90）が腰から上で映り、cross_at 秒に左右が入れ替わる"""
    out = []
    for i in range(n):
        t = round(i / 10, 2)
        lx, fx = (250, 550) if t < cross_at else (550, 250)
        out.append({"t": t, "kept": [
            kept(lx, 345, 110, 0, [1, 0, 0.5, 0.2], hip_conf=0.05, bottom=1.0, top=0.45),
            kept(fx, 370, 90, 1, [0, 1, 0.2, 0.5], hip_conf=0.05, bottom=1.0, top=0.60)]})
    return out


class DownstreamTest(unittest.TestCase):
    def test_frames_are_shoulders_only(self):
        f = waist_up_frames()
        self.assertTrue(all(ap.shoulders_only(p) for df in f for p in df["kept"]))

    def test_cbl_from_shoulder_midpoints(self):
        events = ap.detect_events(waist_up_frames(), 0)
        cbl = [e for e in events if e["type"] == "CBL"]
        self.assertEqual(len(cbl), 1)
        self.assertAlmostEqual(cbl[0]["tCross"], 2.0)
        self.assertEqual(cbl[0]["pass"]["followerFrom"], "right")

    def test_pass_depth_ignores_missing_hips(self):
        # 女性の腰は画面の外で低信頼、男は腰も読める: 腰を数に入れると女性が「隠れた（奥）」に見える
        f = waist_up_frames()
        for df in f:
            for p in df["kept"]:
                if p["pid"] == 0:
                    p["kps"][ap.LEFT_HIP] = (p["kps"][ap.LEFT_HIP][0], p["kps"][ap.LEFT_HIP][1], 0.95)
                    p["kps"][ap.RIGHT_HIP] = (p["kps"][ap.RIGHT_HIP][0], p["kps"][ap.RIGHT_HIP][1], 0.95)
        follower, leader = f[20]["kept"][1], f[20]["kept"][0]
        self.assertLess(ap._kp_visibility(follower), ap._kp_visibility(leader))
        self.assertAlmostEqual(ap._kp_visibility(follower, False), ap._kp_visibility(leader, False))
        self.assertEqual(ap.detect_pass_side(f, 2.0, 0)["followerDepth"], "unknown")

    def test_leader_vote_without_shr(self):
        # SHR が無くても、見えている背丈と肩幅で男（pid 0）を選ぶ
        self.assertEqual(ap.assign_appearance_ids(waist_up_frames()), 0)

    def test_torso_distance_with_shoulders_only(self):
        a = kept(300, 380, 80, 0, [1, 0, 0.5, 0.2], hip_conf=0.05, bottom=1.0)
        b = kept(304, 382, 80, 1, [1, 0, 0.5, 0.2], hip_conf=0.05, bottom=1.0)
        c = kept(420, 380, 80, 1, [1, 0, 0.5, 0.2], hip_conf=0.05, bottom=1.0)
        self.assertLess(ap.torso_distance(a, b, W / H), ap.DEDUP_TORSO)
        self.assertGreater(ap.torso_distance(a, c, W / H), ap.DEDUP_TORSO)

    def test_appearance_regions_skip_legs(self):
        frame = np.zeros((H, W, 3), dtype=np.uint8)
        p = kept(300, 380, 80, 0, [1, 0, 0.5, 0.2], hip_conf=0.05, bottom=1.0)
        app = ap.appearance_regions(frame, p, W / H)
        self.assertIsNotNone(app["upper"])
        self.assertIsNone(app["lower"])
        self.assertIsNone(app["shin"])
        self.assertIsNone(app["torsoLen"])
        p["app"] = app
        g = ap._identity_geom(p)
        self.assertTrue(np.isnan(g[1]) and np.isnan(g[3]))


if __name__ == "__main__":
    unittest.main()
