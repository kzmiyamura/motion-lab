"""
normalize_routine.py（振付シート用の routine の後処理）の単体テスト。

「これじゃ踊れんわ」— 1 秒おきの 1-8、4 秒の 1-16、3 回転・4½ 回転、長い説明文の技名、
「どう動くか」が無いカード、を直すための決定的な処理を確かめる。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import pair_sides  # noqa: E402
from normalize_routine import (  # noqa: E402
    NAME_MAX, SWAP_BEAT, apply_rotation_prior, clean_turn, fit_grid, fit_grid_to_swaps, grid_cycles, normalize,
    salsa_unit8, short_name, swap_heads,
    template_steps, turn_kind,
)
from eval_routine_grid import evaluate as evaluate_rows  # noqa: E402


def mv(start, move="basic", counts=8, **kw):
    return {"start": start, "move": move, "counts": counts, **kw}


class GridTest(unittest.TestCase):
    def test_audio_grid_snaps_starts_to_8_count_heads(self):
        # 120 BPM → 1×8 = 4 秒、最初の拍 0.5 秒。技の頭は 0.5 / 4.5 / 8.5 … に寄る
        res = {"routine": {"timing": "on1", "moves": [
            mv(0.6), mv(4.3, "cbl"), mv(8.9, "right_turn", turn={"by": "follower", "direction": "right", "rotations": 1}),
        ]}}
        normalize(res, {"beatGrid": {"bpm": 120, "beatIntervalSec": 0.5, "firstBeatSec": 0.5}}, duration=12.6)
        moves = res["routine"]["moves"]
        self.assertEqual([m["start"] for m in moves], [0.5, 4.5, 8.5])
        self.assertEqual([m["counts"] for m in moves], [8, 8, 8])
        self.assertEqual(res["routine"]["grid"]["source"], "audio")
        self.assertEqual(res["routine"]["bpm"], 120)

    def test_counts_follow_duration(self):
        # 2×8 分の長さがある行は counts 16 になる（Claude が 8 と書いていても）
        res = {"routine": {"moves": [mv(0.0), mv(4.0, "cbl"), mv(12.0)]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=16.0)
        self.assertEqual([m["counts"] for m in res["routine"]["moves"]], [8, 16, 8])

    def test_tiny_moves_are_merged_into_one_line(self):
        # 1 秒おきに 1-8 が並ぶ（同じ 8 カウントに入る）→ 1 行にまとめ、ターン・パスのある方を主にする
        res = {"routine": {"moves": [
            mv(0.0), mv(4.0, "basic", name="ベーシック"),
            mv(4.9, "cbl_inside_turn", name="CBL＋インサイドターン", passSide="left",
               turn={"by": "follower", "direction": "left", "rotations": 1.5}, holdEnd="LR"),
            mv(8.0),
        ]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=12.0)
        moves = res["routine"]["moves"]
        self.assertEqual(len(moves), 3)
        self.assertEqual(moves[1]["move"], "cbl_inside_turn")
        self.assertEqual(moves[1]["start"], 4.0)
        self.assertEqual(moves[1]["mergedFrom"], ["ベーシック"])
        self.assertEqual(moves[1]["holdEnd"], "LR")
        self.assertEqual(len(res["routine"]["rawMoves"]), 4)

    def test_silent_video_estimates_tempo_from_routine(self):
        # 無音（beatGrid なし）: 1×8 ≈ 2.4 秒で並んだ routine（時刻に少しずれ）から周期を推定して揃える
        starts = [0.0, 2.5, 4.7, 7.3, 9.6, 12.1, 14.4, 16.9]
        res = {"routine": {"moves": [mv(s) for s in starts]}}
        normalize(res, {"beatGrid": None}, duration=19.3)
        g = res["routine"]["grid"]
        self.assertEqual(g["source"], "routine")
        self.assertAlmostEqual(g["unitSec"], 2.4, delta=0.12)
        self.assertEqual(len(res["routine"]["moves"]), len(starts))
        self.assertTrue(all(m["counts"] == 8 for m in res["routine"]["moves"]))
        self.assertEqual(res["routine"]["bpmSource"], "routine")

    def test_fit_grid_prefers_period_with_heads_on_every_line(self):
        starts = [k * 3.0 + 0.4 for k in range(10)]
        period, phase = fit_grid(starts, 3.1)
        self.assertAlmostEqual(period, 3.0, delta=0.05)
        self.assertAlmostEqual(phase % period, 0.4, delta=0.1)

    def test_idempotent(self):
        res = {"routine": {"moves": [mv(0.2), mv(2.6, "cbl"), mv(3.1, "left_turn"), mv(5.1)]}}
        normalize(res, {}, duration=8.0)
        first = [dict(m) for m in res["routine"]["moves"]]
        normalize(res, {}, duration=8.0)
        self.assertEqual(res["routine"]["moves"], first)


def swaps_on_grid(period, head, n, beat_pos=SWAP_BEAT, jitter=(0.0,), skip=(), drift=0.0, span=None):
    """8 カウントの頭 head + k×period（drift ありなら grid_cycles に沿って）の beat_pos 拍目に入れ替わりを置く"""
    out = []
    span = span or period * n
    for k in range(n):
        if k in skip:
            continue
        # grid_cycles(t) = k + beat_pos/8 + head/period を解く（drift=0 なら直接）
        target = k + beat_pos / 8 + head / period
        lo, hi = 0.0, span * 2
        for _ in range(60):
            mid = (lo + hi) / 2
            if grid_cycles(mid, period, drift, span) < target:
                lo = mid
            else:
                hi = mid
        out.append(round(lo + jitter[k % len(jitter)], 3))
    return out


def cbl_events(times):
    return [{"t": t, "type": "CBL", "by": "pair"} for t in times]


class SwapGridTest(unittest.TestCase):
    JIT = (0.0, 0.25, -0.2, 0.1, -0.3, 0.15, 0.3, -0.1)

    def test_fits_period_and_phase_from_swaps(self):
        # 本当は 1×8 = 2.6 秒・頭 0.5 秒。Claude の routine の目安は 2.4 秒（ずれている）。
        # 入れ替わりは SWAP_BEAT 拍目付近（±0.3 秒）で、ところどころ抜けている
        sw = swaps_on_grid(2.6, 0.5, 50, jitter=self.JIT, skip={3, 9, 10, 22, 31, 40})
        fit = fit_grid_to_swaps(sw, 2.4, 130.0)
        self.assertIsNotNone(fit)
        self.assertAlmostEqual(fit["period"], 2.6, delta=0.01)
        heads = swap_heads(fit, 130.0)
        # 頭の時刻が本当の頭（0.5 + k×2.6）から 1 拍未満
        for h in heads:
            if 0 <= h <= 125:
                d = (h - 0.5) / 2.6
                self.assertLess(abs(d - round(d)) * 8, 1.0, h)

    def test_too_few_or_scattered_swaps_give_none(self):
        self.assertIsNone(fit_grid_to_swaps([1.0, 3.6, 6.2], 2.4, 10.0))
        # でたらめな時刻の（周期の無い）入れ替わり
        # 入れ替わりだけの z の門（既定 4.5）はでたらめな時刻も通しうる（README 26: 偶然でも z の 90% 点 5.8）。
        # 門そのものが効くことは厳しい値で確かめる
        import normalize_routine as nr
        rng = random.Random(7)
        scattered = sorted(round(rng.uniform(0, 150), 2) for _ in range(40))
        old = nr.SWAP_MIN_Z
        try:
            nr.SWAP_MIN_Z = 7.5
            self.assertIsNone(fit_grid_to_swaps(scattered, 2.4, 150.0))
        finally:
            nr.SWAP_MIN_Z = old

    def test_slow_tempo_drift(self):
        # 終わりまでに等速の格子から 1½ 個ぶん先へ進む（テンポがゆっくり上がる）
        sw = swaps_on_grid(2.6, 0.5, 60, drift=1.5, span=156.0, jitter=(0.0, 0.05, -0.05))
        fit = fit_grid_to_swaps(sw, 2.6, 156.0)
        self.assertIsNotNone(fit)
        self.assertAlmostEqual(fit["drift"], 1.5, delta=0.3)
        # 終わりの方でも入れ替わりが SWAP_BEAT 拍目付近に来る
        heads = swap_heads(fit, 156.0)
        for s in sw[-10:]:
            h = max(x for x in heads if x <= s - 2 * 2.6 / 8)
            beat = (s - h) / (2.6 / 8)
            self.assertAlmostEqual(beat, SWAP_BEAT, delta=1.0)

    def test_turns_do_not_move_the_fit_by_default(self):
        # 既定（SWAP_FIT_TURNS = False）では女性のターンを足しても引いても当てはめは変わらない（README 26）
        sw = swaps_on_grid(2.6, 0.5, 50, jitter=self.JIT, skip={3, 9, 10, 22, 31, 40})
        rng = random.Random(3)
        turns = sorted(round(rng.uniform(0, 130), 2) for _ in range(30))
        a = fit_grid_to_swaps(sw, 2.4, 130.0)
        b = fit_grid_to_swaps(sw, 2.4, 130.0, turns=turns)
        self.assertEqual((a["period"], a["drift"], a["head0"]), (b["period"], b["drift"], b["head0"]))

    def test_dropping_one_swap_keeps_the_grid(self):
        # 入れ替わりを 1 つ抜いても格子を捨てない・頭が 1 拍以上動かない
        sw = swaps_on_grid(2.6, 0.5, 50, jitter=self.JIT, skip={3, 9, 10, 22, 31, 40})
        base = swap_heads(fit_grid_to_swaps(sw, 2.4, 130.0), 130.0)
        for k in range(0, len(sw), 5):
            fit = fit_grid_to_swaps(sw[:k] + sw[k + 1:], 2.4, 130.0)
            self.assertIsNotNone(fit, k)
            heads = swap_heads(fit, 130.0)
            for h in heads:
                if 5 <= h <= 125:
                    self.assertLess(min(abs(h - x) for x in base) / (2.6 / 8), 1.0, (k, h))

    def test_outlier_rejection_drops_off_phase_swaps(self):
        import normalize_routine as nr
        sw = swaps_on_grid(2.6, 0.5, 50, jitter=self.JIT)
        bad = [round(s + 4 * 2.6 / 8, 2) for s in sw[5:45:8]]   # 4 拍ずれた入れ替わり（1 行の 2 回目の通過など）
        old = nr.SWAP_OUTLIER_BEATS
        try:
            nr.SWAP_OUTLIER_BEATS = 2.5
            fit = fit_grid_to_swaps(sorted(sw + bad), 2.4, 130.0)
        finally:
            nr.SWAP_OUTLIER_BEATS = old
        self.assertEqual(fit["inliers"], len(sw))
        self.assertAlmostEqual(fit["period"], 2.6, delta=0.01)
        self.assertNotIn("inliers", fit_grid_to_swaps(sorted(sw + bad), 2.4, 130.0))

    def test_chance_gate_rejects_most_random_swap_sets(self):
        # でたらめな時刻（50 個・158 秒）は周期を探すと z ≥ 4.5 を 3 割ほど通る（README 26）。
        # 2 倍の揃い z2（SWAP_MIN_Z2）を足すと大半を落とす（README 27: 600 回で 28〜30% → 3〜5%）
        rng = random.Random(11)
        passed_z = passed_gate = 0
        for _ in range(25):
            ts = []
            while len(ts) < 50:
                t = rng.uniform(0, 158.0)
                if all(abs(t - u) >= 0.6 for u in ts):
                    ts.append(t)
            ts.sort()
            passed_z += fit_grid_to_swaps(ts, 2.6, 158.0, chance_gate=False) is not None
            passed_gate += fit_grid_to_swaps(ts, 2.6, 158.0) is not None
        self.assertGreaterEqual(passed_z, 4)
        self.assertLessEqual(passed_gate, 2)
        self.assertLess(passed_gate, passed_z)

    def test_chance_gate_keeps_on2_swaps_with_second_passes(self):
        # 8 カウントの SWAP_BEAT 拍目の入れ替わりに、4 拍後の 2 回目の通過・揃わない誤検出が混じる（1230b3d5 のような形）
        rng = random.Random(4)
        sw = swaps_on_grid(2.6, 0.5, 55, jitter=self.JIT, skip={3, 9, 10, 22, 31, 40, 47})
        second = [round(s + 4 * 2.6 / 8 + rng.uniform(-0.2, 0.2), 2) for s in sw[2::4]]
        noise = [round(rng.uniform(0, 143.0), 2) for _ in range(8)]
        fit = fit_grid_to_swaps(sorted(sw + second + noise), 2.6, 143.0)
        self.assertIsNotNone(fit)
        self.assertGreaterEqual(fit["z2"], 2.5)
        self.assertAlmostEqual(fit["period"], 2.6, delta=0.01)

    def test_chance_gate_only_for_pts_events(self):
        # summary.frameClock が "pts" のジョブだけ門を掛ける（コマ番号 / fps の古いジョブは z2 が崩れるので掛けない）
        import normalize_routine as nr
        seen = []
        orig = nr.fit_grid_to_swaps

        def spy(*a, **kw):
            seen.append(kw.get("chance_gate"))
            return orig(*a, **kw)
        sw = swaps_on_grid(2.6, 0.3, 30, jitter=self.JIT)
        moves = [{"start": round(0.3 + k * 2.4, 2), "move": "cbl", "counts": 8} for k in range(30)]
        nr.fit_grid_to_swaps = spy
        try:
            for clock in (None, "index", "pts"):
                summary = {"events": [{"t": s, "type": "CBL", "by": "pair"} for s in sw]}
                if clock:
                    summary["frameClock"] = clock
                normalize({"routine": {"moves": [dict(m) for m in moves]}}, summary, 80.0)
        finally:
            nr.fit_grid_to_swaps = orig
        self.assertEqual(seen, [False, False, True])

    def test_no_drift_when_not_needed(self):
        sw = swaps_on_grid(2.6, 0.5, 50, jitter=self.JIT)
        self.assertEqual(fit_grid_to_swaps(sw, 2.4, 130.0)["drift"], 0.0)

    def test_silent_video_uses_swaps_for_tempo(self):
        # 本当の 1×8 = 2.6 秒。Claude は 2.4 秒おきに行を書いた（前回の正規化で bpm 200 と決めてある）
        n = 30
        sw = swaps_on_grid(2.6, 0.3, n, jitter=self.JIT)
        moves = [mv(round(k * 2.4, 2), "cbl") for k in range(n)]
        res = {"routine": {"bpm": 200, "bpmSource": "routine", "moves": moves}}
        normalize(res, {"beatGrid": None, "events": cbl_events(sw)}, duration=n * 2.6)
        g = res["routine"]["grid"]
        self.assertEqual(g["source"], "swaps")
        self.assertAlmostEqual(g["unitSec"], 2.6, delta=0.02)
        self.assertEqual(res["routine"]["bpm"], round(60 / g["beatSec"]))   # 古い bpm 200 を決め直す
        self.assertEqual(res["routine"]["bpmSource"], "swaps")
        starts = [m["start"] for m in res["routine"]["moves"]]
        for a, b in zip(starts[1:], starts[2:]):   # 先頭は 0 秒に切り詰められることがあるので 2 行目から
            n8 = round((b - a) / 2.6)
            self.assertGreaterEqual(n8, 1)
            # 位相補正（PHASE_ROW_*）で通過を覆うよう行の頭が最大 1 拍ほど動くので、周期の整数倍から 1 拍（0.3 秒）以内
            self.assertAlmostEqual(b - a, n8 * 2.6, delta=0.3)
        # 入れ替わりは各 8 カウントの SWAP_BEAT 拍目付近 = 補正前の頭は入れ替わりの SWAP_BEAT 拍前。
        # 位相補正（README 40）で On2 の期待（通過 1.5 拍 + CV の遅れ 0.4 秒）の位置まで行の頭を SWAP_BEAT − 2.73 ≈ 1.5 拍遅らせる
        self.assertAlmostEqual((starts[5] - 0.3) / 2.6 % 1 * 8 % 8, SWAP_BEAT - 1.5 - 0.4 / 0.325, delta=0.8)

    def test_off_by_one_cbl_rows_are_shifted_onto_swaps(self):
        # 入れ替わりは 2・5・8・… 番目の 8 カウント。Claude の CBL の行はその 1 つ前（1・4・7・…）に書かれている
        n = 30
        cbl_cells = set(range(2, n, 3))
        sw = swaps_on_grid(2.6, 0.0, n, skip=set(range(n)) - cbl_cells, jitter=self.JIT)
        moves = [mv(round(k * 2.6 + 0.1, 2), "cbl" if (k + 1) in cbl_cells else "basic") for k in range(n)]
        res = {"routine": {"moves": moves}}
        normalize(res, {"events": cbl_events(sw)}, duration=n * 2.6)
        self.assertEqual(res["routine"]["grid"]["source"], "swaps")
        out = res["routine"]["moves"]
        cbl_starts = [m["start"] for m in out if m["move"] == "cbl"]
        # CBL の行の時間内に入れ替わりがある
        ends = {m["start"]: m["start"] + m["counts"] * res["routine"]["grid"]["beatSec"] for m in out}
        hit = sum(1 for s in cbl_starts if any(s <= t < ends[s] for t in sw))
        self.assertGreaterEqual(hit, len(cbl_starts) - 1)

    def test_audio_grid_keeps_phase_and_aligns_rows_to_swaps(self):
        # 音声の格子があれば周期・位相は音のまま（入れ替わりで当て直さない）。行の割り当てだけ入れ替わりに合わせる:
        # Claude の CBL の行（4.3 秒）は、入れ替わり（10.8 秒）のある 8 カウント（8.5〜12.5）へ 1 行ずれる
        grid = {"beatGrid": {"bpm": 120, "beatIntervalSec": 0.5, "firstBeatSec": 0.5}}
        res = {"routine": {"moves": [mv(0.6), mv(4.3, "cbl"), mv(8.9), mv(12.6)]}}
        normalize(res, {**grid, "events": cbl_events([10.8])}, duration=16.6)
        moves = res["routine"]["moves"]
        self.assertEqual(res["routine"]["grid"]["source"], "audio")
        self.assertEqual(res["routine"]["grid"]["phaseSec"], 0.5)
        self.assertTrue(all((m["start"] - 0.5) % 4 == 0 for m in moves))
        self.assertEqual([m["move"] for m in moves if m["start"] == 8.5], ["cbl"])
        # 入れ替わりが無ければ従来どおり最寄りの頭
        res2 = {"routine": {"moves": [mv(0.6), mv(4.3, "cbl"), mv(8.9)]}}
        normalize(res2, grid, duration=12.6)
        self.assertEqual([m["start"] for m in res2["routine"]["moves"]], [0.5, 4.5, 8.5])

    def test_idempotent_with_swaps(self):
        sw = swaps_on_grid(2.6, 0.5, 30, jitter=self.JIT)
        res = {"routine": {"moves": [mv(round(k * 2.4, 2), "cbl" if k % 3 else "basic") for k in range(30)]}}
        summary = {"events": cbl_events(sw)}
        normalize(res, summary, duration=80.0)
        first = [dict(m) for m in res["routine"]["moves"]]
        normalize(res, summary, duration=80.0)
        self.assertEqual(res["routine"]["moves"], first)


class SwapTimesTest(unittest.TestCase):
    def test_swap_times_use_hip_crossing(self):
        # analyze_pair は CBL の t を通過に寄せ、腰の交差の時刻を tCross に残す。格子（SWAP_BEAT）は交差で合わせる
        from normalize_routine import swap_times
        summary = {"events": [{"t": 4.6, "tCross": 5.0, "type": "CBL"}, {"t": 9.0, "type": "CBL"},
                              {"t": 7.0, "type": "Turn", "by": "follower"}]}
        self.assertEqual(swap_times(summary), [5.0, 9.0])


class EvalRoutineGridTest(unittest.TestCase):
    def test_counts_cbl_rows_and_swap_phase(self):
        gt = {"evalRange": [0, 20], "cbl": [
            {"t": 1.8, "kind": "cbl"},              # 行 0（0〜2.4）は CBL → 当たり。5.5 拍目くらい（≒ 6 カウント目）
            {"t": 4.2, "kind": "cbl"},              # 行 1（2.4〜4.8）は basic → 外れ
            {"t": 6.0, "kind": "swap", "optional": True},
        ], "turns": [{"t": 5.0, "by": "follower"}]}
        moves = [mv(0.0, "cbl"), mv(2.4, "basic"), mv(4.8, "right_turn", turn={"by": "follower", "rotations": 1})]
        r = evaluate_rows(moves, gt, 0.3, cv_swaps=[1.9, 4.3])
        self.assertEqual((r["cbl"]["hit"], r["cbl"]["n"]), (1, 2))
        self.assertEqual((r["swapAll"]["hit"], r["swapAll"]["n"]), (1, 3))
        self.assertEqual((r["cblRows"]["hit"], r["cblRows"]["n"]), (1, 1))
        self.assertEqual((r["turn"]["hit"], r["turn"]["n"]), (1, 1))
        self.assertEqual(r["phase"]["hist"][6], 2)    # 1.8 秒・4.2 秒 = 行の頭から 6 拍 → カウント 7
        self.assertEqual(r["phase"]["hist"][4], 1)    # 6.0 秒 = 行 2 の頭から 4 拍 → カウント 5
        self.assertAlmostEqual(r["phase"]["in57"], 1.0)
        self.assertEqual(r["cvPhase"]["inCblRow"], 1)


class TurnTest(unittest.TestCase):
    def test_caps_implausible_rotations_and_lowers_confidence(self):
        t, capped = clean_turn({"by": "follower", "direction": "right", "rotations": 4.5},
                               {"evidence": "inferred", "confidence": 0.3})
        self.assertEqual(t["rotations"], 2.0)
        self.assertTrue(capped)

    def test_triple_allowed_only_when_seen_and_confident(self):
        t, capped = clean_turn({"rotations": 3}, {"evidence": "seen", "confidence": 0.8})
        self.assertEqual(t["rotations"], 3.0)
        self.assertFalse(capped)

    def test_rounds_to_half(self):
        t, _ = clean_turn({"rotations": 1.3}, {})
        self.assertEqual(t["rotations"], 1.5)

    def test_capped_row_gets_low_confidence(self):
        res = {"routine": {"moves": [
            mv(0.0, "right_turn", confidence=0.6, evidence="inferred",
               turn={"by": "follower", "direction": "right", "rotations": 3}),
        ]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["turn"]["rotations"], 2.0)
        self.assertLessEqual(m["confidence"], 0.35)


class NameTest(unittest.TestCase):
    def test_short_names_kept(self):
        self.assertEqual(short_name("CBL＋インサイドターン", "cbl_inside_turn"), "CBL＋インサイドターン")

    def test_long_names_shortened(self):
        n = short_name("密着ホールドからのクロスボディリード", "cbl")
        self.assertLessEqual(len(n), NAME_MAX)
        self.assertIn("CBL", n)

    def test_parentheses_dropped_and_question_kept(self):
        self.assertEqual(short_name("ベーシック（42.99 に左右入れ替わり・未確認）", "basic"), "ベーシック")
        self.assertEqual(short_name("リバース・クロスボディリード?", "reverse_cbl"), "リバース・クロスボディリード?")
        self.assertEqual(short_name("リバース・クロスボディリード・ライトターン?", "reverse_cbl"), "逆CBL＋ライトターン?")
        self.assertTrue(short_name("ライトターン?", "right_turn").endswith("?"))

    def test_descriptive_name_falls_back(self):
        n = short_name("手を離したまま男性が自分の手の下をくぐって回る動き", "leader_turn")
        self.assertEqual(n, "男性ターン")
        n2 = short_name("サイドバイサイドで男性の右腕に女性を抱えて歩く", "other")
        self.assertLessEqual(len(n2), NAME_MAX)
        self.assertTrue(n2.endswith("…"))


class StepsTest(unittest.TestCase):
    def test_template_for_inside_turn_uses_turn(self):
        s = template_steps({"move": "cbl_inside_turn", "turn": {"by": "follower", "direction": "left", "rotations": 1.5}}, "on1")
        self.assertEqual([x["count"] for x in s], ["1-2-3", "5-6-7"])
        self.assertIn("左回り（反時計回り）1½回", s[1]["follower"])

    def test_claude_steps_preferred_and_trimmed(self):
        res = {"routine": {"moves": [mv(0.0, "other", steps=[
            {"count": "1-2-3", "leader": "左手を上げる", "follower": "前へ"},
            {"count": "5-6-7", "leader": "x" * 30, "follower": "右回り1回"},
            {"count": "1-2-3", "leader": "余分", "follower": "余分"},
        ])]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["stepsSource"], "claude")
        self.assertEqual(len(m["steps"]), 2)
        self.assertEqual(len(m["steps"][1]["leader"]), 12)

    def test_template_filled_when_missing(self):
        res = {"routine": {"timing": "on1", "moves": [mv(0.0, "basic")]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["stepsSource"], "template")
        self.assertEqual(m["steps"][0], {"count": "1-2-3", "leader": "前へ", "follower": "後ろへ"})

    def test_on2_spot_right_turn_starts_on_1_after_prep_on_5_6_7(self):
        # Eddie Torres On2: その場の右回りは前の 5-6-7 でプレップし、1 から回る（on2-timing-and-terms.md §4）
        s = template_steps({"move": "right_turn", "turn": {"by": "follower", "direction": "right", "rotations": 1}}, "on2")
        self.assertEqual([x["count"] for x in s], ["1-2-3", "5-6-7"])
        self.assertIn("前の5-6-7で準備", s[0]["leader"])
        self.assertIn("1から右回り", s[0]["follower"])
        self.assertEqual(s[1]["follower"], "6で後ろへ")

    def test_on2_left_turn_starts_on_2(self):
        s = template_steps({"move": "left_turn", "turn": {"by": "follower", "direction": "left", "rotations": 1}}, "on2")
        self.assertIn("2から左回り", s[0]["follower"])
        self.assertIn("5で着地", s[1]["follower"])

    def test_on2_cbl_leader_opens_7_to_1_follower_passes_on_2(self):
        # 男は 6 で前へブレイクして 7〜1 で左へ開き、女は 2 で男の左側を通って 3 前後で ½、5 で着地
        s = template_steps({"move": "cbl", "passSide": "left"}, "on2")
        self.assertIn("7-1で左へ開き", s[0]["leader"])
        self.assertEqual(s[0]["follower"], "2で男の左側を通り3で½回る")
        self.assertIn("5で着地", s[1]["follower"])
        self.assertIn("6で前へ", s[1]["leader"])

    def test_on2_cbl_inside_turn_starts_on_2_and_lands_on_5(self):
        s = template_steps({"move": "cbl_inside_turn", "passSide": "left", "leadHand": "L",
                            "turn": {"by": "follower", "direction": "left", "rotations": 1.5, "kind": "inside"}}, "on2")
        self.assertEqual(s[0]["follower"], "2で男の左側を通り左回り1½回（インサイド）")
        self.assertIn("左手を頭上へ上げ内へ回す", s[0]["leader"])
        self.assertIn("3-(4)-5で回り切り5で着地", s[1]["follower"])

    def test_on2_basic_breaks_on_2_and_6(self):
        s = template_steps({"move": "basic"}, "on2")
        self.assertEqual(s[0], {"count": "1-2-3", "leader": "2で右足を後ろへ", "follower": "2で左足を前へ"})
        self.assertEqual(s[1], {"count": "5-6-7", "leader": "6で左足を前へ", "follower": "6で右足を後ろへ"})

    def test_default_timing_is_on2_when_unclear(self):
        res = {"style": {"onBeat": "unclear"}, "routine": {"timing": "unclear", "moves": [
            mv(0.0, "basic", steps=[{"count": "1-2-3", "leader": "前へ", "follower": "後ろへ"}]),
            mv(4.0, "shine", steps=[{"count": "1-8", "leader": "腕を回す", "follower": "髪を払う"}]),
        ]}}
        grid = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}
        normalize(res, grid, duration=8.0)
        r = res["routine"]
        self.assertEqual((r["timing"], r["timingSource"]), ("on2", "default"))
        # ベーシックは On2 の決まった言い回しに置き換え、決まった形の無い技（シャイン等）の Claude の行はそのまま
        self.assertEqual(r["moves"][0]["stepsSource"], "template")
        self.assertEqual(r["moves"][0]["steps"][0]["leader"], "2で右足を後ろへ")
        self.assertEqual(r["moves"][1]["stepsSource"], "claude")
        # もう一度かけても同じ（前回入れた既定を Claude の判断と取り違えない）。--default-onbeat で変えられる
        normalize(res, grid, duration=8.0)
        self.assertEqual(res["routine"]["timingSource"], "default")
        normalize(res, grid, duration=8.0, default_timing="on1")
        self.assertEqual(res["routine"]["timing"], "on1")

    def test_on2_partner_moves_use_template_with_hand_side_and_direction(self):
        # Claude の「手を上げる / 右回り2回」ではなく、欄の値から手・通る側・回る向きを書く
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "cbl_inside_turn", passSide="left", holdStart="LR",
                                                         turn={"by": "follower", "direction": "left", "rotations": 1.5},
                                                         steps=[{"count": "5-6-7", "leader": "頭上で回す", "follower": "左回り1回"}])]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["stepsSource"], "template")
        self.assertEqual(m["leadHand"], "L")
        self.assertEqual(m["steps"][0]["leader"], "7-1で左へ開き左手を頭上へ上げ内へ回す")
        self.assertIn("男の左側を通り", m["steps"][0]["follower"])
        self.assertIn("左回り1½回（インサイド）", m["steps"][0]["follower"])

    def test_claude_on1_is_kept(self):
        res = {"style": {"onBeat": "on1"}, "routine": {"moves": [mv(0.0, "basic")]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=4.0)
        self.assertEqual((res["routine"]["timing"], res["routine"]["timingSource"]), ("on1", "claude"))
        self.assertEqual(res["routine"]["moves"][0]["steps"][0]["leader"], "前へ")


class TurnKindTest(unittest.TestCase):
    """右回り = 回る人自身の右 = 上から見て時計回り。女性のターンは向きだけでインサイド（左回り）/アウトサイド（右回り）。
    つなぎ手が変わっても呼び名は変えない（Dance Dojo の流儀。on2-timing-and-terms.md §3）"""

    def t(self, d, by="follower"):
        return {"by": by, "direction": d, "rotations": 1}

    def test_direction_decides_in_every_hold(self):
        for hold in ("LR", "RR", "RL", "LL", "double", "cross", "closed", "none", None):
            self.assertEqual(turn_kind(self.t("left"), hold), "inside", hold)
            self.assertEqual(turn_kind(self.t("right"), hold), "outside", hold)

    def test_unknown_direction_or_leader_turn(self):
        self.assertIsNone(turn_kind(self.t("left", by="leader"), "LR"))
        self.assertIsNone(turn_kind(self.t(None), "LR"))

    def test_names_follow_direction(self):
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右ターン×2", holdStart="LR", turn={"by": "follower", "direction": "right", "rotations": 2}),
            mv(4.0, "left_turn", name="左ターン", holdStart="RL", turn={"by": "follower", "direction": "left", "rotations": 1}),
            mv(8.0, "right_turn", name="右ターン", turn={"by": "follower", "direction": "right", "rotations": 1}),
            mv(12.0, "cbl_outside_turn", name="CBL＋アウトサイド", holdStart="LL",
               turn={"by": "follower", "direction": "left", "rotations": 1.5}),
            mv(16.0, "leader_turn", name="男性ターン", turn={"by": "leader", "direction": "left", "rotations": 1}),
        ]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}, duration=20.0)
        ms = res["routine"]["moves"]
        self.assertEqual([m["name"] for m in ms],
                         ["右回りターン×2", "左回りターン", "右回りターン", "CBL＋インサイド×1½", "男 左回り"])
        # 女性の左手（RL・LL）でも左回りはインサイド（以前は手で逆にしていた）
        self.assertEqual(ms[1]["turn"]["kind"], "inside")
        self.assertEqual(ms[3]["move"], "cbl_inside_turn")     # 向きで決まる方に合わせる
        self.assertEqual(ms[3]["turn"]["kind"], "inside")
        self.assertEqual(ms[2]["turn"]["kind"], "outside")     # 手が分からなくても向きで決まる
        # 本文は左回り/右回りが先、インサイド/アウトサイドは後ろに添える
        self.assertIn("右回り1回（アウトサイド）", ms[2]["steps"][0]["follower"])
        self.assertIn("左回り1½回（インサイド）", ms[3]["steps"][0]["follower"])


class RotationPriorTest(unittest.TestCase):
    """回転数の事前分布: CBL ½・CBL＋ターン 1½（2½）・その場 1（2）。数が無いときの穴埋めと拍の上限だけに使う"""

    def row(self, move, r, **kw):
        return {"move": move, "turn": {"by": "follower", "direction": "left", "rotations": r}, **kw}

    def test_counts_are_not_snapped_to_the_prior(self):
        # 目安（CBL＋ターン 1½・その場 1）と違う数でも寄せない。目安より多い数を下げない（正解表では多く回るのが普通）
        for move, r in (("cbl_inside_turn", 1.0), ("cbl_inside_turn", 2.0), ("cbl_inside_turn", 3.0),
                        ("left_turn", 1.5), ("right_turn", 2.0), ("left_turn", 3.0)):
            m = self.row(move, r)
            self.assertIsNone(apply_rotation_prior(m, None, 0.32), (move, r))
            self.assertEqual(m["turn"]["rotations"], r)

    def test_missing_count_is_filled(self):
        # 数が無いときだけ埋める: CV の数（同じ向き）があればそれ、無ければ技の普通の回数
        m = self.row("cbl_inside_turn", None)
        self.assertEqual(apply_rotation_prior(m, None, 0.32), "rotations:None->1.5(prior)")
        self.assertEqual(m["turn"]["rotations"], 1.5)
        m2 = self.row("left_turn", None)
        apply_rotation_prior(m2, {"dir": "left", "turns": 2.0, "dur": 1.0}, 0.32)
        self.assertEqual((m2["turn"]["rotations"], m2["turn"]["rotationSource"]), (2.0, "cv"))
        m3 = self.row("cbl_inside_turn", None)
        apply_rotation_prior(m3, {"dir": "right", "turns": 2.0, "dur": 1.0}, 0.32)   # 逆向きの CV は使わない
        self.assertEqual(m3["turn"]["rotations"], 1.5)

    def test_never_more_rotations_than_beats(self):
        # 1 回転に最低 1 拍。使える拍は 4（CV の回転区間が長ければその拍数）
        m = self.row("right_turn", 6.0, evidence="seen", confidence=0.9)
        self.assertEqual(apply_rotation_prior(m, None, 0.32), "rotations:6.0->4.0(beats)")
        m2 = self.row("right_turn", 6.0, evidence="seen", confidence=0.9)
        apply_rotation_prior(m2, {"dir": "left", "turns": 6.0, "dur": 0.32 * 5}, 0.32)
        self.assertEqual(m2["turn"]["rotations"], 5.0)

    def test_leader_turn_and_unknown_moves_untouched(self):
        self.assertIsNone(apply_rotation_prior({"move": "wrap", "turn": {"by": "follower", "rotations": 0.5}}, None, 0.32))
        self.assertIsNone(apply_rotation_prior({"move": "cbl", "turn": None}, None, 0.32))

    def test_card2_of_581ef6a2(self):
        # 581ef6a2 の 0:01.76: Claude「右回り2回」→ CV の向き（左）で直して CV の回数 1 → CBL＋インサイドなら 1½。
        # 全フレームの spin は「左 1 → 右 3」と向きが混ざっていて向き・回数の証拠にならない。向きは 10fps の
        # 反転列（spinCoarse、ジョブ 0ea16b69 の実データは "LL" = 左 1）で決める
        spin = {"t": 3.96, "type": "Turn", "by": "follower", "spinCoarse": {"seq": "LL", "netDeg": -360},
                "spin": {"from": 3.57, "to": 6.3, "runs": [{"dir": "left", "turns": 1.0}, {"dir": "right", "turns": 3.0}],
                         "source": "fullFrames"}}
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "cbl_inside_turn", name="CBL＋インサイド", passSide="left", confidence=0.4, evidence="seen",
               turn={"by": "follower", "direction": "right", "rotations": 2})]}}
        normalize(res, {"beatGrid": {"beatIntervalSec": 0.32, "firstBeatSec": 0.0}, "events": [
            {**spin, "t": 1.0, "spin": {**spin["spin"], "from": 0.9, "to": 2.5}}]}, duration=2.56)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["turn"]["direction"], "left")
        self.assertEqual(m["turn"]["rotations"], 1.0)      # CV の最初のはっきりした回転（左 1）。目安の 1½ には寄せない
        self.assertNotIn("rotationSource", m["turn"])
        self.assertEqual(m["name"], "CBL＋インサイド?")
        self.assertEqual(res["routine"]["rotationChecks"], 0)


class TempoRangeTest(unittest.TestCase):
    def test_half_tempo_is_doubled_and_range_clamped(self):
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 95), 8 * 60 / 190)    # 95 BPM → 190
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 186), 8 * 60 / 186)   # そのまま
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 300), 8 * 60 / 250)   # 速すぎ → 250
        self.assertAlmostEqual(salsa_unit8(8 * 60 / 140), 8 * 60 / 150)   # 遅すぎ → 150
        self.assertIsNone(salsa_unit8(None))


def _tracks(sides_by_t, leader_pid=1):
    """女性の側（"left"/"right"）の時系列 → tracks.json の frames（pid 0/1 の腰の X）"""
    frames = []
    for t, side in sides_by_t:
        fx, lx = (0.7, 0.3) if side == "right" else (0.3, 0.7)
        frames.append({"t": t, "kept": [{"pid": leader_pid, "hipX": lx}, {"pid": 1 - leader_pid, "hipX": fx}]})
    return {"leaderPid": leader_pid, "frames": frames}


class PairSidesTest(unittest.TestCase):
    def test_runs_and_crossing_skip_single_frame_flip(self):
        series = [(0.0, "left"), (0.1, "left"), (0.2, "right"), (0.3, "left"), (0.4, "left"),
                  (1.0, "right"), (1.1, "right"), (1.2, "right")]
        runs = pair_sides.settled_runs(series)
        self.assertEqual([r["side"] for r in runs], ["left", "right"])
        cs = pair_sides.crossings(runs)
        self.assertEqual(len(cs), 1)
        self.assertAlmostEqual(cs[0]["t"], 0.7)
        self.assertEqual((cs[0]["from"], cs[0]["to"]), ("left", "right"))
        self.assertEqual(pair_sides.side_before(runs, 0.6), "left")
        self.assertEqual(pair_sides.side_after(runs, 0.6), "right")

    def test_follower_series_uses_leader_pid(self):
        tr = _tracks([(0.0, "right")], leader_pid=0)
        self.assertEqual(pair_sides.follower_series(tr), [(0.0, "right")])


class PassCheckTest(unittest.TestCase):
    """CV の立ち位置で、パスの無い技なのに左右が入れ替わった行を CBL 系に付け替える（0:01.76「右ターン×2」）"""
    GRID = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}

    def summary(self, cbl_ts, turns=()):
        ev = [{"t": t, "type": "CBL", "by": "pair", "pass": {"side": "left"},
               "handRaise": {"raised": True, "hand": "L"}} for t in cbl_ts]
        ev += list(turns)
        return {**self.GRID, "events": ev}

    def test_in_place_turn_with_swap_becomes_cbl_turn(self):
        # 0〜4 秒: 女は右 → 2.5 秒で左へ。4〜8 秒: 左のまま
        tracks = _tracks([(t / 10, "right") for t in range(0, 22)] + [(t / 10, "left") for t in range(28, 80)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右ターン×2?", turn={"by": "follower", "direction": "right", "rotations": 2}),
            mv(4.0, "basic", name="ベーシック"),
        ]}}
        normalize(res, self.summary([2.8]), duration=8.0, tracks=tracks)
        a, b = res["routine"]["moves"]
        self.assertEqual(a["sides"]["followerStart"], "right")
        self.assertEqual(a["sides"]["followerEnd"], "left")
        self.assertEqual(a["sides"]["swapAt"], [2.45])   # 隠れていた 2.1〜2.8 秒の中点
        self.assertEqual(a["move"], "cbl_outside_turn")
        self.assertEqual(a["passSide"], "left")
        self.assertEqual(a["leadHand"], "L")                   # CV が見た頭上の手
        self.assertTrue(a["passCheck"].startswith("swapButNoPass"))
        self.assertTrue(a["name"].endswith("?"))
        self.assertEqual(b["move"], "basic")
        self.assertNotIn("passCheck", b)
        self.assertEqual(res["routine"]["passChecks"], 1)

    def test_swap_without_cv_event_is_not_trusted(self):
        # 密着中の腰の重なり（CV の CBL イベントが無い）では付け替えない
        tracks = _tracks([(t / 10, "right") for t in range(0, 22)] + [(t / 10, "left") for t in range(28, 40)])
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "basic", name="ベーシック")]}}
        normalize(res, self.summary([]), duration=4.0, tracks=tracks)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["move"], "basic")
        self.assertEqual(m["sides"]["swapAt"], [])

    def test_cbl_without_swap_gets_question_mark_only(self):
        tracks = _tracks([(t / 10, "left") for t in range(0, 40)])
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "cbl", name="CBL", confidence=0.9)]}}
        normalize(res, self.summary([]), duration=4.0, tracks=tracks)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["move"], "cbl")
        self.assertEqual(m["name"], "CBL?")
        self.assertLessEqual(m["confidence"], 0.35)

    def test_inside_turn_takes_unclaimed_nearby_swap(self):
        # インサイドターンは CBL と組む: 前の行（シャイン）の終わりの入れ替わりは、この行の CBL＋インサイドのもの
        tracks = _tracks([(t / 10, "right") for t in range(0, 34)] + [(t / 10, "left") for t in range(38, 120)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "shine", name="シャイン"),
            mv(4.0, "left_turn", name="左ターン", holdStart="LR", turn={"by": "follower", "direction": "left", "rotations": 1}),
            mv(8.0, "basic", name="ベーシック"),
        ]}}
        normalize(res, self.summary([3.7]), duration=12.0, tracks=tracks)
        a, b, c = res["routine"]["moves"]
        self.assertEqual(a["sides"]["swapAt"], [3.55])
        self.assertEqual(b["move"], "cbl_inside_turn")
        self.assertEqual(b["name"], "CBL＋インサイド?")   # 回転 1 は目安（1½）に寄せない
        self.assertEqual(b["turn"]["rotations"], 1)
        self.assertTrue(b["passCheck"].startswith("turnNearSwap"))

    def test_right_turn_takes_unclaimed_nearby_swap_as_cbl_outside(self):
        # 右回りも同じ（女の手に関係なく右回り = アウトサイド）
        tracks = _tracks([(t / 10, "right") for t in range(0, 34)] + [(t / 10, "left") for t in range(38, 120)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "shine", name="シャイン"),
            mv(4.0, "right_turn", name="右ターン", holdStart="RL", turn={"by": "follower", "direction": "right", "rotations": 1}),
            mv(8.0, "basic", name="ベーシック"),
        ]}}
        normalize(res, self.summary([3.7]), duration=12.0, tracks=tracks)
        b = res["routine"]["moves"][1]
        self.assertEqual(b["move"], "cbl_outside_turn")
        self.assertEqual(b["name"], "CBL＋アウトサイド?")
        self.assertTrue(b["passCheck"].startswith("turnNearSwap:right_turn->cbl_outside_turn"))

    def test_left_turn_without_swap_stays_in_place_left_turn(self):
        # 入れ替わりの無い左回転は普通の「左回りターン」（on2-timing-and-terms.md §8-7）。「?」は付けない
        tracks = _tracks([(t / 10, "left") for t in range(0, 80)])
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "cbl", name="CBL"),
            mv(4.0, "left_turn", name="左ターン", holdStart="LR", turn={"by": "follower", "direction": "left", "rotations": 1}),
        ]}}
        normalize(res, self.summary([]), duration=8.0, tracks=tracks)
        b = res["routine"]["moves"][1]
        self.assertEqual(b["move"], "left_turn")
        self.assertEqual(b["name"], "左回りターン")
        self.assertEqual(b["turn"]["kind"], "inside")
        self.assertNotIn("passCheck", b)

    def test_no_tracks_no_sides(self):
        res = {"routine": {"timing": "on2", "moves": [mv(0.0, "basic")]}}
        normalize(res, self.summary([2.0]), duration=4.0)
        self.assertNotIn("sides", res["routine"]["moves"][0])

    def test_mixed_dense_runs_alone_do_not_flip_claude(self):
        # 全フレームの spin が「左 1 → 右 3」と混ざり、10fps の読みも無ければ向きは決めない（Claude のまま）
        spin = {"t": 1.5, "type": "Turn", "by": "follower",
                "spin": {"from": 1.2, "to": 2.0, "runs": [{"dir": "left", "turns": 1.0}, {"dir": "right", "turns": 3.0}],
                         "source": "fullFrames"}}
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右ターン×2", holdStart="LR", turn={"by": "follower", "direction": "right", "rotations": 2})]}}
        normalize(res, self.summary([], [spin]), duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["turn"]["direction"], "right")
        self.assertNotIn("directionCheck", m)

    def test_direction_follows_cv_spin_when_claude_disagrees(self):
        spin = {"t": 1.5, "type": "Turn", "by": "follower", "spinCoarse": {"seq": "LL", "netDeg": -360},
                "spin": {"from": 1.2, "to": 2.0, "runs": [{"dir": "left", "turns": 1.0}, {"dir": "right", "turns": 3.0}],
                         "source": "fullFrames"}}
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "right_turn", name="右ターン×2", holdStart="LR", turn={"by": "follower", "direction": "right", "rotations": 2})]}}
        normalize(res, self.summary([], [spin]), duration=4.0)
        m = res["routine"]["moves"][0]
        self.assertEqual(m["turn"]["direction"], "left")
        self.assertEqual(m["turn"]["claudeDirection"], "right")
        self.assertEqual(m["turn"]["rotations"], 1.0)
        self.assertEqual(m["turn"]["kind"], "inside")
        self.assertEqual(m["move"], "left_turn")                # 技の種類も向きに合わせる
        self.assertEqual(m["name"], "左回りターン?")
        self.assertIn("2から左回り1回（インサイド）", m["steps"][0]["follower"])
        self.assertEqual(res["routine"]["directionChecks"], 1)


class InferHoldTest(unittest.TestCase):
    """手が分からない女性のターンは、男が頭上に上げた手（CV）から普通のつなぎを推す（0:01.76「CBL＋女左回り?」）"""
    GRID = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}

    def run_one(self, direction, hand, hold=None, cv_hold=None, timeline=None):
        ev = [{"t": 2.0, "type": "CBL", "by": "pair", "hold": cv_hold, "handRaise": {"raised": True, "hand": hand}}]
        summary = {**self.GRID, "events": ev, "holdTimeline": timeline or []}
        move = "left_turn" if direction == "left" else "right_turn"
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, move, name="ターン", holdStart=hold, holdEnd=hold,
               turn={"by": "follower", "direction": direction, "rotations": 1})]}}
        normalize(res, summary, duration=4.0)
        return res["routine"]["moves"][0]

    def test_left_hand_raised_means_her_right_hand(self):
        m = self.run_one("left", "L")
        self.assertEqual(m["inferredHold"], "LR")
        self.assertEqual(m["holdSource"], "inferred")
        self.assertEqual(m["turn"]["kind"], "inside")
        self.assertEqual(m["name"], "左回りターン")           # 推しただけでは「?」を付けない
        self.assertIsNone(m["holdStart"])                    # 見えたつなぎの欄は書き換えない
        self.assertEqual(m["leadHand"], "L")
        self.assertEqual(self.run_one("right", "L")["turn"]["kind"], "outside")

    def test_right_hand_raised_gives_her_left_hand_but_same_kind(self):
        # 女の左手でつないでも、インサイド/アウトサイドは向きだけで決まる（以前は逆にしていた）
        m = self.run_one("left", "R")
        self.assertEqual(m["inferredHold"], "RL")
        self.assertEqual(m["leadHand"], "R")
        self.assertEqual(m["turn"]["kind"], "inside")
        self.assertEqual(self.run_one("right", "R")["turn"]["kind"], "outside")

    def test_no_inference_when_data_shows_cross_or_same_side_hold(self):
        for kw in ({"hold": "cross"}, {"hold": "none"}, {"cv_hold": "リーダー右手×フォロワー右手"},
                   {"timeline": [{"from": 1.0, "to": 1.5, "hold": "リーダー左手×フォロワー左手"}]}):
            m = self.run_one("left", "L", **kw)
            self.assertNotIn("inferredHold", m, kw)
            self.assertEqual(m["turn"]["kind"], "inside", kw)

    def test_seen_hold_wins(self):
        m = self.run_one("left", "L", hold="RL")   # 見えたつなぎ（女の左手）が優先。上げた手からは推さない
        self.assertNotIn("inferredHold", m)
        self.assertEqual(m["leadHand"], "R")
        self.assertEqual(m["turn"]["kind"], "inside")


class CardFixTest(unittest.TestCase):
    """1×8 に入れ替わり 2 回（CBL×2）・女性のターンを主にする（男のターンは leaderTurn）"""
    GRID = {"beatGrid": {"beatIntervalSec": 0.5, "firstBeatSec": 0.0}}

    def cbl(self, t, side="left"):
        return {"t": t, "type": "CBL", "by": "pair", "pass": {"side": side}}

    def turn(self, t, by, d, n):
        return {"t": t, "type": "Turn", "by": by, "spin": {"from": t, "to": t + 0.6, "runs": [{"dir": d, "turns": n}]}}

    def test_other_with_two_swaps_becomes_cbl_x2(self):
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "other", name="アラウンド・ザ・ワールド"), mv(4.0, "other", name="CBL→アンダーアーム"),
            mv(8.0, "wrap", name="ラップ", turn={"by": "follower", "direction": "left", "rotations": 1.5}),
            mv(12.0, "other", name="終わりのポーズ")]}}
        ev = [self.cbl(1.0, "left"), self.cbl(3.0, "left"), self.cbl(5.0, "left"), self.cbl(7.0, "right"), self.cbl(9.5)]
        normalize(res, {**self.GRID, "events": ev}, duration=16.0)
        a, b, c, d = res["routine"]["moves"]
        self.assertEqual((a["move"], a["name"], a["swapCount"]), ("cbl", "CBL×2?", 2))
        self.assertEqual(a["claudeName"], "アラウンド・ザ・ワールド")
        self.assertEqual((b["move"], b["name"]), ("cbl", "CBL＋逆CBL?"))      # 通る側が逆
        self.assertEqual(c["move"], "cbl_inside_turn")                         # 1 回 + 女性の左回り
        self.assertEqual((d["move"], d["name"]), ("other", "終わりのポーズ"))  # 入れ替わりの無い other はそのまま
        # 振付シートの評価でも入れ替わりの行になる
        gt = {"cbl": [{"t": 1.2, "kind": "cbl"}, {"t": 3.1, "kind": "cbl"}, {"t": 5.2, "kind": "cbl"}], "turns": []}
        self.assertEqual(evaluate_rows(res["routine"]["moves"], gt, 0.5)["cbl"]["acc"], 1.0)

    def test_follower_turn_is_primary_and_leader_turn_moves_aside(self):
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "leader_turn", name="男 右回り", turn={"by": "leader", "direction": "right", "rotations": 1}),
            mv(4.0, "basic", name="ベーシック"),
            mv(8.0, "hand_change", name="持ち替え"),
            mv(12.0, "basic", name="ベーシック")]}}
        ev = [self.turn(1.0, "follower", "left", 1.5), self.turn(5.0, "follower", "right", 2.0),
              self.turn(9.0, "follower", "right", 0.5)]      # ½ 回転だけの CV は付けない
        normalize(res, {**self.GRID, "events": ev}, duration=16.0)
        a, b, c, d = res["routine"]["moves"]
        self.assertEqual(a["move"], "left_turn")
        self.assertEqual(a["turn"], {**a["turn"], "by": "follower", "direction": "left", "rotations": 1.5})
        self.assertEqual(a["leaderTurn"], {"direction": "right", "rotations": 1})
        self.assertEqual(a["name"], "左回りターン×1½?")
        self.assertEqual((b["move"], b["turn"]["direction"], b["turn"]["rotations"]), ("right_turn", "right", 2.0))
        self.assertTrue(b["name"].endswith("?"))
        self.assertEqual(c["move"], "hand_change")
        self.assertEqual(d["move"], "basic")

    def test_merged_leader_turn_kept_as_leader_turn(self):
        res = {"routine": {"timing": "on2", "moves": [
            mv(0.0, "left_turn", name="左回り", confidence=0.8, turn={"by": "follower", "direction": "left", "rotations": 1}),
            mv(0.8, "leader_turn", name="男 右回り", confidence=0.4, turn={"by": "leader", "direction": "right", "rotations": 1})]}}
        normalize(res, self.GRID, duration=4.0)
        (m,) = res["routine"]["moves"]
        self.assertEqual(m["turn"]["by"], "follower")
        self.assertEqual(m["leaderTurn"], {"direction": "right", "rotations": 1})


class PhaseShiftTest(unittest.TestCase):
    """カウントの位相（README 40）: 行の頭を通過の位置で補正し、通過が行から出ないようにする"""

    BEAT = 0.3

    def test_late_swaps_shift_head_later(self):
        from normalize_routine import PHASE_CV_DELAY_SEC, PHASE_PASS_BEAT, phase_shift_beats
        starts = [k * 8 * self.BEAT for k in range(10)]
        want = PHASE_PASS_BEAT + PHASE_CV_DELAY_SEC / self.BEAT
        swaps = [s + (want + 1.0) * self.BEAT for s in starts]   # 期待より 1 拍遅く出る → 行の頭を 1 拍遅らせる
        self.assertAlmostEqual(phase_shift_beats(starts, self.BEAT, swaps), 1.0, places=3)
        swaps = [s + (want - 1.0) * self.BEAT for s in starts]
        self.assertAlmostEqual(phase_shift_beats(starts, self.BEAT, swaps), -1.0, places=3)

    def test_needs_concentration_and_several_swaps(self):
        from normalize_routine import phase_shift_beats
        starts = [k * 8 * self.BEAT for k in range(10)]
        self.assertEqual(phase_shift_beats(starts, self.BEAT, [starts[2] + 3 * self.BEAT]), 0.0)   # 1 件では決めない
        spread = [s + (k * 3 % 8) * self.BEAT for k, s in enumerate(starts)]                        # 散らばり
        self.assertEqual(phase_shift_beats(starts, self.BEAT, spread), 0.0)
        self.assertEqual(phase_shift_beats(starts, self.BEAT, []), 0.0)

    def test_shift_is_capped(self):
        from normalize_routine import PHASE_MAX_SHIFT, phase_shift_beats
        starts = [k * 8 * self.BEAT for k in range(10)]
        swaps = [s + 7.5 * self.BEAT for s in starts]
        self.assertLessEqual(abs(phase_shift_beats(starts, self.BEAT, swaps)), PHASE_MAX_SHIFT)

    def test_explicit_delay_moves_target(self):
        # delay を渡すと目標が delay / 拍 だけ動く（既定 PHASE_CV_DELAY_SEC と同じ値なら同じ）
        from normalize_routine import PHASE_CV_DELAY_SEC, PHASE_PASS_BEAT, phase_shift_beats
        starts = [k * 8 * self.BEAT for k in range(10)]
        swaps = [s + (PHASE_PASS_BEAT + 1.0) * self.BEAT + 0.2 for s in starts]
        self.assertAlmostEqual(phase_shift_beats(starts, self.BEAT, swaps, 0.2), 1.0, places=3)
        self.assertAlmostEqual(phase_shift_beats(starts, self.BEAT, swaps, PHASE_CV_DELAY_SEC),
                               phase_shift_beats(starts, self.BEAT, swaps), places=6)

    def test_cv_delay_estimate(self):
        # 腰の X の差が tCross の 0.2 秒前に 0 を横切る合成の tracks から、遅れ 0.2 秒を読む
        from normalize_routine import PHASE_DELAY_MIN_N, cv_delay_estimate
        swaps = [2.0 + 3.0 * k for k in range(6)]
        frames = []
        for k, tc in enumerate(swaps):
            z = tc - 0.2            # 本当の通過
            for dt in (-0.4, -0.3, 0.2, 0.3):   # 通過の前後（直前コマ z-0.3 → 直後コマ z+0.4 = tc+0.2 で 0 を挟む）
                t = round(z + dt, 3)
                x = (t - z)
                frames.append({"t": t, "kept": [{"pid": 0, "hipX": 0.5 + x}, {"pid": 1, "hipX": 0.5}]})
        tr = {"frames": sorted(frames, key=lambda f: f["t"])}
        d, n = cv_delay_estimate(tr, swaps)
        self.assertEqual(n, 6)
        self.assertIsNotNone(d)
        self.assertGreaterEqual(n, PHASE_DELAY_MIN_N)
        self.assertAlmostEqual(d, 0.2, delta=0.06)
        # 件数が足りない・tracks が無いときは None（呼び出し側は PHASE_CV_DELAY_SEC に戻る）
        self.assertIsNone(cv_delay_estimate(tr, swaps[:2])[0])
        self.assertEqual(cv_delay_estimate(None, swaps), (None, 0))

    def test_rows_keep_their_passes(self):
        from normalize_routine import PHASE_CV_DELAY_SEC, PHASE_ROW_AFTER, PHASE_ROW_BEFORE, shift_row_starts
        starts = [0.0, 2.4, 4.8]
        # 2 行目の通過が行の頭の 0.5 拍後 → 1 拍遅らせると通過が前の行に出るので、通過の PHASE_ROW_BEFORE 拍前で止める
        passes = [2.4 + 0.5 * self.BEAT]
        new = shift_row_starts(starts, self.BEAT, 1.0, [p + PHASE_CV_DELAY_SEC for p in passes])
        self.assertAlmostEqual(new[1], passes[0] - PHASE_ROW_BEFORE * self.BEAT, places=6)
        self.assertLessEqual(new[1], passes[0])
        # 前の行の通過が次の行へ入らない（頭を早める向きでも前の行の通過の後ろまで）
        passes = [1.8]
        new = shift_row_starts(starts, self.BEAT, -2.0, [p + PHASE_CV_DELAY_SEC for p in passes])
        self.assertGreaterEqual(new[1], passes[0] + PHASE_ROW_AFTER * self.BEAT - 1e-9)
        self.assertTrue(all(b > a for a, b in zip(new, new[1:])))

    def test_normalize_swap_grid_puts_passes_near_count_two(self):
        # 無音の格子（CV の入れ替わりが 8 件以上）でも、行の頭から見て通過の位置が On2 の期待（カウント 2〜3）に寄る
        import random as _r
        rnd = _r.Random(3)
        period = 8 * self.BEAT
        swaps, moves = [], []
        for k in range(14):
            t0 = 1.0 + k * period
            moves.append(mv(t0, "cbl", 8))
            swaps.append(t0 + (1.5 + 1.3) * self.BEAT + rnd.uniform(-0.1, 0.1))   # 通過 + CV の遅れ
        summary = {"events": [{"t": s - 0.4, "tCross": s, "type": "CBL", "by": "pair"} for s in swaps],
                   "frameClock": "pts"}
        res = normalize({"routine": {"moves": moves}}, summary, duration=1.0 + 15 * period)
        rows = res["routine"]["moves"]
        counts = []
        for s in swaps:
            r = [m for m in rows if m["start"] <= s - 0.4 + 0.05]
            if r:
                counts.append(((s - 0.4 - r[-1]["start"]) / self.BEAT) % 8 + 1)
        self.assertTrue(counts)
        mean = sum(counts) / len(counts)
        self.assertTrue(1.5 <= mean <= 3.5, mean)


if __name__ == "__main__":
    unittest.main()
