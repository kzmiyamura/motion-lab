#!/usr/bin/env python3
"""
ビート格子（analyze_beats.py）の「どの拍がカウント 1 か」を、音と踊りの両方から決める。

analyze_beats の格子は等間隔の拍時刻だけで、位相（カウント 1 の位置）は未確定だった。さらにサルサでは
オンセットが一番強いのは裏拍のことがあり、櫛の位相が裏拍（&）に乗ることもある（2fda2815 で実測）。
そこで格子の拍を半拍刻みでずらした 8 通り（4 拍 = 1 小節の中）を候補にして、楽器の決まった打点に当てる
（docs/salsa-knowledge/video-analysis-cues.md §2.1〜2.2・§7 P6）:

  コンガのトゥンバオ   スラップ（高めの鋭い打撃）= 2（と 6）、オープントーン（低めの胴鳴り）= 4・4&（と 8・8&）
  ベースのトゥンバオ   2& と 4（1 は弾かない。アンティシペイト）
  カウベル・ギロ       1・3・5・7（表拍か裏拍かしか分からないので入れていない。下の BAND_TEMPLATES の注）

これは 4 拍周期なので、音から決まるのは「1 小節の中のどこが 1 か」まで（1 と 5 は区別できない）。
1 と 5 は踊りの手がかりで決める（On2: 女性が男の横を通る CBL の通過は 2 前後、ターンの回り始めも 2 前後。
on2-timing-and-terms.md §8-2・3）。CV の左右の入れ替わり（CBL の tCross）は CROSS_BEAT、
女性のターンの最初の向きの反転（spin.from）は TURN_BEAT 拍目に来るとして、8 カウントの頭を選ぶ。

音で小節の位相が決まらないとき（録音が遠い・話し声が多い・打楽器が聞こえない）は、踊りの手がかりだけで
格子の拍（ずらさない 8 通り）から選び、その自信を正直に出す。

依存は numpy のみ。analyze_beats.py が呼ぶ。単体でも:
  python beat_phase.py <audio.wav> <measurements.json>   （beatGrid が書かれた measurements.json を読み、結果を表示）
"""
import json
import math
import sys

import numpy as np

# ---- 音の特徴
HOP = 256                  # 22050 Hz で 11.6 ms
FRAME = 1024
SLOT_WIN_SEC = 0.035       # 半拍の各位置で、この幅の中のオンセットの最大を読む
BANDS = {                  # 帯域（Hz）
    "bass": (30, 150),
    "lowmid": (150, 400),
    "mid": (400, 1000),
    "highmid": (1000, 3000),
    "high": (3000, 8000),
}
# 楽器の打点（1 小節 = 半拍 8 個。0 = 1, 1 = 1&, 2 = 2, 3 = 2&, 4 = 3, 5 = 3&, 6 = 4, 7 = 4&）。
# 帯域ごとに、その帯域で一番はっきり出る楽器の打点だけを置く（重み付きの櫛）。
# カウベル・ギロ（1・3）は表拍か裏拍か（半拍の偶奇）しか決めないうえ、モントゥーノでしか鳴らないので入れていない。
BAND_TEMPLATES = {
    "bass": {3: 1.0, 6: 1.0, 0: -0.5},     # ベースのトゥンバオ 2& と 4、1 は弾かない
    "lowmid": {6: 1.0, 7: 1.0},            # コンガのオープントーン 4・4&
    "highmid": {2: 1.0},                   # コンガのスラップ 2
    "high": {2: 1.0},                      # 同（スラップの鋭い立ち上がりは高域まで出る）
}
MIN_BARS = 6               # 小節がこれ未満なら音では決めない
BOOT = 400                 # ブートストラップの回数（小節・イベントの引き直し）
AUDIO_MIN_CONF = 0.8       # 小節の位相をこの自信以上で決められたら音を使う
AUDIO_MIN_EFFECT = 0.15    # 小節あたりの差（1 位 − 2 位）の平均 / 小節ごとの差の標準偏差。小さいと偶然の偏り

# ---- 踊りの手がかり（8 カウントの頭からの拍数）
# CBL の腰の交差（tCross）: On2 では女性が男の横を通るのは 1〜3（中心は 2。on2-timing-and-terms.md §8-2）。
# 音声のある 2 本（スタジオ・正面）では CV の交差は正解の通過とほぼ同じ時刻（2fda2815 中央値 −0.1 秒・
# img1884 +0.0〜0.25 秒）。1230b3d5（撮影者が回り込む）では +0.41 秒遅れる。間を取ってカウント 2.5。
# normalize_routine.SWAP_BEAT（4.25）は 1230b3d5 の遅れに合わせた値なので、ここでは使わない。
CROSS_BEAT = 1.5
TURN_BEAT = 2.0            # 女性のターンの最初の向きの反転（spin.from）。2 で通って回り始め、3 前後で背中を見せる
TURN_WEIGHT = 0.5          # ターンは入れ替わりより位置がばらつく（右ターンは 1 から、インサイドは 2-3）ので軽く
MIN_DANCE_EVENTS = 4
DANCE_MIN_CONF = 0.7       # 踊りだけで決めるときにこの自信未満なら「決まらない」と書く（格子の位相は出す）


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def band_onsets(x, sr):
    """帯域ごとのオンセット強度（対数振幅の正の差分の和）。戻り値 (bands × frames, フレームレート)"""
    n = max(0, (len(x) - FRAME) // HOP)
    if n < 2:
        return np.zeros((len(BANDS), 0)), sr / HOP
    win = np.hanning(FRAME).astype(np.float32)
    freqs = np.fft.rfftfreq(FRAME, 1.0 / sr)
    masks = [(freqs >= lo) & (freqs < hi) for lo, hi in BANDS.values()]
    out = np.zeros((len(BANDS), n), dtype=np.float32)
    prev = None
    step = 512   # メモリを抑えるため塊ごとに
    for c0 in range(0, n, step):
        c1 = min(n, c0 + step)
        idx = np.arange(FRAME)[None, :] + HOP * np.arange(c0, c1)[:, None]
        S = np.log1p(100.0 * np.abs(np.fft.rfft(x[idx] * win, axis=1)))
        if prev is not None:
            S_full = np.vstack([prev[None, :], S])
        else:
            S_full = np.vstack([S[:1], S])
        d = np.maximum(np.diff(S_full, axis=0), 0.0)
        for b, m in enumerate(masks):
            out[b, c0:c1] = d[:, m].sum(axis=1)
        prev = S[-1]
    return out, sr / HOP


def half_beat_strengths(onsets, fsr, first, interval, duration):
    """格子の半拍ごとの各帯域の強さ（その位置 ±SLOT_WIN_SEC の最大）。帯域ごとに全体の平均で割る。
    戻り値 (半拍の数 × 帯域)。0 番 = firstBeatSec"""
    n_half = int((duration - first) / (interval / 2))
    r = max(1, int(round(SLOT_WIN_SEC * fsr)))
    n = onsets.shape[1]
    vals = np.zeros((max(0, n_half), onsets.shape[0]), dtype=np.float64)
    for h in range(n_half):
        i = int(round((first + h * interval / 2) * fsr))
        lo, hi = max(0, i - r), min(n, i + r + 1)
        if lo < hi:
            vals[h] = onsets[:, lo:hi].max(axis=1)
    mean = vals.mean(axis=0) if len(vals) else np.ones(onsets.shape[0])
    return vals / (mean + 1e-9)


def bar_scores(half):
    """小節ごと・位相の候補ごとの当てはまり。候補 p = カウント 1 が格子の半拍 p 番目（0〜7）にある。
    戻り値 (小節の数 × 8)、小節は格子の半拍 0 番から 8 個ずつ"""
    nbar = len(half) // 8
    names = list(BANDS)
    out = np.zeros((nbar, 8))
    for b in range(nbar):
        blk = half[8 * b:8 * b + 8]                       # 8 × 帯域
        blk = blk - blk.mean(axis=0, keepdims=True)       # 小節の中で帯域ごとに中心化（音量の上下を消す）
        for p in range(8):
            s = 0.0
            for name, tpl in BAND_TEMPLATES.items():
                col = names.index(name)
                for slot, w in tpl.items():
                    s += w * blk[(slot + p) % 8, col]
            out[b, p] = s
    return out


def _boot_argmax(scores, best, rng, boot=BOOT):
    """行（小節・イベント）を引き直して、平均の最大がまた best になる割合"""
    n = len(scores)
    if n == 0:
        return 0.0
    hit = 0
    for _ in range(boot):
        idx = rng.integers(0, n, n)
        if int(np.argmax(scores[idx].mean(axis=0))) == best:
            hit += 1
    return hit / boot


def audio_bar_phase(x, sr, first, interval):
    """音から小節の位相（カウント 1 が格子の何番目の半拍か、0〜7）と自信。決められないときも値は返す"""
    duration = len(x) / sr
    onsets, fsr = band_onsets(x, sr)
    half = half_beat_strengths(onsets, fsr, first, interval, duration)
    S = bar_scores(half)
    if len(S) < MIN_BARS:
        return {"phaseHalf": None, "confidence": 0.0, "bars": int(len(S)), "reason": "too_few_bars"}
    mean = S.mean(axis=0)
    order = np.argsort(-mean)
    best, second = int(order[0]), int(order[1])
    diff = S[:, best] - S[:, second]
    effect = float(diff.mean() / (diff.std() + 1e-9))
    rng = np.random.default_rng(0)
    conf = _boot_argmax(S, best, rng)
    # 帯域ごとの折り畳み（証拠の表示用）: カウント 1 から並べた 8 個（1, 1&, 2, ..., 4&）
    nb = len(half) // 8
    fold = half[:nb * 8].reshape(nb, 8, -1).mean(axis=0)  # 8 × 帯域（格子の半拍 0 番から）
    fold = np.roll(fold, -best, axis=0)
    profile = {name: [round(float(v), 2) for v in fold[:, i]] for i, name in enumerate(BANDS)}
    return {
        "phaseHalf": best, "confidence": round(conf, 3), "effect": round(effect, 3), "bars": int(len(S)),
        "scores": [round(float(v), 3) for v in mean], "runnerUp": second,
        "profileFromCount1": profile,   # 帯域ごとの平均の強さ（カウント 1, 1&, 2, 2&, 3, 3&, 4, 4&）
    }


# ---------------------------------------------------------------- 踊りの手がかり

def dance_events(summary):
    """(時刻, 期待する拍（8 カウントの頭から）, 重み, 種類) の並び"""
    out = []
    for e in (summary or {}).get("events") or []:
        if not isinstance(e, dict) or not _num(e.get("t")):
            continue
        if e.get("type") == "CBL":
            t = e["tCross"] if _num(e.get("tCross")) else e["t"]
            out.append((float(t), CROSS_BEAT, 1.0, "cbl"))
        elif e.get("type") == "Turn" and e.get("by") == "follower":
            sp = e.get("spin") if isinstance(e.get("spin"), dict) else {}
            t = sp.get("from") if _num(sp.get("from")) else e["t"]
            out.append((float(t), TURN_BEAT, TURN_WEIGHT, "turn"))
    return out


def dance_scores(events, first, interval, candidates_half):
    """各イベントの、候補ごとの当てはまり（cos。期待の拍で 1、4 拍ずれて -1）。
    候補は 8 カウントの頭の位置（格子の半拍 0〜15 番）。戻り値 (イベント × 候補)"""
    M = np.zeros((len(events), len(candidates_half)))
    for i, (t, target, w, _) in enumerate(events):
        for j, h in enumerate(candidates_half):
            head = first + h * interval / 2
            pos = ((t - head) / interval) % 8
            M[i, j] = w * math.cos(2 * math.pi * (pos - target) / 8)
    return M


def count_of(t, downbeat, interval):
    """時刻 t の 8 カウント上の位置（1.0〜8.99…。1.5 = 1&）"""
    return ((t - downbeat) / interval) % 8 + 1


# ---------------------------------------------------------------- 合わせる

def estimate_downbeat(x, sr, grid, summary):
    """grid: {firstBeatSec, beatIntervalSec}。x が None なら音は使わない。
    戻り値: beatGrid.downbeat に書く dict（必ず返す。決まらないときは confidence が低い）"""
    first, ib = float(grid["firstBeatSec"]), float(grid["beatIntervalSec"])
    events = dance_events(summary)
    audio = audio_bar_phase(x, sr, first, ib) if x is not None and len(x) else None
    audio_ok = bool(audio and audio["phaseHalf"] is not None
                    and audio["confidence"] >= AUDIO_MIN_CONF and audio.get("effect", 0) >= AUDIO_MIN_EFFECT)
    rng = np.random.default_rng(1)
    ev_counts = {"cbl": sum(1 for e in events if e[3] == "cbl"), "turn": sum(1 for e in events if e[3] == "turn")}

    if audio_ok:
        p = audio["phaseHalf"]
        cands = [p, p + 8]                        # 1 と 5（半拍 8 個 = 4 拍ずらし）
        source = "audio"
    else:
        cands = list(range(0, 16, 2))             # 格子の拍のまま、8 通り
        source = "dance"
    phrase_conf, dance_pick, dance_mean = 0.5, 0, None
    if len(events) >= MIN_DANCE_EVENTS:
        D = dance_scores(events, first, ib, cands)
        dance_mean = D.mean(axis=0)
        dance_pick = int(np.argmax(dance_mean))
        phrase_conf = _boot_argmax(D, dance_pick, rng)
        if audio_ok:
            source = "audio+dance"
    elif not audio_ok:
        source = "none"
    head_half = cands[dance_pick]
    downbeat = first + head_half * ib / 2
    period8 = 8 * ib
    downbeat = downbeat % period8                 # 0 秒以降で最初のカウント 1
    if audio_ok:
        bar_conf = audio["confidence"]
        conf = bar_conf * (0.5 + 0.5 * phrase_conf) if len(events) >= MIN_DANCE_EVENTS else bar_conf * 0.5
    else:
        bar_conf = phrase_conf if len(events) >= MIN_DANCE_EVENTS else 0.0
        conf = bar_conf
    out = {
        "sec": round(downbeat, 3),
        "source": source,
        "confidence": round(conf, 3),
        "barConfidence": round(bar_conf, 3),        # 1 小節（4 拍）の中のどこが 1 か
        "phraseConfidence": round(phrase_conf, 3),  # 1 と 5 のどちらか（踊りの手がかり）
        "offsetHalfBeats": int(head_half % 16),     # firstBeatSec から何半拍ずれた所が 1 か（奇数なら格子は裏拍に乗っていた）
        "offbeatGrid": bool(head_half % 2),
        "evidence": {
            "audio": audio,
            "audioUsed": audio_ok,
            "dance": {"events": ev_counts, "candidatesHalf": cands,
                      "scores": None if dance_mean is None else [round(float(v), 3) for v in dance_mean],
                      "crossBeat": CROSS_BEAT, "turnBeat": TURN_BEAT},
        },
    }
    return out


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    import analyze_beats as ab
    x, sr = ab.read_wav_mono(sys.argv[1])
    with open(sys.argv[2], encoding="utf-8") as f:
        meas = json.load(f)
    s = meas.get("summary") or {}
    g = s.get("beatGrid")
    if not g:
        print("beatGrid がありません", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(estimate_downbeat(x, sr, g, s), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
