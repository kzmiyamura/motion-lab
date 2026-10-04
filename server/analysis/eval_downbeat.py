#!/usr/bin/env python3
"""
音声つきの動画で、beat_phase.py が決めたカウント 1 の位置（beatGrid.downbeat）を確かめる。

カウント単位の正解は無いので、次の 3 つで見る:
  (a) 正解表の女性の通過（cbl / swap、optional を除く）が、決めた格子のカウント 2 ± 1 に集まるか。
      音だけで決めた小節の位相（4 拍周期）は踊りを一切見ていないので、通過が 2±1（または 6±1）に来るかは独立な確かめになる。
      踊りの手がかり（CV の入れ替わり）だけで決めた位相（フォールバック）も同じ物差しで並べる。
  (b) 2〜3 小節の目視用の画像（PNG）: 拍ごとの動画のコマ（1・2 に印）と、波形・帯域ごとのオンセット・格子線。
  (c) routine のあるジョブで、normalize_routine を downbeat あり / なしで回し、eval_routine_grid の指標を比べる。

Usage:
  python eval_downbeat.py --ffmpeg <ffmpeg> --out <dir> <正解表の名前>=<動画>[@<routine のあるジョブID>] ...
  （MOTION_LAB_STORAGE=<storage> で解析出力の場所を指定。正解表の job / outDir の tracks から今のコードで events を作る）
"""
import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze_beats as ab          # noqa: E402
import beat_phase as bp             # noqa: E402

STORAGE_DIR = os.environ.get("MOTION_LAB_STORAGE") or os.path.join(HERE, "..", "storage")


def gt_out_dir(gt):
    if gt.get("outDir"):
        return os.path.join(STORAGE_DIR, gt["outDir"])
    return os.path.join(STORAGE_DIR, "analysis-jobs", gt["job"], "out")


def load_events(gt):
    import analyze_pair as ap   # ultralytics を読むので評価のときだけ
    with open(os.path.join(gt_out_dir(gt), "measurements.tracks.json"), encoding="utf-8") as f:
        data = json.load(f)
    return ap.detect_events(data["frames"], data["leaderPid"])


def extract_wav(ffmpeg, video, out):
    if not os.path.exists(out):
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", video, "-ac", "1", "-ar", "22050",
                        "-af", "aresample=async=1:first_pts=0", out]  # jobWorker と同じ（WAV の 0 = 動画の 0 秒）, check=True)
    return out


def grid_of(x, sr):
    flux, esr = ab.onset_envelope(x, sr)
    g = ab.estimate_grid(x, flux, esr)
    if g is None:
        return None
    return {"bpm": g["bpm"], "firstBeatSec": g["offset"] / esr, "beatIntervalSec": g["period"] / esr,
            "confidence": g["confidence"]}


def in_range(gt, t):
    lo, hi = gt.get("evalRange") or (float("-inf"), float("inf"))
    return lo <= t <= hi


def pass_times(gt):
    return [c["t"] for c in gt.get("cbl", []) if not c.get("optional") and in_range(gt, c["t"])]


def count_stats(times, downbeat, ib):
    """各時刻のカウント（1.0〜8.99）と、2±1 に入った割合・4 拍周期でたたんだとき 2±1 に入った割合"""
    cs = [bp.count_of(t, downbeat, ib) for t in times]
    if not cs:
        return {"n": 0}
    near2 = sum(1 for c in cs if 1.0 <= c <= 3.0)
    bar = [((c - 1) % 4) + 1 for c in cs]                     # 1 小節（4 拍）でたたむ: 2 と 6 を同じに見る
    near2_bar = sum(1 for c in bar if 1.0 <= c <= 3.0)
    z = sum(complex(math.cos(2 * math.pi * (c - 1) / 8), math.sin(2 * math.pi * (c - 1) / 8)) for c in cs) / len(cs)
    zb = sum(complex(math.cos(2 * math.pi * (c - 1) / 4), math.sin(2 * math.pi * (c - 1) / 4)) for c in bar) / len(bar)
    return {
        "n": len(cs), "counts": [round(c, 2) for c in cs],
        "in2pm1": round(near2 / len(cs), 3),
        "barIn2pm1": round(near2_bar / len(cs), 3),
        "meanCount": round((math.atan2(z.imag, z.real) / (2 * math.pi) * 8) % 8 + 1, 2), "R": round(abs(z), 3),
        "meanBarCount": round((math.atan2(zb.imag, zb.real) / (2 * math.pi) * 4) % 4 + 1, 2), "barR": round(abs(zb), 3),
    }


def routine_metrics(job, grid, downbeat, gt):
    """ジョブの result.json を、beatGrid を差し替えた measurements で正規化し直して採点する"""
    import copy
    import eval_routine_grid as erg
    import normalize_routine as nr
    import pair_sides
    out = os.path.join(STORAGE_DIR, "analysis-jobs", job, "out")
    with open(os.path.join(out, "result.json"), encoding="utf-8") as f:
        result = json.load(f)
    with open(os.path.join(out, "measurements.json"), encoding="utf-8") as f:
        meas = json.load(f)
    tracks = pair_sides.load_tracks(os.path.join(out, "measurements.tracks.json"))
    duration = meas["totalFrames"] / meas["fps"]
    res = {}
    for label, db in (("noDownbeat", None), ("downbeat", downbeat)):
        r = copy.deepcopy(result)
        s = copy.deepcopy(meas["summary"])
        g = {"bpm": round(grid["bpm"], 1), "firstBeatSec": round(grid["firstBeatSec"], 3),
             "beatIntervalSec": round(grid["beatIntervalSec"], 4), "confidence": grid["confidence"]}
        if db:
            g["downbeat"] = db
        s["beatGrid"] = g
        nr.normalize(r, s, duration, None, tracks)
        ro = r["routine"]
        ev = erg.evaluate(ro["moves"], gt, ro["grid"]["beatSec"], erg.cv_swaps_from({"summary": s}))
        res[label] = {"grid": ro["grid"], **{k: ev[k] for k in ("cbl", "swap", "cblRows", "rowAgree", "turn", "rows", "phase")}}
    return res


# ---------------------------------------------------------------- 目視用の画像

def frames_at(video, times, height=220):
    import cv2
    from frame_time import grab_at
    cap = cv2.VideoCapture(video)
    out = []
    for t in times:
        fr, _ = grab_at(cap, t)  # PTS の t に出ているコマ（README 27）
        if fr is None:
            fr = np.zeros((height, int(height * 0.56), 3), np.uint8)
        h, w = fr.shape[:2]
        fr = cv2.resize(fr, (int(w * height / h), height))
        out.append(fr[:, :, ::-1])
    cap.release()
    return out


def evidence_png(path, name, video, x, sr, grid, db, gt, t_center, bars=3):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ib = grid["beatIntervalSec"]
    d = db["sec"]
    # t_center を含む 8 カウントの頭から bars 小節（4 拍）ぶん。通過が 1 小節目に入るように 1 拍前から
    k = math.floor((t_center - d) / (4 * ib))
    t0 = d + k * 4 * ib
    t1 = t0 + bars * 4 * ib
    beats = [t0 + i * ib for i in range(bars * 4)]
    imgs = frames_at(video, beats)
    fig = plt.figure(figsize=(2.0 * len(beats), 12.5))
    gs = fig.add_gridspec(4, len(beats), height_ratios=[1.25, 0.8, 1.2, 0.9])
    for i, (t, im) in enumerate(zip(beats, imgs)):
        ax = fig.add_subplot(gs[0, i])
        ax.imshow(im)
        ax.set_xticks([]); ax.set_yticks([])
        c = int(round(bp.count_of(t, d, ib))) % 8 or 8
        col = {1: "tab:red", 2: "tab:blue", 5: "tab:red", 6: "tab:blue"}.get(c, "black")
        ax.set_title(f"{c}\n{t:.2f}s", color=col, fontsize=13, fontweight="bold" if c in (1, 2, 5, 6) else None)
        for s in ax.spines.values():
            s.set_edgecolor(col); s.set_linewidth(3 if c in (1, 2, 5, 6) else 0.5)
    # 波形
    ax = fig.add_subplot(gs[1, :])
    seg = x[int(max(0, t0 - 0.2) * sr):int((t1 + 0.2) * sr)]
    tt = max(0, t0 - 0.2) + np.arange(len(seg)) / sr
    ax.plot(tt, seg, lw=0.3, color="0.3")
    ax.set_xlim(t0 - 0.2, t1 + 0.2)
    ax.set_ylabel("waveform")
    # 帯域ごとのオンセット
    ax2 = fig.add_subplot(gs[2, :], sharex=ax)
    on, fsr = bp.band_onsets(x[int(max(0, t0 - 0.2) * sr):int((t1 + 0.2) * sr)], sr)
    ft = max(0, t0 - 0.2) + np.arange(on.shape[1]) / fsr
    for i, (bn, (lo, hi)) in enumerate(bp.BANDS.items()):
        v = on[i] / (on[i].max() + 1e-9)
        ax2.plot(ft, v + 1.1 * i, lw=0.8, label=f"{bn} {lo}-{hi}Hz")
        ax2.text(t0 - 0.18, 1.1 * i + 0.75, bn, fontsize=9)
    for a in (ax, ax2):
        for b in range(bars * 8 + 1):
            t = t0 + b * ib / 2
            if t > t1 + 1e-6:
                break
            c = bp.count_of(t, d, ib)
            ci = int(round(c * 2)) / 2
            if abs(ci - round(ci)) > 0.1:
                a.axvline(t, color="0.85", lw=0.6, ls=":")
                continue
            ci = int(round(ci)) % 8 or 8
            col = {1: "tab:red", 5: "tab:red", 2: "tab:blue", 6: "tab:blue"}.get(ci, "0.6")
            a.axvline(t, color=col, lw=2.0 if ci in (1, 2, 5, 6) else 0.8)
            if a is ax:
                a.text(t + 0.01, a.get_ylim()[1] * 0.85, str(ci), color=col, fontsize=11, fontweight="bold")
    for t in pass_times(gt):
        if t0 - 0.2 <= t <= t1 + 0.2:
            for a in (ax, ax2):
                a.axvline(t, color="tab:green", lw=2.5, ls="--")
            ax.text(t + 0.01, ax.get_ylim()[0] * 0.8, "GT pass", color="tab:green", fontsize=10)
    ax2.set_xlabel("sec   (red = 1/5, blue = 2/6, green dashed = GT pass)")
    ax2.set_yticks([])
    # 全編を決めたカウント 1 から 1 小節（半拍 8 個）でたたんだ帯域ごとの平均の強さ。楽器の打点（テンプレート）に印
    on_all, fsr_all = bp.band_onsets(x, sr)
    half = bp.half_beat_strengths(on_all, fsr_all, d % (4 * ib), ib, len(x) / sr)
    nb = len(half) // 8
    fold = half[:nb * 8].reshape(nb, 8, -1).mean(axis=0)
    labels = ["1", "&", "2", "&", "3", "&", "4", "&"]
    nbands = len(bp.BANDS)
    span = max(1, len(beats) // nbands)
    for i, (bn, (lo, hi)) in enumerate(bp.BANDS.items()):
        ax3 = fig.add_subplot(gs[3, i * span:(i + 1) * span])
        tpl = bp.BAND_TEMPLATES.get(bn, {})
        cols = ["tab:orange" if tpl.get(s, 0) > 0 else ("tab:gray" if tpl.get(s, 0) < 0 else "0.75") for s in range(8)]
        ax3.bar(range(8), fold[:, i], color=cols)
        ax3.set_xticks(range(8)); ax3.set_xticklabels(labels)
        ax3.set_ylim(0, max(2.0, fold[:, i].max() * 1.1))
        ax3.set_title(f"{bn} {lo}-{hi}Hz (orange = template)", fontsize=9)
    ev = db["evidence"]
    a_ = ev.get("audio") or {}
    fig.suptitle(f"{name}: downbeat {d:.3f}s src={db['source']} conf={db['confidence']} bar={db['barConfidence']} "
                 f"phrase={db['phraseConfidence']} offbeatGrid={db['offbeatGrid']}  audio conf={a_.get('confidence')} "
                 f"effect={a_.get('effect')}  bpm={grid['bpm']:.1f}", fontsize=12)
    fig.tight_layout()
    fig.savefig(path, dpi=60)
    plt.close(fig)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--ffmpeg", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--json")
    a.add_argument("items", nargs="+", help="<正解表の名前>=<動画>[@<ジョブID>]")
    args = a.parse_args()
    os.makedirs(args.out, exist_ok=True)
    allres = {}
    for item in args.items:
        name, rest = item.split("=", 1)
        video, job = (rest.split("@", 1) + [None])[:2] if "@" in rest else (rest, None)
        with open(os.path.join(HERE, "ground_truth", f"{name}.json"), encoding="utf-8") as f:
            gt = json.load(f)
        wav = extract_wav(args.ffmpeg, video, os.path.join(args.out, f"{name}.wav"))
        x, sr = ab.read_wav_mono(wav)
        res = {"silent": ab.is_silent(x)}
        grid = None if res["silent"] else grid_of(x, sr)
        if grid is None:
            allres[name] = res
            print(name, res)
            continue
        events = [e for e in load_events(gt) if in_range(gt, e["t"])]
        summary = {"events": events}
        db = bp.estimate_downbeat(x, sr, grid, summary)
        db_dance = bp.estimate_downbeat(None, sr, grid, summary)     # 踊りだけ（フォールバック）
        ib = grid["beatIntervalSec"]
        res.update({
            "grid": {k: round(v, 4) for k, v in grid.items()},
            "downbeat": db,
            "danceOnly": {k: db_dance[k] for k in ("sec", "confidence", "offsetHalfBeats")},
            "gtPass": count_stats(pass_times(gt), db["sec"], ib),
            "gtPassDanceOnly": count_stats(pass_times(gt), db_dance["sec"], ib),
            "gtFollowerTurn": count_stats([t["t"] for t in gt.get("turns", []) if t.get("by") == "follower"
                                           and not t.get("optional") and in_range(gt, t["t"])], db["sec"], ib),
        })
        # 音だけの小節の位相（踊りを使わない）で、通過が 1 小節の中の 2±1 に来るか
        au = db["evidence"]["audio"]
        if au and au.get("phaseHalf") is not None:
            d_audio = grid["firstBeatSec"] + au["phaseHalf"] * ib / 2
            res["gtPassAudioOnly"] = count_stats(pass_times(gt), d_audio, ib)
        ps = pass_times(gt)
        if ps:
            # 目視用: 通過のうち真ん中あたりのもの
            tc = ps[len(ps) // 2]
            png = os.path.join(args.out, f"downbeat_{name}.png")
            evidence_png(png, name, video, x, sr, grid, db, gt, tc)
            res["png"] = png
        if job:
            res["routine"] = routine_metrics(job, grid, db, gt)
        allres[name] = res
        print(json.dumps({name: {k: v for k, v in res.items() if k != "downbeat"}}, ensure_ascii=False))
        print("  downbeat:", json.dumps({k: v for k, v in db.items() if k != "evidence"}, ensure_ascii=False))
        print("  audio:", json.dumps(db["evidence"]["audio"], ensure_ascii=False))
        print("  dance:", json.dumps(db["evidence"]["dance"], ensure_ascii=False))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(allres, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
