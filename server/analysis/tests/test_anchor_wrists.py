"""
analyze_pair._anchored_wrists（読みやすいコマで左右を決め、手首の連続性でつなぐ）と leaderDecision の単体テスト。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402


def _kps(face_conf, shoulder_conf=0.9, wrist_conf=0.9):
    k = [[0.0, 0.0, 0.0] for _ in range(17)]
    for i in (0, 1, 2):
        k[i][2] = face_conf
    for i in (5, 6):
        k[i] = [0.5, 0.4, shoulder_conf]
    for i in (9, 10):
        k[i][2] = wrist_conf
    return k


def _frame(i, raw_l, raw_r, readable):
    p = {"pid": 0, "bbox": [0.2, 0.2, 0.6, 0.8], "wrists": {"L": raw_l, "R": raw_r},
         "kps": _kps(0.9 if readable else 0.1, wrist_conf=0.9)}
    if not readable:
        p["kps"][5][2] = 0.1   # 肩が見えない → アンカーにならない
    return {"t": i * 0.1, "kept": [p]}


class AnchoredWristsTest(unittest.TestCase):
    def test_labels_follow_continuity_when_coco_labels_flip(self):
        # 正面向きのアンカー（画面左の手 = 本人の右手）のあと、COCO の L/R が入れ替わったまま手が連続して動く
        frames = [_frame(0, (0.60, 0.50), (0.40, 0.50), True)]
        for i, x in enumerate((0.41, 0.42, 0.43), start=1):
            frames.append(_frame(i, (x, 0.50), (x + 0.20, 0.50), False))   # COCO の L が左側にある（入れ替わり）
        frames.append(_frame(4, (0.64, 0.50), (0.44, 0.50), True))          # アンカー: 本人の L が右側の点
        out = ap._anchored_wrists(frames, 0)
        for i in (1, 2, 3):
            self.assertIsNotNone(out[i])
            self.assertGreater(out[i]["L"][0], out[i]["R"][0])   # 本人の左手は画面の右側の点のまま（連続性）
        self.assertEqual(out[0]["L"], (0.60, 0.50))

    def test_frames_far_from_anchor_are_not_labeled(self):
        frames = [_frame(0, (0.60, 0.50), (0.40, 0.50), True)]
        frames += [_frame(i, (0.60, 0.50), (0.40, 0.50), False) for i in range(1, 30)]   # アンカーから 2.9 秒
        out = ap._anchored_wrists(frames, 0)
        self.assertIsNotNone(out[5])
        self.assertIsNone(out[29])

    def test_no_anchor_means_no_labels(self):
        frames = [_frame(i, (0.60, 0.50), (0.40, 0.50), False) for i in range(5)]
        self.assertEqual(ap._anchored_wrists(frames, 0), [None] * 5)


if __name__ == "__main__":
    unittest.main()
