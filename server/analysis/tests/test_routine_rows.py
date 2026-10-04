"""
振付シートの行（カード）の誤りを normalize で直す規則（docs/salsa-knowledge/README.md 反映済み 25）の単体テスト。

- 行の 7〜8 拍目に回り始めた CV のターンは次の行のもの（前の行の向きを変えない・次の行のターンになる）
- 行の CV のターンは、向きがあって一番多く回ったものを使う
- 回る向きは 10fps の反転列（spinCoarse）で決まればそちら（全フレームの取り直しは向きを外すことがある）
- 入れ替わりの無い CBL の行（幽霊）の直前の行に入れ替わりがあれば CBL を前の行へ
- 前の行が CBL のとき、行の頭（カウント 2 より前）の入れ替わりは前の行の 2 回目の通過
- ターンの無い CBL の行に女性の CV のターンがあれば CBL＋ターン
- analyze_pair.refine_turns_dense が 10fps の spin を spinCoarse に残す

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import normalize_routine as nr  # noqa: E402
from normalize_routine import coarse_runs, cv_turn_pick, normalize, spin_summary  # noqa: E402

GRID = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}   # 1×8 = 4 秒（頭は 0, 4, 8 …）


def mv(start, move="basic", counts=8, **kw):
    return {"start": start, "move": move, "counts": counts, **kw}


def fturn(t, runs, coarse=None, by="follower", frm=None):
    e = {"t": t, "type": "Turn", "by": by,
         "spin": {"from": t if frm is None else frm, "to": t + 1.0, "source": "fullFrames",
                  "runs": [{"dir": d, "turns": n} for d, n in runs]}}
    if coarse is not None:
        e["spinCoarse"] = {"seq": coarse}
    return e


def cbl(t_cross, side="left"):
    return {"t": t_cross - 0.4, "tCross": t_cross, "type": "CBL", "by": "pair", "pass": {"side": side}}


def tracks(sides_by_t, leader_pid=1):
    frames = []
    for t, side in sides_by_t:
        fx, lx = (0.7, 0.3) if side == "right" else (0.3, 0.7)
        frames.append({"t": t, "kept": [{"pid": leader_pid, "hipX": lx}, {"pid": 1 - leader_pid, "hipX": fx}]})
    return {"leaderPid": leader_pid, "frames": frames}


def side_series(changes, end):
    """[(t, side), …] の切り替わり → 0.1 秒おきの (t, side)"""
    out, i, cur = [], 0, changes[0][1]
    for k in range(int(end * 10)):
        t = k / 10
        while i + 1 < len(changes) and t >= changes[i + 1][0]:
            i += 1
            cur = changes[i][1]
        out.append((t, cur))
    return out


class SpinSummaryTest(unittest.TestCase):
    def test_coarse_runs_drop_single_opposite_flip(self):
        self.assertEqual(coarse_runs("LLLLR"), [{"dir": "left", "turns": 2.0}])
        self.assertEqual(coarse_runs("LLRLR"), [{"dir": "left", "turns": 1.5}])
        self.assertEqual(coarse_runs("RL"), [{"dir": "right", "turns": 0.5}, {"dir": "left", "turns": 0.5}])
        self.assertEqual(coarse_runs("L?L"), [{"dir": "left", "turns": 1.0}])

    def test_coarse_direction_overrides_dense(self):
        # 全フレームは右 2½、10fps は左 1½ → 向きは左。数は全フレームの左の合計（0）と 10fps の多い方
        s = spin_summary(fturn(1.0, [("right", 2.5)], coarse="LLL"))
        self.assertEqual((s["dir"], s["turns"]), ("left", 1.5))

    def test_mixed_dense_runs_use_coarse_count_when_larger(self):
        # bb0efcb9 20.1: 全フレームは右 ½・左 ½、10fps は「LL」= 左 1（正解は左 1）
        s = spin_summary(fturn(1.0, [("right", 0.5), ("left", 0.5)], coarse="LL"))
        self.assertEqual((s["dir"], s["turns"]), ("left", 1.0))

    def test_mixed_dense_runs_without_coarse_have_no_direction(self):
        s = spin_summary(fturn(1.0, [("left", 1.0), ("right", 3.0)]))
        self.assertIsNone(s["dir"])

    def test_tracks_only_spin_is_its_own_coarse_reading(self):
        # 全フレームで取り直していないイベント（spin は 10fps の seq だけ）は spin そのものを読む
        e = {"t": 1.0, "type": "Turn", "by": "follower", "spin": {"seq": "RRRR", "netDeg": 720}}
        s = spin_summary(e)
        self.assertEqual((s["dir"], s["turns"]), ("right", 2.0))

    def test_best_turn_in_row(self):
        # 行に 2 件: 向きの混ざった半回転と左 1½ → 左 1½ を使う（2fda2815 9.43 / 8c312c6d 9.89 の形）
        ev = [fturn(1.0, [("left", 0.5), ("right", 0.5), ("left", 0.5)]), fturn(2.0, [("left", 1.5)])]
        s = cv_turn_pick({"events": ev}, 0.0, 4.0, 0.5)
        self.assertEqual((s["dir"], s["turns"]), ("left", 1.5))

    def test_turn_starting_on_count_7_or_later_belongs_to_next_row(self):
        ev = [fturn(3.2, [("right", 2.5)])]          # 頭から 6.4 拍 = カウント 7.4
        self.assertIsNone(cv_turn_pick({"events": ev}, 0.0, 4.0, 0.5))
        s = cv_turn_pick({"events": ev}, 4.0, 8.0, 0.5)
        self.assertEqual(s["dir"], "right")


class RowRulesTest(unittest.TestCase):
    def test_spilled_turn_does_not_flip_previous_row_and_fills_next(self):
        # 2fda2815 8.4〜11.1: CBL＋インサイド（左 1½、CV は向きの混ざった半回転）の 7〜8 拍目に次のターン（右 2½）が
        # 回り始める。前の行の向きは左のまま、次のベーシックの行が右回りになる
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "left_turn", name="左回りターン", turn={"by": "follower", "direction": "left", "rotations": 1.5}),
            mv(4.0, "basic", name="ベーシック")]}}
        ev = [fturn(1.0, [("left", 0.5), ("right", 0.5), ("left", 0.5)]), fturn(3.3, [("right", 2.5)])]
        normalize(res, {**GRID, "events": ev}, duration=8.0)
        a, b = res["routine"]["moves"]
        self.assertEqual(a["turn"]["direction"], "left")
        self.assertNotIn("directionCheck", a)
        self.assertEqual((b["move"], b["turn"]["direction"]), ("right_turn", "right"))

    def test_old_rule_would_flip_previous_row(self):
        # 従来（最初のターン・行の中なら全部）は次のターンの右 2½ で前の行を右に変えていた
        old = (nr.TURN_PICK, nr.TURN_SPILL_BEATS)
        nr.TURN_PICK, nr.TURN_SPILL_BEATS = "first", None
        try:
            res = {"routine": {"timing": "on2", "moves": [
                mv(0.0, "left_turn", turn={"by": "follower", "direction": "left", "rotations": 1.5}), mv(4.0)]}}
            ev = [fturn(1.0, [("left", 0.5), ("right", 0.5), ("left", 0.5)]), fturn(3.3, [("right", 2.5)])]
            normalize(res, {**GRID, "events": ev}, duration=8.0)
            self.assertEqual(res["routine"]["moves"][0]["turn"]["direction"], "right")
        finally:
            nr.TURN_PICK, nr.TURN_SPILL_BEATS = old

    def test_coarse_direction_corrects_claude(self):
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右回りターン", turn={"by": "follower", "direction": "right", "rotations": 2})]}}
        normalize(res, {**GRID, "events": [fturn(1.0, [("right", 2.0)], coarse="LLLL")]}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual((m["move"], m["turn"]["direction"], m["turn"]["rotations"]), ("left_turn", "left", 2.0))
        self.assertEqual(m["turn"]["claudeDirection"], "right")

    def test_ghost_cbl_moves_back_to_row_with_the_swap(self):
        # 2fda2815 11.1〜13.8: 入れ替わり（カウント 8 前後）が「右回りターン」の行に入り、次の行が入れ替わりの無い
        # 「リバース CBL」になる → 前の行を CBL＋アウトサイド、次の行を右回りターンに
        tr = tracks(side_series([(0.0, "left"), (1.5, "right"), (7.7, "left")], 16.0))
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "cbl", passSide="left"),
            mv(4.0, "right_turn", name="右回りターン", turn={"by": "follower", "direction": "right", "rotations": 1}),
            mv(8.0, "reverse_cbl", name="リバースCBL＋右回り", passSide="right",
               turn={"by": "follower", "direction": "right", "rotations": 1.5}),
            mv(12.0, "basic", name="ベーシック")]}}
        normalize(res, {**GRID, "events": [cbl(1.6), cbl(7.8, "right")]}, duration=16.0, tracks=tr)
        _, a, b, c = res["routine"]["moves"]
        self.assertEqual(a["sides"]["swapAt"], [7.65])
        self.assertEqual(a["move"], "cbl_outside_turn")
        self.assertEqual(a["passSide"], "right")
        self.assertTrue(a["passCheck"].startswith("ghostCblBack"))
        self.assertTrue(a["name"].endswith("?"))
        self.assertEqual((b["move"], b["turn"]["direction"]), ("right_turn", "right"))
        self.assertTrue(b["claudeName"].startswith("リバースCBL＋右回り"))
        self.assertIsNone(b["passSide"])
        self.assertEqual(c["move"], "basic")

    def test_ghost_cbl_kept_when_its_own_row_has_a_cv_swap(self):
        tr = tracks(side_series([(0.0, "left"), (1.5, "right"), (7.7, "left"), (10.0, "right")], 16.0))
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "cbl", passSide="left"),
            mv(4.0, "right_turn", turn={"by": "follower", "direction": "right", "rotations": 1}),
            mv(8.0, "cbl", passSide="right"), mv(12.0)]}}
        normalize(res, {**GRID, "events": [cbl(1.6), cbl(7.8, "right"), cbl(10.1)]}, duration=16.0, tracks=tr)
        _, a, b, _ = res["routine"]["moves"]
        self.assertNotIn("ghostCblBack", a.get("passCheck") or "")
        self.assertEqual(b["move"], "cbl")

    def test_swap_before_count_2_belongs_to_previous_cbl_row(self):
        # 8c312c6d 9.1・10.6: CBL の行の 2 回目の通過が、次の行の頭（カウント 1.6）に遅れて出る → 次の行は CBL にしない
        tr = tracks(side_series([(0.0, "left"), (5.5, "right"), (8.2, "left")], 16.0))
        res = {"routine": {"timing": "on2", "moves": [mv(0.0), mv(4.0, "cbl", passSide="left"), mv(8.0, "basic"), mv(12.0)]}}
        normalize(res, {**GRID, "events": [cbl(5.6), cbl(8.3, "right")]}, duration=16.0, tracks=tr)
        _, a, b, _ = res["routine"]["moves"]
        self.assertEqual(b["move"], "basic")
        self.assertEqual(b["sides"]["swapAt"], [])
        self.assertEqual(b["swapEarly"], [8.15])
        self.assertEqual(a["sides"]["swapAt"], [5.45, 8.15])

    def test_late_swap_still_makes_the_row_a_cbl(self):
        # カウント 2 以降の入れ替わりはその行のもの（従来どおりベーシック → CBL）
        tr = tracks(side_series([(0.0, "left"), (5.5, "right"), (9.0, "left")], 16.0))
        res = {"routine": {"timing": "on2", "moves": [mv(0.0), mv(4.0, "cbl", passSide="left"), mv(8.0, "basic"), mv(12.0)]}}
        normalize(res, {**GRID, "events": [cbl(5.6), cbl(9.1, "right")]}, duration=16.0, tracks=tr)
        b = res["routine"]["moves"][2]
        self.assertEqual(b["move"], "cbl")
        self.assertNotIn("swapEarly", b)

    def test_cbl_row_with_follower_turn_becomes_cbl_turn(self):
        # CBL の行（other / wrap から CBL にした行も）に女性の CV のターン（1 回転以上）があれば CBL＋ターン
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "cbl", name="CBL"), mv(4.0, "wrap", name="ラップ?"), mv(8.0, "cbl", name="CBL")]}}
        ev = [cbl(2.0), fturn(2.2, [("left", 1.5)]), cbl(6.0, "right"), fturn(6.1, [("right", 1.0)]),
              cbl(10.0), fturn(10.2, [("left", 0.5)])]      # ½ 回転だけは付けない
        normalize(res, {**GRID, "events": ev}, duration=12.0)
        a, b, c = res["routine"]["moves"]
        self.assertEqual((a["move"], a["turn"]["direction"], a["turn"]["rotations"]), ("cbl_inside_turn", "left", 1.5))
        self.assertEqual((b["move"], b["turn"]["direction"]), ("cbl_outside_turn", "right"))
        self.assertEqual(c["move"], "cbl")
        self.assertIsNone(c.get("turn"))


class EvalTurnPrecTest(unittest.TestCase):
    def test_turn_rows_without_gt_turn_are_counted(self):
        from eval_routine_set import extra_checks
        moves = [mv(0.0, "left_turn", turn={"by": "follower", "direction": "left", "rotations": 1}),
                 mv(4.0, "cbl_inside_turn", turn={"by": "follower", "direction": "left", "rotations": 1.5}),
                 mv(8.0, "basic")]
        gt = {"turns": [{"t": 1.0, "by": "follower", "runs": [{"dir": "left", "turns": 1}]}], "cbl": []}
        tp = extra_checks(moves, gt, 0.5, False)["turnPrec"]
        self.assertEqual((tp["hit"], tp["n"]), (1, 2))
        # ターンを全部は拾えていない正解表では数えない
        tp2 = extra_checks(moves, {**gt, "turnsComplete": False}, 0.5, False)["turnPrec"]
        self.assertEqual(tp2["n"], 0)


class DenseKeepsCoarseTest(unittest.TestCase):
    """refine_turns_dense が全フレームで取り直す前の 10fps の spin を spinCoarse に残す"""

    def test_spin_coarse_is_kept(self):
        import analyze_pair as ap

        class FakeCap:
            def __init__(self, path):
                self.t = 0.0

            def isOpened(self):
                return True

            def set(self, prop, ms):
                self.t = ms / 1000

            def get(self, prop):
                return self.t * 1000

            def read(self):
                self.t += 1 / 30
                return (self.t < 10.0), object()

            def release(self):
                pass

        def fake_detect(model, frame):
            # 0.2 秒ごとに肩の左右が入れ替わる（回り続ける）
            sign = 1 if int(fake_detect.cap.t / 0.2) % 2 == 0 else -1
            return [{"bbox": [0.4, 0.2, 0.6, 0.9], "shDx": 0.05 * sign}]

        orig = (ap.cv2.VideoCapture, ap.detect_persons, ap.face_side)
        caps = []

        def make_cap(path):
            c = FakeCap(path)
            caps.append(c)
            fake_detect.cap = c
            return c
        ap.cv2.VideoCapture, ap.detect_persons, ap.face_side = make_cap, fake_detect, (lambda p: 1)
        try:
            frames = [{"t": k / 10, "kept": [{"pid": 0, "bbox": [0.4, 0.2, 0.6, 0.9]},
                                             {"pid": 1, "bbox": [0.1, 0.2, 0.3, 0.9]}]} for k in range(100)]
            coarse = {"seq": "LL", "netDeg": -360}
            ev = [{"t": 2.0, "type": "Turn", "by": "follower", "rotations": 1, "spin": dict(coarse)}]
            out = ap.refine_turns_dense("x.mp4", None, frames, ev, leader_pid=1)
        finally:
            ap.cv2.VideoCapture, ap.detect_persons, ap.face_side = orig
        (e,) = out
        self.assertEqual(e["spin"]["source"], "fullFrames")
        self.assertEqual(e["spinCoarse"], coarse)


if __name__ == "__main__":
    unittest.main()
