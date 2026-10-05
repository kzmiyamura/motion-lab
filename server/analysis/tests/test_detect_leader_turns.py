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
F = "F"  # 顔が正面に見える（鼻が両耳の真ん中・信頼度が高い）


def kps(face):
    """face: -1 = 鼻が画面左、+1 = 鼻が画面右、F = 正面の顔、0 = 背中（鼻が見えない）"""
    k = [[0.5, 0.2, 0.0]] + [[0.0, 0.0, 0.0]] * 16
    if face == F:
        k = [[0.5, 0.2, 0.9], [0, 0, 0], [0, 0, 0], [0.47, 0.2, 0.9], [0.53, 0.2, 0.9]] + [[0.5, 0.3, 0.9]] * 12
    elif face:
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
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        turns = ap.detect_leader_turns(f, 0, [], [])
        self.assertEqual(len(turns), 1)
        t, rot, spin = turns[0]
        self.assertAlmostEqual(t, 1.3, places=1)
        self.assertEqual(rot, 1)
        self.assertEqual(spin["seq"], "RR")

    def test_look_back_is_not_a_turn(self):
        f = frames([(1.0, FRONT, F)] + LOOK_BACK + [(1.0, FRONT, F)])
        self.assertEqual(ap.detect_leader_turns(f, 0, [], []), [])

    def test_turn_next_to_cbl_is_dropped(self):
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        self.assertEqual(ap.detect_leader_turns(f, 0, [1.5], []), [])

    def test_dropped_turn_does_not_block_the_next(self):
        # CBL の近くで捨てた回転の冷却が、1.4 秒後の本物の回転を塞がない
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(0.8, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        turns = ap.detect_leader_turns(f, 0, [1.3], [])
        self.assertEqual([round(t, 1) for t, _, _ in turns], [2.7])

    def test_second_flip_without_face_change_is_not_a_turn(self):
        # 肩の並びは RR と読めるが、2つ目の反転の後も背中のまま（鼻が見えない）= 肩の左右の付け違い
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, 0)])
        self.assertEqual(ap.detect_leader_turns(f, 0, [], []), [])

    def test_face_check_can_be_disabled(self):
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, 0)])
        old = ap.LEADER_FACE_FLIP_CHECK
        ap.LEADER_FACE_FLIP_CHECK = False
        try:
            self.assertEqual(len(ap.detect_leader_turns(f, 0, [], [])), 1)
        finally:
            ap.LEADER_FACE_FLIP_CHECK = old

    def test_turn_inside_overhead_spin_is_dropped(self):
        # 女性が 0.8〜2.0 秒に連続回転していて、その間は手が頭上（男が回している）: 男の回転は随伴回転として捨てる。
        # 女性のターンの時刻（0.8）からは ±CBL_PIVOT_SUPPRESS_SEC より離れている
        f = with_follower(frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)]), raised=True)
        self.assertEqual(ap.detect_leader_turns(f, 0, [], [-5.0], [(0.8, 2.0)]), [])

    def test_turn_inside_spin_with_hands_down_is_kept(self):
        f = with_follower(frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)]), raised=False)
        self.assertEqual(len(ap.detect_leader_turns(f, 0, [], [-5.0], [(0.8, 2.0)])), 1)

    def test_turn_outside_overhead_spin_is_kept(self):
        f = with_follower(frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)]), raised=True)
        self.assertEqual(len(ap.detect_leader_turns(f, 0, [], [-5.0], [(1.8, 2.5)])), 1)


class LeaderTurnReadme32Test(unittest.TestCase):
    """README 32: 逆向きの連れ回し・1 コマの付け違い・背中の瞬間の鼻"""

    def turns(self, f, ft, dirs):
        return ap.detect_leader_turns(f, 0, [], ft, follower_turn_dirs=dirs)

    def test_counter_rotation_next_to_follower_turn_is_kept(self):
        # 男は右回り（R）。0.3 秒前に始まった女性のターンは左回り = 連れ回りではない
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        self.assertEqual(len(self.turns(f, [1.0], {1.0: -1})), 1)

    def test_same_direction_next_to_follower_turn_is_dropped(self):
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        self.assertEqual(self.turns(f, [1.0], {1.0: 1}), [])

    def test_unknown_direction_next_to_follower_turn_is_dropped(self):
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        self.assertEqual(self.turns(f, [1.0], {1.0: 0}), [])
        self.assertEqual(self.turns(f, [1.0], {}), [])

    def test_counter_rotation_can_be_disabled(self):
        f = frames([(1.0, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        old = ap.LEADER_COUNTER_ROT_KEEP
        ap.LEADER_COUNTER_ROT_KEEP = False
        try:
            self.assertEqual(self.turns(f, [1.0], {1.0: -1}), [])
        finally:
            ap.LEADER_COUNTER_ROT_KEEP = old

    def test_turns_a_second_apart_in_opposite_directions_are_both_found(self):
        # 左回りの 0.9 秒後にもう一度、逆の右回り（冷却 0.8 秒）
        left = [(d, s, -fc if fc in (-1, 1) else fc) for d, s, fc in RIGHT_TURN]  # 肩の符号は同じ、顔の側だけ逆
        f = frames([(1.0, FRONT, F)] + left + [(0.45, FRONT, F)] + RIGHT_TURN + [(1.0, FRONT, F)])
        turns = ap.detect_leader_turns(f, 0, [], [])
        self.assertEqual([spin["seq"] for _, _, spin in turns], ["LL", "RR"])

    def test_single_frame_sign_glitch_is_not_a_turn(self):
        # 同符号に挟まれた 1 コマだけ逆の肩は付け違い。前後に正面・背中が付いていても回転にしない
        seg = [(0.3, FRONT, F), (0.1, BACK, -1), (0.3, FRONT, F), (0.1, BACK, 1), (0.3, FRONT, F)]
        self.assertEqual(ap.detect_leader_turns(frames(seg), 0, [], []), [])

    def test_back_view_frame_with_visible_nose_still_counts_as_back(self):
        # 背中向きの瞬間が 1 コマで、肩の分離が最大のコマだけ帽子のつばで鼻が読めた: 最小で見れば背中のままのコマがある
        turn = [(0.1, SIDE, -1), (0.1, -SIDE, -1), (0.1, BACK, 0), (0.1, -0.17, F), (0.1, -SIDE, 1), (0.1, SIDE, 1)]
        f = frames([(1.0, FRONT, F)] + turn + [(1.0, FRONT, F)])
        self.assertEqual(len(ap.detect_leader_turns(f, 0, [], [])), 1)
        old = ap.LEADER_FACE_MIN_FRAC
        ap.LEADER_FACE_MIN_FRAC = 0.0
        try:
            self.assertEqual(ap.detect_leader_turns(f, 0, [], []), [])
        finally:
            ap.LEADER_FACE_MIN_FRAC = old


def with_follower(fr, raised, pid=1):
    """各コマに女性（pid）を足す。raised なら左右の手首が頭（鼻）より上"""
    k = [[0.5, 0.3, 0.9] for _ in range(17)]
    k[0] = [0.5, 0.2, 0.9]
    for i in (ap.LEFT_WRIST, ap.RIGHT_WRIST):
        k[i] = [0.5, 0.1 if raised else 0.5, 0.9]
    for df in fr:
        df["kept"].append({"pid": pid, "shDx": FRONT, "kps": k})
    return fr


if __name__ == "__main__":
    unittest.main()
