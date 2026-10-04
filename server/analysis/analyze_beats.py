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
- 「どの拍がカウント1か」は beat_phase.py が楽器の打点（コンガのスラップ 2・ベース 2&/4・オープントーン 4/4&）と
  踊りの手がかり（CBL の通過・女性のターン）で決め、beatGrid.downbeat に書く（自信つき）。
  自信が低いときは従来どおり P2 の Claude がサルサ知識（On1/On2・技の慣例）で位相を合わせる

Usage: python analyze_beats.py <audio_wav_path> <measurements_json_path>
"""
import sys
import json
import wave
import numpy as np

import beat_phase as downbeat_mod  # 下の beat_phase() 関数と名前がぶつかるので別名

DOWNBEAT_MIN_CONF = 0.6   # これ以上ならイベントに合わせたカウント（count）を付ける。normalize_routine も同じ値で使う
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


# 無音判定: 画面収録などで音声トラックがほぼ空の動画（実測 rms 0.0007〜0.0014、音楽入りは 0.14）。
# 無音でも自己相関は AAC のフレーム周期などで偽のピーク（235BPM）を出すので、先に弾く
SILENT_RMS = 0.01
REFINE_STEP = 0.01   # 拍間隔の詰め（包絡のサンプル単位）
PHASE_STEP = 0.25


def is_silent(x):
    return len(x) == 0 or float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) < SILENT_RMS


def _comb_score(flux, period, phase_step=PHASE_STEP):
    """拍間隔 period（小数可）の櫛を全位相で当て、最良の (平均強度, 位相) を返す。
    櫛の歯は線形補間で読むので、拍間隔が包絡のサンプル間隔の整数倍でなくてよい"""
    n = len(flux)
    offs = np.arange(0, period, phase_step)
    k = np.arange(0, int((n - 1) / period))
    pos = offs[:, None] + period * k[None, :]
    valid = pos <= n - 1
    pos = np.where(valid, pos, 0)
    i = np.floor(pos).astype(int)
    j = np.minimum(i + 1, n - 1)
    w = pos - i
    vals = (flux[i] * (1 - w) + flux[j] * w) * valid
    scores = vals.sum(axis=1) / np.maximum(1, valid.sum(axis=1))
    b = int(np.argmax(scores))
    return float(scores[b]), float(offs[b])


def estimate_grid(x, flux, env_sr):
    """拍間隔を小数精度で求めた格子: {bpm, period, offset, confidence} or None。

    自己相関の最大ラグは整数（包絡 1 サンプル = 23ms）なので、186BPM の曲が 184.6BPM
    （ラグ 14）に丸められ、格子が 1 分で約 2 拍ずれていた（eval_beat_grid.py で実測）。
    整数ラグの ±1 の範囲で、櫛を全編に当てたときの乗り具合が最大になる拍間隔を探す。
    """
    if is_silent(x):
        return None
    est = estimate_bpm(flux, env_sr)
    if est is None or est[2] < 0.08:
        return None
    _, lag, conf = est
    # 包絡を軽くならして、櫛の歯がオンセットの1サンプルのずれで外れないようにする
    smooth = np.convolve(flux, np.array([0.25, 0.5, 0.25]), mode="same")
    best = (-1.0, float(lag), 0.0)
    for period in np.arange(lag - 1.0, lag + 1.0 + 1e-9, REFINE_STEP):
        score, off = _comb_score(smooth, period, phase_step=0.5)
        if score > best[0]:
            best = (score, float(period), off)
    period = best[1]
    _, offset = _comb_score(smooth, period)
    return {"bpm": 60.0 * env_sr / period, "period": period, "offset": offset, "confidence": conf}


def main():
    if len(sys.argv) != 3:
        print("Usage: analyze_beats.py <audio_wav_path> <measurements_json_path>", file=sys.stderr)
        sys.exit(1)
    audio_path, meas_path = sys.argv[1], sys.argv[2]

    x, sr = read_wav_mono(audio_path)
    flux, env_sr = onset_envelope(x, sr)
    grid = estimate_grid(x, flux, env_sr)

    with open(meas_path) as f:
        meas = json.load(f)

    if grid is None:
        silent = is_silent(x)
        meas["summary"]["beatGrid"] = None
        # 無音（画面収録で音が入っていない等）とリズム不明瞭を区別して判断層に渡す
        meas["summary"]["beatGridReason"] = "silent" if silent else "unclear"
        note = "音声が入っていない（無音）" if silent else "音声からビートを推定できませんでした（リズム不明瞭）"
        print(f"beats: {note}", file=sys.stderr)
    else:
        bpm, period, conf = grid["bpm"], grid["period"], grid["confidence"]
        interval = period / env_sr
        first = grid["offset"] / env_sr
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
        # カウント 1 の位置（音の楽器の打点 + 踊りの手がかり。beat_phase.py）。失敗しても格子はそのまま出す
        try:
            db = downbeat_mod.estimate_downbeat(x, sr, {"firstBeatSec": first, "beatIntervalSec": interval},
                                              meas["summary"])
            g = meas["summary"]["beatGrid"]
            g["downbeat"] = db
            if db["confidence"] >= DOWNBEAT_MIN_CONF:
                g["note"] = ("等間隔格子。downbeat.sec がカウント 1（On2 の 2 はその 1 拍後）。"
                             "各イベントの count が合わせたカウント、count8 は位相未合わせの仮カウント")
                for e in meas["summary"].get("events", []):
                    e["count"] = round(downbeat_mod.count_of(e["t"], db["sec"], interval), 2)
            print(f"beats: downbeat={db['sec']:.3f}s src={db['source']} conf={db['confidence']:.2f} "
                  f"(bar={db['barConfidence']:.2f} phrase={db['phraseConfidence']:.2f} offbeatGrid={db['offbeatGrid']})",
                  file=sys.stderr)
        except Exception as ex:  # noqa: BLE001
            print(f"beats: downbeat skipped: {ex}", file=sys.stderr)

    with open(meas_path, "w") as f:
        json.dump(meas, f)


if __name__ == "__main__":
    main()
