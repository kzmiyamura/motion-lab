"""
行の終わりに溢れた女性のターンが、次の行に取られずに消える件（docs/salsa-knowledge/README.md 反映済み 33）の単体テスト。

行の 7〜8 拍目に回り始めたターンは次の行のものとして扱う。次の行がもっと大きいターンを持っていて選ばれなかったとき、
ターンの無いベーシック・持ち替えの行にそのターンを付ける（正解表: 8c312c6d 12.7 左 ½ の直後に右 2½）。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import normalize_routine as nr  # noqa: E402
from normalize_routine import normalize  # noqa: E402
from test_routine_rows import GRID, fturn, mv  # noqa: E402


def two_rows(second_turn):
    return {"routine": {"timing": "on2", "moves": [
        mv(0.0, "basic", name="ベーシック"),
        mv(4.0, "right_turn", name="右回りターン", turn={"by": "follower", "direction": "right", "rotations": second_turn})]}}


class SpilledTurnTest(unittest.TestCase):
    def test_small_turn_not_taken_by_next_row_goes_to_basic_row(self):
        # 3.2 に左 ½（行の 6.4 拍目 = 溢れ）、4.2 に右 2½ が次の行で回る。次の行は大きい方（右 2½）を取る
        res = two_rows(2.5)
        ev = [fturn(3.2, [("left", 0.5)]), fturn(4.2, [("right", 2.5)])]
        normalize(res, {**GRID, "events": ev}, duration=8.0)
        a, b = res["routine"]["moves"]
        self.assertEqual((a["move"], a["turn"]["direction"], a["turn"]["rotations"]), ("left_turn", "left", 0.5))
        self.assertEqual(a["turnCheck"], "spilledTurn:left")
        self.assertEqual((b["move"], b["turn"]["direction"]), ("right_turn", "right"))

    def test_turn_taken_by_next_row_is_not_duplicated(self):
        # 溢れたターンが次の行の選ばれたターンなら、前の行はベーシックのまま
        res = two_rows(1.0)
        normalize(res, {**GRID, "events": [fturn(3.2, [("right", 1.0)])]}, duration=8.0)
        a, b = res["routine"]["moves"]
        self.assertEqual(a["move"], "basic")
        self.assertIsNone(a.get("turn"))
        self.assertEqual(b["turn"]["direction"], "right")

    def test_off_switch(self):
        old = nr.SPILLED_TURN
        nr.SPILLED_TURN = False
        try:
            res = two_rows(2.5)
            ev = [fturn(3.2, [("left", 0.5)]), fturn(4.2, [("right", 2.5)])]
            normalize(res, {**GRID, "events": ev}, duration=8.0)
            self.assertEqual(res["routine"]["moves"][0]["move"], "basic")
        finally:
            nr.SPILLED_TURN = old

    def test_row_with_its_own_turn_is_untouched(self):
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "left_turn", name="左回りターン", turn={"by": "follower", "direction": "left", "rotations": 1.0}),
            mv(4.0, "right_turn", turn={"by": "follower", "direction": "right", "rotations": 2.5})]}}
        ev = [fturn(1.0, [("left", 1.0)]), fturn(3.2, [("left", 0.5)]), fturn(4.2, [("right", 2.5)])]
        normalize(res, {**GRID, "events": ev}, duration=8.0)
        a = res["routine"]["moves"][0]
        self.assertNotIn("turnCheck", a)
        self.assertEqual(a["turn"]["rotations"], 1.0)


if __name__ == "__main__":
    unittest.main()
