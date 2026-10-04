"""
beat_phase.py（ビート格子のカウント 1 の位置）と、それを使う normalize_routine の単体テスト。

合成した音（ベースのトゥンバオ 2&・4、コンガのスラップ 2、オープントーン 4・4&、全拍に弱いハイハット）で
小節の位相が音から決まること、裏拍に乗った格子でも半拍ずらして 1 を返すこと、音が平らなときは踊りの手がかり
だけに落ちること、自信が低い downbeat を normalize が使わないことを確かめる。

実行: python -m pytest server/analysis/tests/test_beat_phase.py
"""
import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import analyze_beats as ab  # noqa: E402
import beat_phase as bp  # noqa: E402
from normalize_routine import normalize  # noqa: E402

SR = 22050


def _burst(n, kind, rng):
    t = np.arange(n) / SR
    env = np.exp(-t / 0.03)
    if kind == "bass":
        return 0.8 * np.sin(2 * np.pi * 80 * t) * np.exp(-t / 0.12)
    if kind == "open":
        return 0.5 * np.sin(2 * np.pi * 260 * t) * np.exp(-t / 0.08)
    if kind == "slap":
        noise = rng.standard_normal(n)
        hp = np.diff(noise, prepend=0.0)          # 高域寄りの雑音
        return 0.6 * hp * np.exp(-t / 0.015)
    # hat: 全拍の弱い刻み（格子の推定用）
    return 0.15 * rng.standard_normal(n) * env


def tumbao_audio(bpm=180.0, bars=20, count1_sec=0.5, seed=0):
    """カウント 1 が count1_sec にある 4 拍の小節を bars 回。戻り値 (x, 1 拍の秒)"""
    rng = np.random.default_rng(seed)
    ib = 60.0 / bpm
    dur = count1_sec + bars * 4 * ib + 1.0
    x = 0.002 * rng.standard_normal(int(dur * SR))
    n = int(0.25 * SR)
    hits = {"hat": [0, 1, 2, 3], "bass": [1.5, 3], "slap": [1], "open": [3, 3.5]}   # 0 = カウント 1
    for b in range(bars):
        for kind, beats in hits.items():
            for k in beats:
                t = count1_sec + (4 * b + k) * ib
                i = int(t * SR)
                seg = _burst(min(n, len(x) - i), kind, rng)
                x[i:i + len(seg)] += seg
    return x.astype(np.float32), ib


class AudioPhaseTest(unittest.TestCase):
    def test_audio_finds_count1_from_instrument_pattern(self):
        x, ib = tumbao_audio(count1_sec=0.5)
        # 格子は 0.5 秒から（＝カウント 1 から）。音だけで、カウント 1 が格子の半拍 0 番と分かるはず
        res = bp.audio_bar_phase(x, SR, 0.5, ib)
        self.assertEqual(res["phaseHalf"], 0)
        self.assertGreaterEqual(res["confidence"], bp.AUDIO_MIN_CONF)

    def test_grid_on_offbeat_is_shifted_by_half_beat(self):
        x, ib = tumbao_audio(count1_sec=0.5)
        # 櫛が裏拍に乗った格子（最初の「拍」が 1& の位置）: 1 は格子から半拍 7 個先（= 半拍 1 個手前）
        first = 0.5 + ib / 2
        db = bp.estimate_downbeat(x, SR, {"firstBeatSec": first, "beatIntervalSec": ib}, {"events": []})
        self.assertTrue(db["evidence"]["audioUsed"])
        self.assertTrue(db["offbeatGrid"])
        # 1 小節（4 拍）の中では 0.5 秒と同じ位置（1 と 5 は踊りが無いので決まらない）
        d = (db["sec"] - 0.5) / ib
        self.assertAlmostEqual(d - 4 * round(d / 4), 0.0, places=2)
        self.assertEqual(db["source"], "audio")
        self.assertLessEqual(db["confidence"], 0.5 + 1e-9)   # 1 か 5 か分からない分を割り引く

    def test_dance_picks_1_vs_5(self):
        x, ib = tumbao_audio(count1_sec=0.5, bars=24)
        # 8 カウントの頭が 0.5 + 4 拍（= 5 の位置）だとして、CV の交差を 2.5、ターンの反転を 3 に置く
        head = 0.5 + 4 * ib
        ev = []
        for k in range(8):
            h = head + 8 * k * ib
            ev.append({"t": h + bp.CROSS_BEAT * ib - 0.4, "tCross": h + bp.CROSS_BEAT * ib, "type": "CBL"})
            ev.append({"t": h + 3 * ib, "type": "Turn", "by": "follower", "spin": {"from": h + bp.TURN_BEAT * ib}})
        db = bp.estimate_downbeat(x, SR, {"firstBeatSec": 0.5, "beatIntervalSec": ib}, {"events": ev})
        self.assertEqual(db["source"], "audio+dance")
        d = (db["sec"] - head) / ib
        self.assertAlmostEqual(d - 8 * round(d / 8), 0.0, places=2)
        self.assertGreater(db["phraseConfidence"], 0.9)
        self.assertGreater(db["confidence"], 0.9)


class DanceFallbackTest(unittest.TestCase):
    def test_flat_audio_falls_back_to_dance(self):
        rng = np.random.default_rng(3)
        ib = 60 / 180
        x = np.zeros(int(40 * SR), np.float32)
        n = int(0.1 * SR)
        for k in range(int(39 / ib)):          # 全拍が同じ強さの刻みだけ（小節の位相の手がかりなし）
            i = int((0.3 + k * ib) * SR)
            x[i:i + n] += (0.3 * rng.standard_normal(n) * np.exp(-np.arange(n) / SR / 0.02)).astype(np.float32)
        head = 0.3 + 3 * ib
        ev = [{"t": head + 8 * k * ib + 1.1 * ib, "tCross": head + 8 * k * ib + 1.5 * ib, "type": "CBL"} for k in range(10)]
        db = bp.estimate_downbeat(x, SR, {"firstBeatSec": 0.3, "beatIntervalSec": ib}, {"events": ev})
        self.assertFalse(db["evidence"]["audioUsed"])
        self.assertEqual(db["source"], "dance")
        self.assertFalse(db["offbeatGrid"])
        d = (db["sec"] - head) / ib
        self.assertAlmostEqual(d - 8 * round(d / 8), 0.0, places=2)

    def test_no_audio_no_events_is_not_confident(self):
        db = bp.estimate_downbeat(None, SR, {"firstBeatSec": 0.2, "beatIntervalSec": 0.33}, {"events": []})
        self.assertEqual(db["source"], "none")
        self.assertEqual(db["confidence"], 0.0)

    def test_count_of(self):
        self.assertAlmostEqual(bp.count_of(1.0 + 0.5, 1.0, 0.5), 2.0)
        self.assertAlmostEqual(bp.count_of(1.0 - 0.5, 1.0, 0.5), 8.0)


class NormalizeUsesDownbeatTest(unittest.TestCase):
    def _res(self):
        return {"routine": {"timing": "on2", "moves": [{"start": 0.6, "move": "basic", "counts": 8},
                                                       {"start": 4.3, "move": "cbl", "counts": 8},
                                                       {"start": 8.9, "move": "basic", "counts": 8}]}}

    def test_confident_downbeat_sets_8_count_heads(self):
        res = self._res()
        g = {"bpm": 120, "beatIntervalSec": 0.5, "firstBeatSec": 0.5,
             "downbeat": {"sec": 1.75, "confidence": 0.9, "source": "audio+dance"}}
        normalize(res, {"beatGrid": g}, duration=12.6)
        grid = res["routine"]["grid"]
        self.assertEqual(grid["phaseSource"], "downbeat")
        self.assertAlmostEqual(grid["phaseSec"], 1.75)
        for m in res["routine"]["moves"]:
            k = (m["start"] - 1.75) / 4.0
            self.assertAlmostEqual(k, round(k), places=2)

    def test_unsure_downbeat_is_ignored(self):
        res = self._res()
        g = {"bpm": 120, "beatIntervalSec": 0.5, "firstBeatSec": 0.5,
             "downbeat": {"sec": 1.75, "confidence": 0.3, "source": "dance"}}
        normalize(res, {"beatGrid": g}, duration=12.6)
        self.assertNotIn("phaseSource", res["routine"]["grid"])
        self.assertEqual([m["start"] for m in res["routine"]["moves"]], [0.5, 4.5, 8.5])


class AnalyzeBeatsWritesDownbeatTest(unittest.TestCase):
    def test_estimate_grid_then_downbeat_on_synthetic_song(self):
        x, ib = tumbao_audio(count1_sec=0.5, bars=24)
        flux, esr = ab.onset_envelope(x, SR)
        g = ab.estimate_grid(x, flux, esr)
        self.assertIsNotNone(g)
        interval = g["period"] / esr
        self.assertAlmostEqual(interval, ib, delta=0.01)
        db = bp.estimate_downbeat(x, SR, {"firstBeatSec": g["offset"] / esr, "beatIntervalSec": interval}, {})
        d = (db["sec"] - 0.5) / interval
        self.assertLess(abs(d - 4 * round(d / 4)), 0.25)    # 1 小節の中で 1 の位置（±¼ 拍）
        self.assertTrue(math.isfinite(db["confidence"]))

    def test_main_writes_downbeat_into_measurements(self):
        import json
        import tempfile
        import wave
        x, ib = tumbao_audio(count1_sec=0.5, bars=24)
        head = 0.5 + 4 * ib
        ev = [{"t": head + 8 * k * ib + 1.1 * ib, "tCross": head + 8 * k * ib + 1.5 * ib, "type": "CBL", "by": "pair"}
              for k in range(8)]
        with tempfile.TemporaryDirectory() as d:
            wav, meas = os.path.join(d, "a.wav"), os.path.join(d, "m.json")
            with wave.open(wav, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SR)
                w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
            with open(meas, "w") as f:
                json.dump({"summary": {"events": ev}}, f)
            argv = sys.argv
            sys.argv = ["analyze_beats.py", wav, meas]
            try:
                ab.main()
            finally:
                sys.argv = argv
            with open(meas) as f:
                g = json.load(f)["summary"]
        db = g["beatGrid"]["downbeat"]
        self.assertEqual(db["source"], "audio+dance")
        self.assertGreaterEqual(db["confidence"], ab.DOWNBEAT_MIN_CONF)
        d = (db["sec"] - head) / ib
        self.assertLess(abs(d - 8 * round(d / 8)), 0.25)
        # 合わせたカウント: CV の通過（t）は 2 前後
        self.assertTrue(all(1.5 <= e["count"] <= 3.0 for e in g["events"]))


if __name__ == "__main__":
    unittest.main()
