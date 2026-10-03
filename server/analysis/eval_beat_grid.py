"""ビート格子（analyze_beats.py）の評価: 格子が曲の最後まで拍に乗り続けるか。

音声の正解拍は無いので、推定器とは独立な「局所位相」で測る。
曲を 6 秒の窓（3 秒ずらし）に切り、各窓で格子の拍間隔のまま最もオンセットに乗る位相を探す。
全体の格子がその窓で示す位相とのずれ（ミリ秒）を見る。拍間隔が 1% 違うと 186BPM で 1 分に約 600ms ずれる。
  lockedRatio    ずれが ±LOCK_MS 以内の窓の割合（格子が拍に乗っている時間の割合）
  medianAbsMs    ずれの絶対値の中央値
  gridScore      全編で格子点のオンセット強度の平均 / 全体の平均（1 = でたらめ、高いほど拍に乗っている）

Usage: python eval_beat_grid.py [--impl path/to/analyze_beats.py] <wav>...
"""
import argparse
import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WIN_SEC = 6.0
STEP_SEC = 3.0
LOCK_MS = 50.0   # 1 拍（約 320ms）の 1/6 以内なら拍に乗っているとみなす


def load_impl(path):
    spec = importlib.util.spec_from_file_location("beats_impl", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sample(flux, pos):
    """小数インデックスで線形補間して読む"""
    pos = pos[(pos >= 0) & (pos <= len(flux) - 1)]
    i = np.floor(pos).astype(int)
    j = np.minimum(i + 1, len(flux) - 1)
    w = pos - i
    return flux[i] * (1 - w) + flux[j] * w


def local_phase(flux, period, lo, hi):
    """flux[lo:hi] の範囲で、拍間隔 period の櫛が最もよく乗る位相（0..period）"""
    best, best_s = 0.0, -1.0
    for off in np.arange(0, period, 0.25):
        k0 = np.ceil((lo - off) / period)
        pos = off + period * np.arange(k0, (hi - off) / period)
        s = sample(flux, pos).mean() if len(pos) else 0
        if s > best_s:
            best, best_s = off, s
    return best


def evaluate(impl, wav):
    x, sr = impl.read_wav_mono(wav)
    flux, env_sr = impl.onset_envelope(x, sr)
    grid = impl.estimate_grid(x, flux, env_sr) if hasattr(impl, "estimate_grid") else None
    if grid is None and not hasattr(impl, "estimate_grid"):
        est = impl.estimate_bpm(flux, env_sr)
        if est is not None and est[2] >= 0.08:
            period = float(est[1])
            grid = {"bpm": 60 * env_sr / period, "period": period, "offset": float(impl.beat_phase(flux, est[1])),
                    "confidence": est[2]}
    if grid is None:
        return {"bpm": None}
    period, off = grid["period"], grid["offset"]
    res = []
    win, step = int(WIN_SEC * env_sr), int(STEP_SEC * env_sr)
    for lo in range(0, max(1, len(flux) - win), step):
        ph = local_phase(flux, period, lo, lo + win)
        d = (ph - off + period / 2) % period - period / 2   # 格子の位相との差（-P/2..P/2）
        res.append(((lo + win / 2) / env_sr, d / env_sr * 1000))
    d = np.abs(np.array([r[1] for r in res]))
    pos = off + period * np.arange(0, (len(flux) - off) / period)
    score = sample(flux, pos).mean() / (flux.mean() + 1e-9)
    return {"bpm": round(grid["bpm"], 2), "confidence": round(grid.get("confidence", 0), 3),
            "lockedRatio": round(float((d <= LOCK_MS).mean()), 3), "medianAbsMs": round(float(np.median(d)), 1),
            "windows": len(d), "gridScore": round(float(score), 3)}


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--impl", default=os.path.join(HERE, "analyze_beats.py"))
    a.add_argument("wavs", nargs="+")
    args = a.parse_args()
    impl = load_impl(args.impl)
    for w in args.wavs:
        print(os.path.basename(w), evaluate(impl, w))


if __name__ == "__main__":
    main()
