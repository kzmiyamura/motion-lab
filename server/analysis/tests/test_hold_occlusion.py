"""
重なり区間の hold 補完（analyze_pair.fill_unclear_holds / build_hold_timeline / build_hold_unclear）の単体テスト。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

LEADER_BOX = [0.10, 0.20, 0.30, 0.80]
FOLLOWER_BOX = [0.50, 0.20, 0.70, 0.80]


def _person(pid, box, wrist=None):
    w = {"L": None, "R": None}
    if wrist is not None:
        w[wrist[0]] = wrist[1]
    return {"pid": pid, "bbox": box, "wrists": w}


def _frames(n_hidden, n_clear, pair_hold=("L", "R")):
    """先頭 n_hidden コマは相方が隠れて1人だけ（重なり区間）、続く n_clear コマは2人とも見えて手をつないでいる"""
    frames = []
    for i in range(n_hidden):
        frames.append({"t": i * 0.1, "kept": [_person(0, LEADER_BOX)]})
    lk, fk = pair_hold
    for i in range(n_hidden, n_hidden + n_clear):
        frames.append({"t": i * 0.1, "kept": [
            _person(0, LEADER_BOX, (lk, (0.40, 0.50))),
            _person(1, FOLLOWER_BOX, (fk, (0.41, 0.50))),
        ]})
    return frames


class FillTest(unittest.TestCase):
    def setUp(self):
        self._saved = (ap.HOLD_OCCLUSION_FILL, ap.HOLD_FILL_OVERWRITE, ap.HOLD_FILL_EDGES_ONLY)
        ap.HOLD_OCCLUSION_FILL, ap.HOLD_FILL_OVERWRITE, ap.HOLD_FILL_EDGES_ONLY = True, True, True
        ap._HOLD_CACHE.clear()

    def tearDown(self):
        ap.HOLD_OCCLUSION_FILL, ap.HOLD_FILL_OVERWRITE, ap.HOLD_FILL_EDGES_ONLY = self._saved
        ap._HOLD_CACHE.clear()

    def test_leading_hidden_run_is_backfilled_and_marked_estimated(self):
        frames = _frames(8, 12)
        labels, est = ap._hold_table(frames, 0)
        self.assertTrue(all(l == "L-R" for l in labels))      # 先頭の隠れたコマにも、直後の明瞭な区間の hold
        self.assertEqual(est, [True] * 8 + [False] * 12)

    def test_timeline_has_estimated_span(self):
        frames = _frames(8, 12)
        tl = ap.build_hold_timeline(frames, 0)
        self.assertEqual(len(tl), 1)
        self.assertEqual(tl[0]["hold"], "リーダー左手×フォロワー右手")
        self.assertEqual(tl[0]["from"], 0.0)
        self.assertEqual(tl[0]["estimated"], [0.0, 0.7])

    def test_disabled_flag_keeps_old_behaviour(self):
        ap.HOLD_OCCLUSION_FILL = False
        ap._HOLD_CACHE.clear()
        frames = _frames(8, 12)
        labels, est = ap._hold_table(frames, 0)
        self.assertEqual(labels[:8], [None] * 8)
        self.assertFalse(any(est))
        self.assertNotIn("estimated", ap.build_hold_timeline(frames, 0)[0])

    def test_split_votes_are_not_filled(self):
        labels = ["L-R", "L-L", "R-R", "R-L", "L-R", "R-L"]
        frames = _frames(0, 6)
        # 先頭に隠れた3コマを足し、直後の明瞭な区間の読みが割れているとき補わない
        frames = _frames(3, 0) + [{"t": 0.3 + i * 0.1, "kept": [_person(0, LEADER_BOX), _person(1, FOLLOWER_BOX)]} for i in range(6)]
        out, est = ap.fill_unclear_holds(frames, 0, [None] * 3 + labels)
        self.assertEqual(out[:3], [None] * 3)
        self.assertFalse(any(est))

    def test_interior_overlap_is_untouched_by_default(self):
        clear = lambda i: {"t": i * 0.1, "kept": [_person(0, LEADER_BOX), _person(1, FOLLOWER_BOX)]}
        hidden = lambda i: {"t": i * 0.1, "kept": [_person(0, LEADER_BOX)]}
        frames = [clear(i) for i in range(5)] + [hidden(i) for i in range(5, 8)] + [clear(i) for i in range(8, 13)]
        labels = ["L-R"] * 5 + ["R-R"] * 3 + ["L-R"] * 5
        out, est = ap.fill_unclear_holds(frames, 0, labels)
        self.assertEqual(out, labels)          # 途中の重なりは計測値をそのまま残す
        self.assertFalse(any(est))
        ap.HOLD_FILL_EDGES_ONLY = False
        out, est = ap.fill_unclear_holds(frames, 0, labels)
        self.assertEqual(out[5:8], ["L-R"] * 3)     # 前後が同じ hold なら補う
        self.assertEqual(est[5:8], [True] * 3)

    def test_long_hidden_run_is_not_filled(self):
        frames = _frames(40, 8)                # 4 秒隠れる（HOLD_FILL_MAX_SEC を超える）
        out, est = ap.fill_unclear_holds(frames, 0, [None] * 40 + ["L-R"] * 8)
        self.assertEqual(out[:40], [None] * 40)
        self.assertFalse(any(est))

    def test_overlapping_boxes_are_unclear(self):
        a = {"t": 0.0, "kept": [_person(0, [0.30, 0.20, 0.55, 0.80]), _person(1, [0.32, 0.25, 0.56, 0.78])]}
        self.assertTrue(ap.hold_unclear(a, 0))
        b = {"t": 0.0, "kept": [_person(0, LEADER_BOX), _person(1, FOLLOWER_BOX)]}
        self.assertFalse(ap.hold_unclear(b, 0))

    def test_hold_unclear_spans(self):
        frames = _frames(6, 6)
        self.assertEqual(ap.build_hold_unclear(frames, 0), [{"from": 0.0, "to": 0.5}])


if __name__ == "__main__":
    unittest.main()
