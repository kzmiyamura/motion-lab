"""
analyze_pair.resolve_identity_joint（区間ごとの ID の入れ替えを全区間まとめて決める）と
leader_from_hint（Claude アンカーをきれいなコマに当てる）の単体テスト。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

RNG = np.random.default_rng(0)
BASE_A = RNG.dirichlet(np.ones(128))
BASE_B = RNG.dirichlet(np.ones(128))


def look(base, rng):
    """服の色（似た 2 人: 違いは一部のビンだけ）にコマごとの揺れを足したヒストグラム"""
    h = np.clip(base + rng.normal(0, 0.002, 128), 0, None)
    return (h / h.sum()).astype(np.float32)


def person(pid, base, x, rng, h=0.8):
    return {"pid": pid, "hist": look(base, rng), "app": {"lower": look(base[::-1].copy(), rng)},
            "hipX": x, "bbox": (x - 0.1, 0.9 - h, x + 0.1, 0.9), "bboxHpx": h * 1000, "shr2d": 1.4,
            "shDx": 0.05, "edgeClipped": False, "shoulderW": 100.0}


def frames(spec, seed=1):
    """spec: [(コマ数, 左の人の (pid, 服), 右の人の (pid, 服), 重なるか)]"""
    rng = np.random.default_rng(seed)
    out, t = [], 0.0
    for n, left, right, overlap in spec:
        for _ in range(n):
            xl, xr = (0.45, 0.5) if overlap else (0.3, 0.7)
            out.append({"t": round(t, 2), "kept": [person(left[0], left[1], xl, rng), person(right[0], right[1], xr, rng)]})
            t += 0.1
    return out


def wearer_of_pid0(fr):
    """重なっていない各コマで pid 0 が付いている人の服（A/B）。重なったコマはどちらの区間に付くか（交差のどこで
    入れ替わったか）が決まらないので見ない"""
    out = []
    for f in fr:
        if abs(f["kept"][0]["hipX"] - f["kept"][1]["hipX"]) < 0.1:
            continue
        for p in f["kept"]:
            if p["pid"] == 0:
                out.append("A" if np.abs(p["hist"] - BASE_A).sum() < np.abs(p["hist"] - BASE_B).sum() else "B")
    return out


class ResolveIdentityJointTest(unittest.TestCase):
    def test_swapped_segments_are_flipped_back(self):
        # A が 0 番。交差（重なり）のたびに区間ができ、2 つ目と 4 つ目の区間で追跡が入れ替わったまま
        ok, sw = ((0, BASE_A), (1, BASE_B)), ((1, BASE_A), (0, BASE_B))
        spec = []
        for k in range(6):
            left, right = sw if k in (1, 3) else ok
            spec += [(40, left, right, False), (2, left, right, True)]
        fr = frames(spec)
        ap.resolve_identity_joint(fr)
        who = wearer_of_pid0(fr)
        self.assertEqual(set(who), {"A"})

    def test_consistent_ids_are_left_alone(self):
        ok = ((0, BASE_A), (1, BASE_B))
        crossed = ((1, BASE_B), (0, BASE_A))  # 左右は入れ替わっても ID は正しい
        spec = []
        for k in range(6):
            left, right = crossed if k % 2 else ok
            spec += [(40, left, right, False), (2, left, right, True)]
        fr = frames(spec)
        before = [[p["pid"] for p in f["kept"]] for f in fr]
        ap.resolve_identity_joint(fr)
        self.assertEqual([[p["pid"] for p in f["kept"]] for f in fr], before)


class LeaderFromHintTest(unittest.TestCase):
    def test_skips_frame_with_small_background_person(self):
        rng = np.random.default_rng(2)
        fr = []
        # 0 秒: 女性（pid 0、左）と背景の小さな人（pid 1、右）。以降は 男（pid 1）が右
        fr.append({"t": 0.0, "kept": [person(0, BASE_B, 0.3, rng), person(1, BASE_A, 0.7, rng, h=0.3)]})
        for k in range(1, 20):
            fr.append({"t": k * 0.1, "kept": [person(1, BASE_A, 0.7, rng), person(0, BASE_B, 0.3, rng)]})
        self.assertEqual(ap.leader_from_hint(fr, 0, "right@0"), 1)

    def test_nearest_clean_frame_wins_over_later_crossing(self):
        rng = np.random.default_rng(3)
        # 0〜0.2 秒は男（pid 1）が右、その後すぐ入れ替わって左へ（1230b3d5 の 0.3 秒の CBL）
        fr = [{"t": k * 0.1, "kept": [person(1, BASE_A, 0.7 if k < 3 else 0.3, rng),
                                      person(0, BASE_B, 0.3 if k < 3 else 0.7, rng)]} for k in range(20)]
        self.assertEqual(ap.leader_from_hint(fr, 0, "right@0"), 1)

    def test_bad_hint_keeps_vote(self):
        rng = np.random.default_rng(4)
        fr = [{"t": k * 0.1, "kept": [person(1, BASE_A, 0.7, rng), person(0, BASE_B, 0.3, rng)]} for k in range(5)]
        self.assertEqual(ap.leader_from_hint(fr, 0, "middle@0"), 0)
        self.assertEqual(ap.leader_from_hint(fr, 0, "right@30"), 0)


if __name__ == "__main__":
    unittest.main()
