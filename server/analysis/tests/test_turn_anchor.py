"""
ターンの回転の範囲（span）と真ん中（tMid）・採点の照合の時刻（eval_ground_truth の TURN_MATCH）の単体テスト（README 28）。
YOLO は回さない。

実行: python -m pytest server/analysis/tests
"""
import glob
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import analyze_pair as ap  # noqa: E402
import eval_ground_truth as eg  # noqa: E402

FRONT, BACK = 0.15, -0.15


def kps(face):
    """face = +1: 顔が画面右（鼻が耳より右）、-1: 画面左"""
    k = [[0.5, 0.5, 0.9] for _ in range(17)]
    k[3] = [0.5, 0.2, 0.9]
    k[4] = [0.5, 0.2, 0.9]
    k[0] = [0.5 + 0.03 * face, 0.2, 0.9]
    return k


def pair_frames(segments, fps=10):
    """女性（pid 1）が segments どおりに回り、男（pid 0）は画面左で正面を向いて立っている 10fps の draw_frames"""
    out, t = [], 0.0
    for dur, d, face in segments:
        for _ in range(int(round(dur * fps))):
            out.append({"t": round(t, 2), "kept": [
                {"pid": 1, "shDx": d, "kps": kps(face), "hipX": 0.7, "bbox": [0.6, 0.0, 0.9, 1.0],
                 "wrists": {"L": None, "R": None}},
                {"pid": 0, "shDx": FRONT, "kps": kps(1), "hipX": 0.2, "bbox": [0.0, 0.0, 0.3, 1.0],
                 "wrists": {"L": None, "R": None}}]})
            t += 1 / fps
    return out


# 1.0 秒に左回り 1 回（反転 1.0 / 1.3）、2.5 秒から右回りの速い連続回転（反転 5 個 2.5〜3.7 秒）
LEFT_THEN_RIGHT_SPIN = [(1.0, FRONT, 1), (0.3, BACK, -1), (1.2, FRONT, -1),
                        (0.3, BACK, 1), (0.3, FRONT, -1), (0.3, BACK, 1), (0.3, FRONT, -1), (1.5, BACK, 1)]


class TurnSpanTest(unittest.TestCase):
    def test_follower_turn_keeps_start_and_gets_span(self):
        turns = [e for e in ap.detect_events(pair_frames(LEFT_THEN_RIGHT_SPIN), 0)
                 if e["type"] == "Turn" and e["by"] == "follower"]
        self.assertEqual([round(e["t"], 1) for e in turns], [1.0, 2.5])
        for e in turns:
            # t は回り始め（最初の反転）のまま。範囲は最初〜最後の反転、tMid はその真ん中
            self.assertEqual(e["span"]["from"], e["t"])
            self.assertEqual(e["span"]["source"], "flips10fps")
            self.assertAlmostEqual(e["tMid"], (e["span"]["from"] + e["span"]["to"]) / 2, places=2)
        self.assertAlmostEqual(turns[0]["span"]["to"], 1.3, places=1)
        self.assertAlmostEqual(turns[0]["tMid"], 1.15, places=2)
        # 速い連続回転は範囲が長く、真ん中は回り始めより 0.5 秒以上後ろ
        self.assertAlmostEqual(turns[1]["span"]["to"], 3.7, places=1)
        self.assertGreater(turns[1]["tMid"] - turns[1]["t"], 0.5)

    def test_leader_turn_span(self):
        # 右回り 1 回: 正面 → 鼻が画面左（背中への反転 1.1）→ 背中 → 鼻が画面右（正面への反転 1.4）→ 正面
        face_f = [[0.5, 0.2, 0.9], [0, 0, 0], [0, 0, 0], [0.47, 0.2, 0.9], [0.53, 0.2, 0.9]] + [[0.5, 0.3, 0.9]] * 12

        def side(face):
            return [[0.5 + 0.02 * face, 0.2, 0.9], [0, 0, 0], [0, 0, 0], [0.5, 0.2, 0.9], [0.5, 0.2, 0.9]] + [[0.5, 0.3, 0.9]] * 12
        back = [[0.5, 0.2, 0.0]] + [[0.0, 0.0, 0.0]] * 16
        segs = [(1.0, 0.15, face_f), (0.1, 0.03, side(-1)), (0.1, -0.03, side(-1)), (0.2, -0.15, back),
                (0.1, -0.03, side(1)), (0.1, 0.03, side(1)), (1.0, 0.15, face_f)]
        f, t = [], 0.0
        for dur, d, k in segs:
            for _ in range(int(round(dur * 10))):
                f.append({"t": round(t, 2), "kept": [{"pid": 0, "shDx": d, "kps": k}]})
                t += 0.1
        plain = ap.detect_leader_turns(f, 0, [], [])
        spanned = ap.detect_leader_turns(f, 0, [], [], with_span=True)
        self.assertEqual(len(plain), 1)
        self.assertEqual(spanned[0][:3], plain[0])  # with_span は後ろに範囲を足すだけ
        t_mid, _, _, a, b = spanned[0]
        self.assertAlmostEqual(a, 1.1, places=1)
        self.assertAlmostEqual(b, 1.5, places=1)
        self.assertAlmostEqual(t_mid, (a + b) / 2, places=2)

    def test_set_turn_span_ignores_bad_input(self):
        self.assertNotIn("tMid", ap.set_turn_span({"t": 1.0}, None, 2.0, "x"))
        self.assertNotIn("tMid", ap.set_turn_span({"t": 1.0}, 2.0, 1.0, "x"))
        e = ap.set_turn_span({"t": 1.0}, 1.0, 1.0, "fullFrames")
        self.assertEqual(e["tMid"], 1.0)


class TurnMatchTest(unittest.TestCase):
    def setUp(self):
        self.saved = eg.TURN_MATCH

    def tearDown(self):
        eg.TURN_MATCH = self.saved

    def test_turn_mid_fallbacks(self):
        self.assertEqual(eg.turn_mid({"t": 7.35, "tMid": 8.17}), 8.17)
        # 古い出力（tMid 無し）: 全フレームの取り直しの spin.from〜to の真ん中、それも無ければ t
        self.assertAlmostEqual(eg.turn_mid({"t": 7.34, "spin": {"from": 6.95, "to": 8.52}}), 7.735)
        self.assertEqual(eg.turn_mid({"t": 7.34, "spin": {"seq": "RR"}}), 7.34)

    def test_auto_follows_ground_truth_turn_time(self):
        e = {"t": 7.35, "tMid": 8.17}
        self.assertEqual(eg.turn_time_key({"turnTime": "mid"}, "auto")(e), 8.17)
        self.assertEqual(eg.turn_time_key({"turnTime": "start"}, "auto")(e), 7.35)
        self.assertEqual(eg.turn_time_key({}, "auto")(e), 7.35)  # 書いていない正解表は従来どおり t
        self.assertEqual(eg.turn_time_key({"turnTime": "mid"}, "t")(e), 7.35)
        self.assertEqual(eg.turn_time_key({"turnTime": "start"}, "mid")(e), 8.17)

    def test_mid_matching_keeps_the_tolerance(self):
        # bb0efcb9 8.5（7.5〜9.2 の右 2½）: 回り始め 7.35 は ±1.0 の外、真ん中 8.17 は内
        gt = [{"t": 8.5}]
        cv = [{"t": 7.35, "tMid": 8.17}]
        self.assertEqual(eg.match(gt, cv), [])
        self.assertEqual(eg.match(gt, cv, eg.turn_mid), [(0, 0)])
        # 真ん中でも ±1.0 を超えれば対応しない（照合の幅は広げていない）
        self.assertEqual(eg.match([{"t": 9.3}], cv, eg.turn_mid), [])

    def test_ground_truth_files_declare_turn_time(self):
        for p in glob.glob(os.path.join(HERE, "..", "ground_truth", "*.json")):
            gt = json.load(open(p, encoding="utf-8"))
            self.assertIn(gt.get("turnTime"), ("mid", "start"), os.path.basename(p))


if __name__ == "__main__":
    unittest.main()
