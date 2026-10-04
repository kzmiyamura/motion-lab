"""
analyze_pair.fix_identity_segments（交差で入れ替わったまま戻らない ID を区間ごとに錨で見直す）の単体テスト。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_pair as ap  # noqa: E402

A = np.array([0.6, 0.4, 0.0, 0.0])
B = np.array([0.0, 0.0, 0.4, 0.6])


def person(pid, hist, x):
    return {"pid": pid, "hist": hist.copy(), "hipX": x, "bbox": (x - 0.1, 0.1, x + 0.1, 0.9)}


def frames(spec):
    """spec: [(コマ数, 左の人の (pid, hist), 右の人の (pid, hist), 重なるか)]"""
    out, t = [], 0.0
    for n, left, right, overlap in spec:
        for _ in range(n):
            xl, xr = (0.45, 0.5) if overlap else (0.3, 0.7)
            out.append({"t": round(t, 2), "kept": [person(left[0], left[1], xl), person(right[0], right[1], xr)]})
            t += 0.1
    return out


def pids(fr):
    return [[p["pid"] for p in f["kept"]] for f in fr]


class FixIdentitySegmentsTest(unittest.TestCase):
    def test_swapped_segment_after_crossing_is_flipped_back(self):
        # 0 番 = A の服、1 番 = B の服。重なった後、A の服の人に 1 番が付いたまま続く
        fr = frames([(10, (0, A), (1, B), False), (2, (0, A), (1, B), True), (10, (1, A), (0, B), False)])
        ap.fix_identity_segments(fr, [A, B])
        self.assertTrue(all(p == [0, 1] for p in pids(fr)[:10]))
        self.assertTrue(all(p == [0, 1] for p in pids(fr)[12:]))

    def test_consistent_ids_are_left_alone(self):
        fr = frames([(10, (0, A), (1, B), False), (2, (1, B), (0, A), True), (10, (1, B), (0, A), False)])
        before = pids(fr)
        ap.fix_identity_segments(fr, [A, B])
        self.assertEqual(pids(fr), before)

    def test_short_segment_is_not_judged(self):
        fr = frames([(10, (0, A), (1, B), False), (2, (0, A), (1, B), True),
                     (ap.SEGMENT_MIN_FRAMES - 1, (1, A), (0, B), False)])
        before = pids(fr)
        ap.fix_identity_segments(fr, [A, B])
        self.assertEqual(pids(fr), before)


if __name__ == "__main__":
    unittest.main()
