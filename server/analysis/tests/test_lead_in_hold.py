"""冒頭の手の推定（summary.handLeadIn）で冒頭の行の hold を置き換える apply_lead_in_hold の単体テスト"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import normalize_routine as nr  # noqa: E402

LI = {"from": 0.2, "to": 10.7, "hand": "R-R", "conflicts": [{"hand": "R-L", "from": 3.3, "to": 3.9}, {"hand": "L-L", "from": 2.7, "to": 2.7}]}


def summary(li=LI):
    return {"handLeadIn": li} if li else {}


class ApplyLeadInHold(unittest.TestCase):
    def test_replaces_conflicting_and_unreadable(self):
        mv = {"move": "left_turn", "holdStart": None, "holdEnd": "RL"}
        self.assertTrue(nr.apply_lead_in_hold(mv, summary(), 1.9, 4.5))
        self.assertEqual((mv["holdStart"], mv["holdEnd"]), ("RR", "RR"))
        self.assertTrue(mv["holdEstimated"])

    def test_keeps_own_reading_not_in_conflicts(self):
        mv = {"move": "cbl", "holdStart": "LR", "holdEnd": "LR"}
        self.assertFalse(nr.apply_lead_in_hold(mv, summary(), 1.9, 4.5))
        self.assertEqual((mv["holdStart"], mv["holdEnd"]), ("LR", "LR"))

    def test_row_outside_range_untouched(self):
        mv = {"move": "cbl", "holdStart": "RL", "holdEnd": "RL"}
        self.assertFalse(nr.apply_lead_in_hold(mv, summary(), 12.0, 14.6))
        self.assertEqual(mv["holdStart"], "RL")

    def test_hand_change_row_untouched(self):
        mv = {"move": "hand_change", "holdStart": "RL", "holdEnd": "RL"}
        self.assertFalse(nr.apply_lead_in_hold(mv, summary(), 1.9, 4.5))

    def test_no_value_no_override(self):
        mv = {"move": "left_turn", "holdStart": None, "holdEnd": "RL"}
        self.assertFalse(nr.apply_lead_in_hold(mv, summary(None), 1.9, 4.5))
        self.assertEqual(mv["holdEnd"], "RL")


if __name__ == "__main__":
    unittest.main()
