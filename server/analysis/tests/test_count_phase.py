"""
カウント位相の指標（eval_routine_grid.count_phase、docs/salsa-knowledge/README.md 35）の単体テスト。

- 正解の通過が行の頭から 1 拍後（カウント 2）・1.5 拍後（カウント 2.5）なら合っている
- 行の頭から 4 拍後（カウント 5）は外れ、bias は + 側（行の頭が遅い）
- 1 行で行って戻る 2 回目の通過（1 回目の約 4 拍後）は 4 拍引いて数える
- 行に入らない通過は数えない
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from eval_routine_grid import count_phase, evaluate  # noqa: E402

BEAT = 0.5
ROWS = [(0.0, 4.0, {"move": "cbl"}), (4.0, 8.0, {"move": "cbl"})]


class CountPhaseTest(unittest.TestCase):
    def test_on_count_two(self):
        r = count_phase(ROWS, [0.5, 4.75], BEAT)
        self.assertEqual((r["n"], r["ok"]), (2, 2))
        self.assertAlmostEqual(r["bias"], -0.25, places=1)

    def test_late_count_is_outside_and_biased(self):
        r = count_phase(ROWS, [2.0, 6.0], BEAT)   # 行の頭から 4 拍後 = カウント 5
        self.assertEqual(r["ok"], 0)
        self.assertAlmostEqual(r["bias"], 2.5, places=1)

    def test_second_pass_in_same_row_is_shifted_by_four_beats(self):
        r = count_phase(ROWS, [0.5, 2.5], BEAT)   # 2 回目は 1 回目の 4 拍後 → カウント 6 でなく 2 と数える
        self.assertEqual((r["n"], r["ok"]), (2, 2))

    def test_outside_rows_not_counted(self):
        r = count_phase(ROWS, [99.0], BEAT)
        self.assertEqual(r["n"], 0)
        self.assertIsNone(r["acc"])

    def test_evaluate_exposes_count_phase_ignoring_optional(self):
        moves = [{"start": 0.0, "counts": 8, "move": "cbl"}]
        gt = {"cbl": [{"t": 0.75, "kind": "cbl"}, {"t": 2.0, "kind": "cbl", "optional": True}], "turns": []}
        out = evaluate(moves, gt, BEAT)
        self.assertEqual(out["countPhase"]["n"], 1)
        self.assertEqual(out["countPhase"]["ok"], 1)


if __name__ == "__main__":
    unittest.main()
