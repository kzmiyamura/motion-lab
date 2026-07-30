#!/usr/bin/env python3
"""
動画の音声（WAV）からサルサのビート格子（BPM・拍時刻）を推定し、
measurements.json に summary.beatGrid と各技イベントの拍情報を書き加える。

docs/folder-analysis-design.md ロードマップ③（ビート格子）の第一弾。
「5-6-7でターン」のようなカウント記述の材料になる。

- 依存は numpy のみ（ThinkCentre に新規 pip 依存を増やさない）。
  音声の WAV 化は Node 側（jobWorker が ffmpeg-static で実施）
- オンセット検出: STFT のスペクトラルフラックス
- テンポ推定: フラックス包絡の自己相関（サルサの実用域 140〜230 BPM を探索）
- 拍位相: コムフィルタ（拍間隔で並べた櫛とフラックスの内積が最大になるオフセット）
- 「どの拍がカウント1か」は音声からは決まらない。beatGrid は等間隔の格子のみを出し、
  カウントの位相合わせは P2 の Claude がサルサ知識（On1/On2・技の慣例）で行う

Usage: python analyze_beats.py <audio_wav_path> <measurements_json_path>
"""
import sys
import json
import wave
import numpy as np

FRAME = 1024
HOP = 512
BPM_MIN = 140.0
BPM_MAX = 230.0


def read_wav_mono(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
        width = w.getsampwidth()
        ch = w.getnchannels()
    if width == 2:
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        x = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def onset_envelope(x, sr):
    """スペクトラルフラックス（正の変化分のみ）の時系列と、そのサンプリングレートを返す"""
    n_frames = max(0, (len(x) - FRAME) // HOP)
    window = np.hanning(FRAME)
    prev = None
    flux = np.zeros(n_frames, dtype=np.float32)
    for i in range(n_frames):
        seg = x[i * HOP:i * HOP + FRAME] * window
        mag = np.abs(np.fft.rfft(seg))
        if prev is not None:
            flux[i] = np.maximum(mag - prev, 0.0).sum()
        prev = mag
    # 移動平均を引いてローカルなピークを強調（音量変化のうねりを除去）
    if len(flux) > 16:
        kernel = np.ones(16) / 16
        flux = flux - np.convolve(flux, kernel, mode="same")
        flux = np.maximum(flux, 0.0)
    return flux, sr / HOP


def estimate_bpm(flux, env_sr):
    """自己相関でテンポ（拍間隔）を推定。戻り値 (bpm, 拍間隔サンプル数, 信頼度0-1)"""
    lag_min = int(env_sr * 60.0 / BPM_MAX)
    lag_max = int(env_sr * 60.0 / BPM_MIN)
    if len(flux) < lag_max * 2:
        return None
    f = flux - flux.mean()
    ac = np.correlate(f, f, mode="full")[len(f) - 1:]
    ac = ac / (ac[0] + 1e-9)
    window = ac[lag_min:lag_max + 1]
    best = int(np.argmax(window)) + lag_min
    bpm = 60.0 * env_sr / best
    # 信頼度: そのラグの自己相関値（0-1目安）。0.1未満はリズムが取れていない
    return bpm, best, float(max(0.0, min(1.0, ac[best])))


def beat_phase(flux, period):
    """コムフィルタで拍位相（最初の拍のオフセット・サンプル数）を求める"""
    best_off, best_score = 0, -1.0
    for off in range(int(period)):
        idx = np.arange(off, len(flux), period).astype(int)
        score = float(flux[idx].sum()) / max(1, len(idx))
        if score > best_score:
            best_off, best_score = off, score
    return best_off


def main():
    if len(sys.argv) != 3:
        print("Usage: analyze_beats.py <audio_wav_path> <measurements_json_path>", file=sys.stderr)
        sys.exit(1)
    audio_path, meas_path = sys.argv[1], sys.argv[2]

    x, sr = read_wav_mono(audio_path)
    flux, env_sr = onset_envelope(x, sr)
    est = estimate_bpm(flux, env_sr)

    with open(meas_path) as f:
        meas = json.load(f)

    if est is None or est[2] < 0.08:
        meas["summary"]["beatGrid"] = None
        note = "音声からビートを推定できませんでした（無音・リズム不明瞭）"
        print(f"beats: {note}", file=sys.stderr)
    else:
        bpm, period, conf = est
        off = beat_phase(flux, period)
        interval = period / env_sr
        first = off / env_sr
        meas["summary"]["beatGrid"] = {
            "bpm": round(bpm, 1),
            "firstBeatSec": round(first, 3),
            "beatIntervalSec": round(interval, 4),
            "confidence": round(conf, 3),
            "note": "等間隔格子。どの拍がカウント1かは未確定（判断層がOn1/On2の慣例で位相合わせする）",
        }
        # 各技イベントに拍情報を付与: 最寄り拍の番号（0始まり）と8カウント内の相対位置（位相は任意）
        for e in meas["summary"].get("events", []):
            beat_idx = round((e["t"] - first) / interval)
            e["beatIndex"] = int(beat_idx)
            e["count8"] = int(beat_idx % 8) + 1  # 位相未合わせの仮カウント
            # 拍からのずれ（拍の上に乗っているか）
            e["beatOffsetSec"] = round(e["t"] - (first + beat_idx * interval), 3)
        print(f"beats: bpm={bpm:.1f} conf={conf:.2f} first={first:.2f}s interval={interval:.3f}s", file=sys.stderr)

    with open(meas_path, "w") as f:
        json.dump(meas, f)


if __name__ == "__main__":
    main()
