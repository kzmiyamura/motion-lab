"""
analyze_pair.detect_turns（肩の並びの反転からターンを拾う）の単体テスト。YOLO は回さない。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

FRONT, BACK = 0.15, -0.15


def frames(segments, pid=1, fps=10):
    """[(秒数, shDx), ...] を順に並べた 10fps の draw_frames"""
    out, t = [], 0.0
    for dur, d in segments:
        for _ in range(int(round(dur * fps))):
            out.append({"t": round(t, 2), "kept": [{"pid": pid, "shDx": d}]})
            t += 1 / fps
    return out


class DetectTurnsTest(unittest.TestCase):
    def test_single_turn(self):
        f = frames([(1.0, FRONT), (0.3, BACK), (1.0, FRONT)])
        turns = ap.detect_turns(f, 1)
        self.assertEqual(len(turns), 1)
        self.assertAlmostEqual(turns[0][0], 1.0, places=1)
        self.assertEqual(turns[0][1], 1)

    def test_fast_spin_inside_cooldown_is_kept(self):
        # 1.0 秒に1回転、その 1.5 秒後（冷却 2.5 秒の内側）から反転 5 回の速い連続回転（2½ 回転）
        f = frames([(1.0, FRONT), (0.3, BACK), (1.2, FRONT),
                    (0.3, BACK), (0.3, FRONT), (0.3, BACK), (0.3, FRONT), (1.5, BACK)])
        turns = ap.detect_turns(f, 1)
        self.assertEqual(len(turns), 2)
        self.assertAlmostEqual(turns[1][0], 2.5, places=1)
        self.assertEqual(turns[1][1], 2)

    def test_turn_starting_at_tail_of_spin_is_recounted(self):
        # 前のターンの冷却（2.5 秒）が明けたのが連続回転（2.8〜4.0 秒の反転 5 回）の終わり際（3.7 秒）:
        # 冷却だけなら 3.7 秒の 1 回転になるところを、回転の始まりから 2 回転と数え直す
        f = frames([(1.0, FRONT), (0.3, BACK), (1.5, FRONT),
                    (0.3, BACK), (0.3, FRONT), (0.3, BACK), (0.3, FRONT), (1.5, BACK)])
        turns = ap.detect_turns(f, 1)
        self.assertEqual([round(t, 1) for t, _ in turns], [1.0, 2.8])
        self.assertEqual(turns[1][1], 2)

    def test_half_turn_leading_into_spin_is_absorbed(self):
        # 冷却が明けた 3.7 秒に遅い反転ペア（3.7 → 4.9、1.2 秒かけた半回転の歩き込み）があり、その 2 つ目の反転から
        # 速い連続回転（4.9〜6.1 秒の反転 5 回）が始まる: 半回転を捨てて連続回転（2 回転）に置き換える
        f = frames([(1.0, FRONT), (0.3, BACK), (2.4, FRONT), (1.2, BACK),
                    (0.3, FRONT), (0.3, BACK), (0.3, FRONT), (0.3, BACK), (1.5, FRONT)])
        turns = ap.detect_turns(f, 1)
        self.assertEqual([round(t, 1) for t, _ in turns], [1.0, 4.9])
        self.assertEqual(turns[1][1], 2)
        before = ap.TURN_FAST_ABSORB_LEAD
        try:
            ap.TURN_FAST_ABSORB_LEAD = False
            # 取り込まないと半回転（3.7）が残り、連続回転は冷却に隠れる
            self.assertEqual([round(t, 1) for t, _ in ap.detect_turns(f, 1)], [1.0, 3.7])
        finally:
            ap.TURN_FAST_ABSORB_LEAD = before

    def test_long_jitter_chain_is_not_merged(self):
        # 反転が 8 個続く揺れ（TURN_FAST_MAX_FLIPS を超える）は速い連続回転として扱わない
        f = frames([(1.0, FRONT), (0.3, BACK), (1.2, FRONT)] + [(0.3, BACK), (0.3, FRONT)] * 4 + [(1.5, FRONT)])
        before = ap.TURN_FAST_MIN_FLIPS
        try:
            ap.TURN_FAST_MIN_FLIPS = 99
            expected = ap.detect_turns(f, 1)
        finally:
            ap.TURN_FAST_MIN_FLIPS = before
        self.assertEqual(ap.detect_turns(f, 1), expected)

    # 頭上の手の下での連続回転（TURN_RAISED_*）
    LONG_SPIN = [(1.0, FRONT), (0.3, BACK), (1.2, FRONT)] + [(0.2, BACK), (0.2, FRONT)] * 3 + [(1.5, BACK)]

    def test_long_spin_under_raised_hand_is_kept(self):
        # 冷却の内側（2.5〜3.7 秒）に反転 7 個の連なり。相手の手首が頭上にある間は連続回転として拾う
        f = with_partner(frames(self.LONG_SPIN), lambda t: True)
        turns = ap.detect_turns(f, 1)
        self.assertEqual([round(t, 1) for t, _ in turns], [1.0, 2.5])
        self.assertEqual(turns[1][1], 3)

    def test_long_spin_with_hand_down_is_not_merged(self):
        # 手が下がっていれば TURN_FAST_MAX_FLIPS を超える連なりは揺れとみなす（今までどおり）
        f = with_partner(frames(self.LONG_SPIN), lambda t: False)
        self.assertNotIn(2.5, [round(t, 1) for t, _ in ap.detect_turns(f, 1)])

    def test_spin_ends_when_hand_comes_down(self):
        # 手が上がっていたのは 2.5〜3.2 秒だけ: 連なりはそこまでの反転で数える（7 反転 → 5 反転 = 2 回転）
        f = with_partner(frames(self.LONG_SPIN), lambda t: t <= 3.15)
        turns = ap.detect_turns(f, 1)
        self.assertEqual(round(turns[1][0], 1), 2.5)
        self.assertEqual(turns[1][1], 2)

    def test_either_hand_counts(self):
        # 上がっているのが左手でも右手でも同じ（内側/外側は回る向きで決まり、手では決まらない）
        for hand in (ap.LEFT_WRIST, ap.RIGHT_WRIST):
            f = with_partner(frames(self.LONG_SPIN), lambda t: True, hand=hand)
            self.assertEqual([round(t, 1) for t, _ in ap.detect_turns(f, 1)], [1.0, 2.5])


def partner_kps(raised, hand=None):
    """鼻 y=0.2、肩 y=0.3。raised なら手首（hand、None なら両手）を y=0.1（頭上）、そうでなければ y=0.5"""
    k = [[0.5, 0.3, 0.9] for _ in range(17)]
    k[0] = [0.5, 0.2, 0.9]
    for i in (ap.LEFT_WRIST, ap.RIGHT_WRIST):
        up = raised and (hand is None or i == hand)
        k[i] = [0.5, 0.1 if up else 0.5, 0.9]
    return k


def with_partner(fr, raised_at, pid=0, hand=None):
    """各コマに相手（pid）を足す。raised_at(t) が真のコマは相手の手首が頭上"""
    for df in fr:
        df["kept"].append({"pid": pid, "shDx": FRONT, "kps": partner_kps(raised_at(df["t"]), hand)})
    return fr


if __name__ == "__main__":
    unittest.main()
