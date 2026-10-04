"""
refine_turns_dense（全フレームの取り直し）の 2 つの門（docs/salsa-knowledge/README.md 30）の単体テスト

- 体の大きさの門（DENSE_SIZE_RATIO）: 全画面の YOLO で拾った人の胴の長さが、10fps の追跡でのその人の胴の長さ（中央値）と
  大きく違えば別人（寄りの動画の手前に座った見学者など）として使わない
- 範囲の門（DENSE_OVERLAP_SEC）: 全フレームで読めた反転が 10fps の回転の範囲と重ならなければ、spin・範囲を書き換えない

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402
from frame_time import FrameClock  # noqa: E402


def kps_body(sh_y, hip_y, conf=0.9):
    """肩の高さ sh_y・腰の高さ hip_y の 17 点（正規化）"""
    k = [(0.5, 0.1, conf)] * 17
    k = list(k)
    k[ap.LEFT_SHOULDER] = (0.45, sh_y, conf)
    k[ap.RIGHT_SHOULDER] = (0.55, sh_y, conf)
    k[ap.LEFT_HIP] = (0.47, hip_y, conf)
    k[ap.RIGHT_HIP] = (0.53, hip_y, conf)
    return k


class TorsoTest(unittest.TestCase):
    def test_torso_from_kps_and_shoulders_only(self):
        self.assertAlmostEqual(ap.torso_height({"kps": kps_body(0.3, 0.5)}), 0.2, places=6)
        self.assertEqual(ap.torso_height({"torsoN": 0.6, "kps": kps_body(0.3, 0.5)}), 0.6)
        low = kps_body(0.3, 0.5)
        low[ap.LEFT_HIP] = (0.47, 0.5, 0.1)
        self.assertIsNone(ap.torso_height({"kps": low}))
        self.assertIsNone(ap.torso_height({}))

    def test_track_median(self):
        frames = [{"t": k / 10, "kept": [{"pid": 0, "torsoN": v}, {"pid": 1, "torsoN": 0.9}]}
                  for k, v in enumerate([0.5, 0.6, 0.55, 0.2, 0.58])]
        self.assertEqual(ap.track_torso_median(frames, 0), 0.55)
        self.assertIsNone(ap.track_torso_median([{"t": 0, "kept": [{"pid": 0}]}], 0))

    def test_same_body_size(self):
        self.assertTrue(ap.same_body_size({"torsoN": 0.5}, 0.55))
        self.assertFalse(ap.same_body_size({"torsoN": 0.28}, 0.55))   # 手前に座った見学者（cap1790 16.6）
        self.assertFalse(ap.same_body_size({"torsoN": 1.0}, 0.55))
        self.assertTrue(ap.same_body_size({}, 0.55))                  # 胴が読めない人は門を通す（従来どおり）
        self.assertTrue(ap.same_body_size({"torsoN": 0.28}, None))
        orig = ap.DENSE_SIZE_RATIO
        ap.DENSE_SIZE_RATIO = 0
        try:
            self.assertTrue(ap.same_body_size({"torsoN": 0.28}, 0.55))
        finally:
            ap.DENSE_SIZE_RATIO = orig


class FakeCap:
    def __init__(self, path):
        self.t = 0.0

    def isOpened(self):
        return True

    def set(self, prop, ms):
        self.t = ms / 1000

    def get(self, prop):
        return self.t * 1000

    def read(self):
        self.t += 1 / 30
        return (self.t < 10.0), object()

    def release(self):
        pass


def run_dense(detect, events, frames=None):
    caps = []

    def make_cap(path):
        c = FakeCap(path)
        caps.append(c)
        return c

    def fake_detect(model, frame):
        return detect(caps[-1].t)

    orig = (ap.cv2.VideoCapture, ap.detect_persons, ap.face_side)
    ap.cv2.VideoCapture, ap.detect_persons, ap.face_side = make_cap, fake_detect, (lambda p: 1)
    try:
        frames = frames or [{"t": k / 10, "kept": [{"pid": 0, "bbox": [0.4, 0.2, 0.6, 0.9], "torsoN": 0.55},
                                                    {"pid": 1, "bbox": [0.1, 0.2, 0.3, 0.9], "torsoN": 0.6}]}
                            for k in range(100)]
        return ap.refine_turns_dense("x.mp4", None, frames, events, leader_pid=1, clock=FrameClock(30.0))
    finally:
        ap.cv2.VideoCapture, ap.detect_persons, ap.face_side = orig


def turn(t, frm, to):
    e = {"t": t, "type": "Turn", "by": "follower", "rotations": 1, "spin": {"seq": "LL", "netDeg": -360}}
    return ap.set_turn_span(e, frm, to, source="flips10fps")


def flipping(t, period=0.2):
    return 1 if int(t / period) % 2 == 0 else -1


class SizeGateTest(unittest.TestCase):
    def test_spectator_is_not_read(self):
        # 女性は 2.0〜3.0 秒は向きを変えずに立っていて、同じ所に胴の半分の大きさの見学者が見えて肩を揺らしている
        def detect(t):
            return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * flipping(t), "torsoN": 0.28},
                    {"bbox": [0.41, 0.2, 0.61, 0.9], "shDx": 0.1, "torsoN": 0.55}]
        (e,) = run_dense(detect, [turn(2.0, 2.0, 2.4)])
        self.assertNotEqual((e["spin"] or {}).get("source"), "fullFrames")
        self.assertEqual(e["tMid"], 2.2)

    def test_gate_off_reads_spectator(self):
        def detect(t):
            return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * flipping(t), "torsoN": 0.28}]
        orig = ap.DENSE_SIZE_RATIO
        ap.DENSE_SIZE_RATIO = 0
        try:
            (e,) = run_dense(detect, [turn(2.0, 2.0, 2.4)])
        finally:
            ap.DENSE_SIZE_RATIO = orig
        self.assertEqual(e["spin"]["source"], "fullFrames")

    def test_same_size_dancer_is_read(self):
        def detect(t):
            return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * flipping(t), "torsoN": 0.5}]
        (e,) = run_dense(detect, [turn(2.0, 2.0, 2.4)])
        self.assertEqual(e["spin"]["source"], "fullFrames")


class OverlapGateTest(unittest.TestCase):
    def test_flips_after_the_coarse_span_are_dropped(self):
        # 10fps の回転は 2.0〜2.4。全フレームでは本人を見失い、2.7 秒からの別の動きの反転だけが読めた
        def detect(t):
            if t < 2.7:
                return []
            return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * flipping(t), "torsoN": 0.55}]
        later = turn(3.3, 3.3, 3.6)
        e, e2 = run_dense(detect, [turn(2.0, 2.0, 2.4), later])
        self.assertEqual(e["span"]["source"], "flips10fps")
        self.assertEqual(e["tMid"], 2.2)
        self.assertNotIn("absorbed", e)
        self.assertEqual(e2["spin"]["source"], "fullFrames")   # 後のターンは自分の範囲で取り直される

    def test_overlapping_flips_rewrite_span(self):
        def detect(t):
            return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * flipping(t), "torsoN": 0.55}]
        (e,) = run_dense(detect, [turn(2.0, 2.0, 2.4)])
        self.assertEqual(e["span"]["source"], "fullFrames")

    def test_gate_off(self):
        def detect(t):
            if t < 2.7:
                return []
            return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * flipping(t), "torsoN": 0.55}]
        orig = ap.DENSE_OVERLAP_SEC
        ap.DENSE_OVERLAP_SEC = None
        try:
            (e,) = run_dense(detect, [turn(2.0, 2.0, 2.4)])
        finally:
            ap.DENSE_OVERLAP_SEC = orig
        self.assertEqual(e["span"]["source"], "fullFrames")
        self.assertGreater(e["tMid"], 2.7)


class SplitAtNextTest(unittest.TestCase):
    """回り続けて見えても、10fps が分けた同じ人の次のターンは飲み込まない（DENSE_SPLIT_AT_NEXT）"""

    @staticmethod
    def detect(t):
        return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * flipping(t), "torsoN": 0.55}]

    def test_next_turn_is_kept(self):
        e, e2 = run_dense(self.detect, [turn(2.0, 2.0, 2.4), turn(3.3, 3.3, 3.6)])
        self.assertNotIn("absorbed", e)
        self.assertLess(e["span"]["to"], 3.3 - ap.SPIN_SPAN_FRAME_SEC + 1e-6)
        self.assertEqual(e2["spin"]["source"], "fullFrames")
        self.assertGreaterEqual(e2["span"]["from"], 2.8)

    def test_other_person_does_not_split(self):
        leader = dict(turn(3.3, 3.3, 3.6), by="leader")
        e, _ = run_dense(self.detect, [turn(2.0, 2.0, 2.4), leader])
        self.assertGreater(e["span"]["to"], 3.3)

    def test_split_off_absorbs(self):
        orig = ap.DENSE_SPLIT_AT_NEXT
        ap.DENSE_SPLIT_AT_NEXT = False
        try:
            (e,) = run_dense(self.detect, [turn(2.0, 2.0, 2.4), turn(3.3, 3.3, 3.6)])
        finally:
            ap.DENSE_SPLIT_AT_NEXT = orig
        self.assertEqual(e["absorbed"], [3.3])


if __name__ == "__main__":
    unittest.main()
