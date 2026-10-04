"""
analyze_pair.detect_leader_turns（男のターン: 向きの揃った反転ペアだけ拾う）の単体テスト。YOLO は回さない。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

FRONT, BACK, SIDE = 0.15, -0.15, 0.03


def kps(face):
    """face: -1 = 鼻が画面左、+1 = 鼻が画面右、0 = 正面/背中（読めない）"""
    k = [[0.5, 0.2, 0.0]] + [[0.0, 0.0, 0.0]] * 16
    if face:
        k = [[0.5 + 0.02 * face, 0.2, 0.9], [0, 0, 0], [0, 0, 0], [0.5, 0.2, 0.9], [0.5, 0.2, 0.9]] + [[0.5, 0.3, 0.9]] * 12
    return k


def frames(segments, pid=0, fps=10):
    """[(秒数, shDx, 顔の向き), ...] を順に並べた 10fps の draw_frames"""
    out, t = [], 0.0
    for dur, d, face in segments:
        for _ in range(int(round(dur * fps))):
            out.append({"t": round(t, 2), "kept": [{"pid": pid, "shDx": d, "kps": kps(face)}]})
            t += 1 / fps
    return out


# 右回り: 正面 → 鼻が画面左 → 背中 → 鼻が画面右 → 正面
RIGHT_TURN = [(0.1, SIDE, -1), (0.1, -SIDE, -1), (0.2, BACK, 0), (0.1, -SIDE, 1), (0.1, SIDE, 1)]
# 振り返って同じ側から戻る: 正面 → 鼻が画面左 → 背中 → 鼻が画面左 → 正面
LOOK_BACK = [(0.1, SIDE, -1), (0.1, -SIDE, -1), (0.2, BACK, 0), (0.1, -SIDE, -1), (0.1, SIDE, -1)]


class DetectLeaderTurnsTest(unittest.TestCase):
    def test_right_turn(self):
        f = frames([(1.0, FRONT, 0)] + RIGHT_TURN + [(1.0, FRONT, 0)])
        turns = ap.detect_leader_turns(f, 0, [], [])
        self.assertEqual(len(turns), 1)
        t, rot, spin = turns[0]
        self.assertAlmostEqual(t, 1.3, places=1)
        self.assertEqual(rot, 1)
        self.assertEqual(spin["seq"], "RR")

    def test_look_back_is_not_a_turn(self):
        f = frames([(1.0, FRONT, 0)] + LOOK_BACK + [(1.0, FRONT, 0)])
        self.assertEqual(ap.detect_leader_turns(f, 0, [], []), [])

    def test_turn_next_to_cbl_is_dropped(self):
        f = frames([(1.0, FRONT, 0)] + RIGHT_TURN + [(1.0, FRONT, 0)])
        self.assertEqual(ap.detect_leader_turns(f, 0, [1.5], []), [])

    def test_dropped_turn_does_not_block_the_next(self):
        # CBL の近くで捨てた回転の冷却が、1.4 秒後の本物の回転を塞がない
        f = frames([(1.0, FRONT, 0)] + RIGHT_TURN + [(0.8, FRONT, 0)] + RIGHT_TURN + [(1.0, FRONT, 0)])
        turns = ap.detect_leader_turns(f, 0, [1.3], [])
        self.assertEqual([round(t, 1) for t, _, _ in turns], [2.7])


if __name__ == "__main__":
    unittest.main()
