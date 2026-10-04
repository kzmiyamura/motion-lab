"""
analyze_pair.spin_hint / detect_events の「女性のターンの向きはそのターンの反転だけで読む」（SPIN_USE_TURN_SPAN）の
単体テスト。YOLO は回さない。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

FRONT, BACK = 0.15, -0.15


def kps(face):
    """face = +1: 顔が画面右（鼻が耳より右）、-1: 画面左"""
    k = [[0.5, 0.5, 0.9] for _ in range(17)]
    k[3] = [0.5, 0.2, 0.9]   # 左耳
    k[4] = [0.5, 0.2, 0.9]   # 右耳
    k[0] = [0.5 + 0.03 * face, 0.2, 0.9]
    return k


def frames(segments, pid=1, fps=10):
    """[(秒数, shDx, 顔の向き), ...] を順に並べた 10fps の draw_frames。
    反転の向きは反転直前のコマの顔で決まる: 正面→背中を顔が画面右で跨ぐ = 左回り、画面左 = 右回り。
    背中→正面は逆（顔が画面右 = 右回り）"""
    out, t = [], 0.0
    for dur, d, face in segments:
        for _ in range(int(round(dur * fps))):
            out.append({"t": round(t, 2), "kept": [{"pid": pid, "shDx": d, "kps": kps(face)}]})
            t += 1 / fps
    return out


# 1.0 秒に左回り 1 回（反転 1.0 / 1.3）、2.5 秒から右回りの速い連続回転（反転 5 個、冷却の内側）
LEFT_THEN_RIGHT_SPIN = [(1.0, FRONT, 1), (0.3, BACK, -1), (1.2, FRONT, -1),
                        (0.3, BACK, 1), (0.3, FRONT, -1), (0.3, BACK, 1), (0.3, FRONT, -1), (1.5, BACK, 1)]


class SpinSpanTest(unittest.TestCase):
    def setUp(self):
        self.before = ap.SPIN_USE_TURN_SPAN

    def tearDown(self):
        ap.SPIN_USE_TURN_SPAN = self.before

    def test_window_stops_before_next_turn(self):
        f = frames(LEFT_THEN_RIGHT_SPIN)
        turns = ap.detect_turns(f, 1, with_span="pair")
        self.assertEqual([round(t, 1) for t, _, _, _ in turns], [1.0, 2.5])
        # 単発の反転ペアの範囲は 2 つ目の反転まで
        self.assertEqual([round(turns[0][2], 1), round(turns[0][3], 1)], [1.0, 1.3])
        span = (turns[0][2], turns[0][3], float("-inf"), turns[1][2])
        self.assertEqual(ap.spin_hint(f, 1, turns[0][0], span)["seq"], "LL")
        # 固定窓（-0.4〜+1.6 秒）だと次の右回りの最初の反転まで読む
        self.assertEqual(ap.spin_hint(f, 1, turns[0][0])["seq"], "LLR")

    def test_long_spin_is_read_to_the_end(self):
        # 左 ½ の後に右へ 3½ 回（反転 8 個、1.0〜3.8 秒）。固定窓（+1.6 秒）だと終わりの右回りが切れる
        segs = [(1.0, FRONT, 1), (0.4, BACK, 1)] + [(0.4, FRONT, -1), (0.4, BACK, 1)] * 3 + [(1.0, FRONT, -1)]
        f = frames(segs)
        span = (1.0, 3.8, float("-inf"), float("inf"))
        self.assertEqual(ap.spin_hint(f, 1, 1.0, span)["seq"], "L" + "R" * 7)
        self.assertLess(ap.spin_hint(f, 1, 1.0)["seq"].count("R"), 7)

    def test_detect_events_uses_turn_span(self):
        f = frames(LEFT_THEN_RIGHT_SPIN)
        for df in f:  # 男（pid 0）は画面左で正面を向いて立っている
            df["kept"][0].update({"hipX": 0.7, "bbox": [0.6, 0.0, 0.9, 1.0], "wrists": {"L": None, "R": None}})
            df["kept"].append({"pid": 0, "shDx": FRONT, "hipX": 0.2, "kps": kps(1), "wrists": {"L": None, "R": None},
                               "bbox": [0.0, 0.0, 0.3, 1.0]})

        def follower_seqs():
            return [e["spin"]["seq"] for e in ap.detect_events(f, 0) if e["type"] == "Turn" and e["by"] == "follower"]

        ap.SPIN_USE_TURN_SPAN = True
        self.assertEqual(follower_seqs(), ["LL", "RRRRR"])
        ap.SPIN_USE_TURN_SPAN = False
        self.assertEqual(follower_seqs()[0], "LLR")


if __name__ == "__main__":
    unittest.main()
