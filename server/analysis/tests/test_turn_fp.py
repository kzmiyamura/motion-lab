"""
README 23 の単体テスト（YOLO は回さない）:
- TURN_CBL_HALF_DROP: 反転 2 つだけで、その間に CBL の腰の交差があるものは通過の半回転として女性のターンに出さない
- TURN_REARM_*: 冷却の内でも、前のターンの反転から離れて手が頭上に上がり直した反転ペアは新しいターン

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

FRONT, BACK = 0.15, -0.15
KNOBS = ("TURN_CBL_HALF_DROP", "TURN_CBL_HALF_MARGIN", "TURN_CBL_HALF_KEEP_SUPPRESS",
         "TURN_REARM_RATIO", "TURN_REARM_GAP", "TURN_REARM_WHO", "TURN_REARM_PRE_SEC")


def kps(face=1, raised=False):
    k = [[0.5, 0.5, 0.9] for _ in range(17)]
    k[3] = [0.5, 0.2, 0.9]
    k[4] = [0.5, 0.2, 0.9]
    k[0] = [0.5 + 0.03 * face, 0.2, 0.9]
    if raised:
        k[9] = [0.5, 0.05, 0.9]
    return k


def pair_frames(follower, cross_at=None, fps=10):
    """follower: [(秒数, shDx, 手が頭上か)]。女性 pid 1、男 pid 0（正面のまま立つ）。
    cross_at: この時刻に 2 人の腰の左右が入れ替わる（None なら入れ替わらない）"""
    out, t = [], 0.0
    for dur, d, up in follower:
        for _ in range(int(round(dur * fps))):
            fx, lx = (0.3, 0.7) if cross_at is None or t < cross_at else (0.7, 0.3)
            out.append({"t": round(t, 2), "kept": [
                {"pid": 1, "shDx": d, "hipX": fx, "kps": kps(1 if d > 0 else -1, up),
                 "bbox": [fx - 0.1, 0.0, fx + 0.1, 1.0], "wrists": {"L": None, "R": None}},
                {"pid": 0, "shDx": FRONT, "hipX": lx, "kps": kps(1),
                 "bbox": [lx - 0.1, 0.0, lx + 0.1, 1.0], "wrists": {"L": None, "R": None}}]})
            t += 1 / fps
    return out


def follower_turns(f):
    return [e["t"] for e in ap.detect_events(f, 0) if e["type"] == "Turn" and e["by"] == "follower"]


class TurnFpTest(unittest.TestCase):
    def setUp(self):
        self.saved = {k: getattr(ap, k) for k in KNOBS}

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(ap, k, v)

    # 正面 → 1.4 秒に背中 → 1.7 秒に正面（反転 2 つ）
    HALF = [(1.4, FRONT, False), (0.3, BACK, False), (2.3, FRONT, False)]

    def test_half_turn_at_cbl_is_dropped(self):
        f = pair_frames(self.HALF, cross_at=1.5)
        self.assertEqual(ap.detect_cbl(f), [1.5])
        ap.TURN_CBL_HALF_DROP = False
        self.assertEqual(follower_turns(f), [1.4])
        ap.TURN_CBL_HALF_DROP = True
        self.assertEqual(follower_turns(f), [])

    def test_margin_is_one_frame(self):
        # 交差が 2 つ目の反転の 1 コマ後（1.8 秒）でも半回転、0.3 秒後なら別の出来事
        ap.TURN_CBL_HALF_DROP = True
        ap.TURN_CBL_HALF_MARGIN = 0.1
        self.assertEqual(follower_turns(pair_frames(self.HALF, cross_at=1.8)), [])
        self.assertEqual(follower_turns(pair_frames(self.HALF, cross_at=2.0)), [1.4])

    def test_turn_away_from_cbl_is_kept(self):
        ap.TURN_CBL_HALF_DROP = True
        self.assertEqual(follower_turns(pair_frames(self.HALF, cross_at=3.0)), [1.4])

    def test_cbl_with_full_turn_is_kept(self):
        # 交差の間に反転 4 つ（通過の½＋1 回転以上）は本物のターン
        segs = [(1.4, FRONT, False), (0.3, BACK, False), (0.3, FRONT, False), (0.3, BACK, False), (1.7, FRONT, False)]
        ap.TURN_CBL_HALF_DROP = True
        self.assertEqual(follower_turns(pair_frames(segs, cross_at=1.5)), [1.4])

    # 1.0 秒に 1 回転（反転 1.0 / 1.3）、手を下げて 1.0 秒空け、2.3 秒から手を頭上に上げてもう 1 回転（反転 2.4 / 2.8）。
    # 2 つ目は 1.0 秒のターンの冷却（2.5 秒）の内側
    def second(self, up):
        return [(1.0, FRONT, False), (0.3, BACK, False), (1.0, FRONT, False), (0.1, FRONT, up),
                (0.4, BACK, up), (2.0, FRONT, False)]

    def test_rearm_recovers_raised_turn_in_cooldown(self):
        ap.TURN_REARM_RATIO = 0.0
        self.assertEqual(follower_turns(pair_frames(self.second(True))), [1.0])
        ap.TURN_REARM_RATIO = 0.5
        ap.TURN_REARM_GAP = 0.8
        self.assertEqual(follower_turns(pair_frames(self.second(True))), [1.0, 2.4])

    def test_rearm_needs_raised_hand(self):
        ap.TURN_REARM_RATIO = 0.5
        ap.TURN_REARM_GAP = 0.8
        self.assertEqual(follower_turns(pair_frames(self.second(False))), [1.0])

    def test_rearm_needs_gap_after_previous_turn(self):
        # 前のターンの反転（1.3）から 0.5 秒で始まる反転ペアは同じ回転の続き
        segs = [(1.0, FRONT, False), (0.3, BACK, False), (0.4, FRONT, False), (0.1, FRONT, True),
                (0.4, BACK, True), (2.0, FRONT, False)]
        ap.TURN_REARM_RATIO = 0.5
        ap.TURN_REARM_GAP = 0.8
        self.assertEqual(follower_turns(pair_frames(segs)), [1.0])


if __name__ == "__main__":
    unittest.main()
