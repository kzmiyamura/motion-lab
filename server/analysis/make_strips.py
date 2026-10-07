#!/usr/bin/env python3
"""
技イベントごとに、連続フレームを時刻付きで並べた一覧画像（ストリップ）を書き出す。

入り・最中・出口の3枚（0.6秒間隔）では、ターン中の体の向きの変化が追えず、回転の向き・回転数・
手のつなぎを読み違えていた（9/23 の人手校正で実測）。0.1秒刻みで並べると、正面→横顔→背中の
変化を1枚ずつ追えるので、回る向きと回転数が読める。

OpenCV のみ（extract_keyframes.py と同じ環境で動く）。

Usage: python make_strips.py <video_path> <out_dir> [--tracks=<tracks.json>] <t>:<label>[:<from>:<to>] [...]
  --tracks があれば、各ストリップを2人の外接矩形（上25%・左右15%・下10%の余白、全コマ共通の和集合）で
  元の解像度のコマから切り取る（画素数は従来と同じか小さく、拡大は元画素の2倍まで、縦横比は変えない）。
  取れないときは今までどおり全体。枠の辺は外れ値に強い分位点。端数のストリップは列数を詰める。
  さらに --tracks があれば <秒>_<label>_detail.jpg（2人の上半身を大きく、0.3秒刻み6コマの3x2）も書く。
  各イベント時刻 t について [t-PRE_SEC, t+POST_SEC] を STEP_SEC 刻みで切り出す。
  from/to を指定すると、その範囲も含むように広げる（連続ターンが長いとき。最大 MAX_SPAN_SEC）。
出力ファイル名: <秒を0埋め6桁+小数1桁>_<label>_strip.jpg（例: 000038.6_turn_strip.jpg）
  21コマを超える区間は _strip_2.jpg, _strip_3.jpg … に続きを書く
"""
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from frame_time import seek_read  # noqa: E402

PRE_SEC = 0.4
POST_SEC = 1.6
STEP_SEC = 0.1
MAX_SPAN_SEC = 5.0
SHEET_MAX_TILES = 21
SHEET_MAX_W = 1800
LABEL_H = 34


MARGIN_TOP, MARGIN_SIDE, MARGIN_BOTTOM = 0.25, 0.15, 0.10  # 2人の外接矩形への余白（手を上げても切れない）
MIN_PAIR_RATIO = 0.4   # 窓内のこの割合のコマで2人が取れなければ全体のまま
MAX_UPSCALE = 2.0      # 元の画素に対する拡大の上限（それ以上はぼやけるだけ）
MIN_HEIGHT_RATIO = 0.6  # 2人の箱の高さの比がこれ未満なら、小さい方は奥の別人（背景）とみなす
MAX_FOOT_GAP = 0.3     # 2人の足元（bbox 下端）のずれが背の高い方の箱の高さのこの割合を超えたら別人


def pair_pids(tracks):
    lp = (tracks or {}).get("leaderPid")
    return (lp, 1 - lp) if lp in (0, 1) else (0, 1)


def _box_area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def background_pid(boxes):
    """2人の bbox（{pid: [x1,y1,x2,y2]}）が組んでいるペアに見えないとき、奥にいる別人の pid を返す（なければ None）。
    一方が手前の相手の陰に隠れている間、追跡が背後の人に乗り換わる（820f0461 の冒頭 0〜1.4 秒）。
    背景の人は箱の高さがペアの半分以下で、足元の高さ（bbox 下端）もずれる。踊り手の箱が欠けた1コマでも
    高さ比が MIN_HEIGHT_RATIO を割ることは少ないので、両方の条件でなく高さ比か足元のずれのどちらかで判定する"""
    if len(boxes) != 2:
        return None
    (pa, a), (pb, b) = boxes.items()
    ha, hb = a[3] - a[1], b[3] - b[1]
    big, small = (pa, pb) if _box_area(a) >= _box_area(b) else (pb, pa)
    hmax = max(ha, hb)
    if hmax <= 0:
        return None
    if min(ha, hb) / hmax < MIN_HEIGHT_RATIO or abs(a[3] - b[3]) > MAX_FOOT_GAP * hmax:
        return small
    return None


def pair_boxes(frame, pids):
    """このコマのペアの bbox（{pid: bbox}）。背景の別人に乗り換わっていれば、そちらを除いて踊り手側だけにする。
    戻り値の第2要素は「ペアが映っていたコマか」（背景を除いた場合も True。隠れているだけで踊り手はいる）"""
    got = {p["pid"]: p["bbox"] for p in frame.get("kept", []) if p.get("pid") in pids and p.get("bbox")}
    if len(got) < 2:
        return got, False
    bg = background_pid(got)
    if bg is not None:
        del got[bg]
    return got, True


def union_crop(tracks, t_from, t_to, w, h):
    """窓 [t_from, t_to] の全コマで、2人（リーダー・フォロワー）の bbox の和集合に余白を足した切り取り枠（元画素）。
    2人がそろったコマが少なければ None（全体のまま）。縦横比はそのまま（タイルを枠の比で作る）。
    片方が隠れて背後の別人に乗り換わったコマは、その別人の箱を使わない"""
    if not tracks:
        return None
    pids = set(pair_pids(tracks))
    boxes, total, paired = [], 0, 0
    for f in tracks.get("frames", []):
        t = f.get("t")
        if t is None or not (t_from <= t <= t_to):
            continue
        total += 1
        got, ok = pair_boxes(f, pids)
        if ok:
            paired += 1
            boxes.extend(got.values())
    if total == 0 or paired < MIN_PAIR_RATIO * total:
        return None
    # 1コマの外れ値（骨格の飛び・他人の混入）で枠が広がらないよう、各辺は分位点で決める
    q = lambda vals, p: float(np.percentile(vals, p))
    x1 = q([b[0] for b in boxes], 10); x2 = q([b[2] for b in boxes], 90)
    y1 = q([b[1] for b in boxes], 5); y2 = q([b[3] for b in boxes], 95)
    bw, bh = (x2 - x1) * w, (y2 - y1) * h
    X1 = max(0, int(math.floor(x1 * w - bw * MARGIN_SIDE)))
    X2 = min(w, int(math.ceil(x2 * w + bw * MARGIN_SIDE)))
    Y1 = max(0, int(math.floor(y1 * h - bh * MARGIN_TOP)))
    Y2 = min(h, int(math.ceil(y2 * h + bh * MARGIN_BOTTOM)))
    if X2 - X1 < 32 or Y2 - Y1 < 32:
        return None
    return X1, Y1, X2, Y2


def tile_size(w, h, cols, crop):
    """タイルの大きさ。1枚の画素数は従来（全体を縮めたもの）と同じかそれ以下。
    切り取りの縦横比は変えず、元の画素の MAX_UPSCALE 倍までしか拡大しない"""
    old_w = SHEET_MAX_W // cols
    old_h = int(round(h * old_w / w))
    if crop is None:
        return old_w, old_h
    cw, ch = crop[2] - crop[0], crop[3] - crop[1]
    area = old_w * old_h
    tw = math.sqrt(area * cw / ch)
    tw = min(tw, SHEET_MAX_W // cols, MAX_UPSCALE * cw)
    th = tw * ch / cw
    if tw * th > area:
        tw *= math.sqrt(area / (tw * th)); th = tw * ch / cw
    return max(int(tw), 16), max(int(th), 16)


UPPER_KPS = (0, 5, 6, 7, 8, 9, 10, 11, 12)  # 鼻・肩・肘・手首・腰（COCO）
UPPER_MARGIN_SIDE, UPPER_MARGIN_TOP, UPPER_MARGIN_BOTTOM = 0.15, 0.20, 0.10
DETAIL_PRE, DETAIL_STEP, DETAIL_N, DETAIL_COLS = 0.6, 0.3, 6, 3
DETAIL_BUDGET = SHEET_MAX_W * 1500  # 詳細画像1枚の画素数の上限（ストリップ1枚と同程度以下）


def upper_body_crop(tracks, t_from, t_to, w, h):
    """窓内の2人の上半身（鼻・肩・肘・手首・腰。信頼度 0.3 以上）の和集合に余白を足した枠（元画素）。
    各辺は 5〜95% の分位点（骨格の飛びに強い）。どちらかの人が取れたコマが2未満なら None"""
    if not tracks:
        return None
    pids = set(pair_pids(tracks))
    xs, ys, paired = [], [], 0
    for f in tracks.get("frames", []):
        t = f.get("t")
        if t is None or not (t_from <= t <= t_to):
            continue
        # 隠れた間に背後の別人へ乗り換わったコマは、その人の骨格を使わない（踊り手側だけで枠を決める）
        use, ok = pair_boxes(f, pids)
        paired += ok
        for p in f.get("kept", []):
            if p.get("pid") not in use or not p.get("kps"):
                continue
            pts = [p["kps"][i] for i in UPPER_KPS if i < len(p["kps"]) and p["kps"][i][2] >= 0.3]
            if len(pts) >= 4:
                xs.extend(q[0] for q in pts)
                ys.extend(q[1] for q in pts)
    if paired < 2 or not xs:
        return None
    x1, x2 = np.percentile(xs, 5), np.percentile(xs, 95)
    y1, y2 = np.percentile(ys, 5), np.percentile(ys, 95)
    bw, bh = (x2 - x1) * w, (y2 - y1) * h
    X1 = max(0, int(math.floor(x1 * w - bw * UPPER_MARGIN_SIDE)))
    X2 = min(w, int(math.ceil(x2 * w + bw * UPPER_MARGIN_SIDE)))
    Y1 = max(0, int(math.floor(y1 * h - bh * UPPER_MARGIN_TOP)))
    Y2 = min(h, int(math.ceil(y2 * h + bh * UPPER_MARGIN_BOTTOM)))
    if X2 - X1 < 32 or Y2 - Y1 < 32:
        return None
    return X1, Y1, X2, Y2


def detail_tile_size(crop):
    """詳細画像のタイル。縦横比は枠のまま、幅は 3 列で SHEET_MAX_W 以内、拡大は元の2倍まで、1枚が DETAIL_BUDGET 以下"""
    cw, ch = crop[2] - crop[0], crop[3] - crop[1]
    tw = min(math.sqrt(DETAIL_BUDGET / DETAIL_N * cw / ch), SHEET_MAX_W // DETAIL_COLS, MAX_UPSCALE * cw)
    return max(int(tw), 16), max(int(tw * ch / cw), 16)


def resize_tile(img, tw, th):
    interp = cv2.INTER_AREA if tw <= img.shape[1] else cv2.INTER_CUBIC
    return cv2.resize(img, (tw, th), interpolation=interp)


def build_sheet(frames, times, crop=None, cols=None, tile=None):
    """フレーム列を時刻ラベル付きのグリッドに並べる。crop=(x1,y1,x2,y2) 元画素なら全コマ共通でそこだけ切り取る。
    列数はコマ数を超えない（端数の1コマが7列ぶんの白い余白にならない）。tile=(w,h) で寸法を指定できる"""
    h, w = frames[0].shape[:2]
    if cols is None:
        cols = 7 if h >= w else 5
    if tile is None:
        tile = tile_size(w, h, cols, crop)
    tile_w, tile_h = tile
    cols = min(cols, len(frames))
    rows = math.ceil(len(frames) / cols)
    sheet = np.full((rows * tile_h, cols * tile_w, 3), 255, np.uint8)
    for i, (f, t) in enumerate(zip(frames, times)):
        if crop is not None:
            f = f[crop[1]:crop[3], crop[0]:crop[2]]
        tile = resize_tile(f, tile_w, tile_h)
        cv2.rectangle(tile, (0, 0), (int(tile_w * 0.42), LABEL_H), (0, 0, 0), -1)
        cv2.putText(tile, f"{t:.2f}", (6, LABEL_H - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 235, 255), 2, cv2.LINE_AA)
        r, c = divmod(i, cols)
        sheet[r * tile_h:(r + 1) * tile_h, c * tile_w:(c + 1) * tile_w] = tile
    return sheet


def read_window(cap, fps, t_from, t_to, step=STEP_SEC):
    """[t_from, t_to] を step 刻みで読む。先頭へ1回だけシークし、以降は順読みで最寄りフレームを拾う"""
    targets = []
    t = t_from
    while t <= t_to + 1e-6:
        targets.append(round(t, 2))
        t += step
    # POS_MSEC のシークは可変フレームレートで最大 0.3 秒遅れて着くので、手前に着いたことを確かめてから読む（README 27）
    frame, cur = seek_read(cap, t_from - 0.05)
    frames, times = [], []
    k = 0
    while frame is not None and k < len(targets):
        # このフレームが目標時刻を越えたら採用（半フレーム手前から許容）
        while k < len(targets) and cur >= targets[k] - 0.5 / fps:
            frames.append(frame)
            times.append(targets[k])
            k += 1
        ret, frame = cap.read()
        if not ret:
            break
        cur = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
    return frames, times


def write_detail(cap, fps, tracks, out_dir, t, label):
    """詳細画像: イベント前後の 0.3 秒刻み 6 コマを 3x2 に並べ、2人の上半身だけを元解像度から切り取る。
    手のつなぎ・頭に手をかける等の腕の形を読むため。tracks が無い・2人の骨格が取れなければ作らない"""
    if not tracks:
        return
    d_from = max(0.0, t - DETAIL_PRE)
    d_to = d_from + DETAIL_STEP * (DETAIL_N - 1)
    frames, times = read_window(cap, fps, d_from, d_to, DETAIL_STEP)
    if not frames:
        return
    fh, fw = frames[0].shape[:2]
    crop = upper_body_crop(tracks, d_from - 0.1, d_to + 0.1, fw, fh)
    if crop is None:
        return
    tile = detail_tile_size(crop)
    sheet = build_sheet(frames, times, crop, cols=DETAIL_COLS, tile=tile)
    name = f"{t:08.1f}_{label}_detail.jpg".replace(" ", "0")
    if os.environ.get("STRIP_VERBOSE"):
        print(f"{name}: src={fw}x{fh} crop={crop} tile={tile} sheet={sheet.shape[1]}x{sheet.shape[0]}", file=sys.stderr)
    cv2.imwrite(os.path.join(out_dir, name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])


def main():
    if len(sys.argv) < 4:
        print("Usage: make_strips.py <video_path> <out_dir> <t>:<label> [...]", file=sys.stderr)
        sys.exit(1)
    tracks = None
    argv = []
    for a in sys.argv[1:]:
        if a.startswith("--tracks="):
            try:
                with open(a[len("--tracks="):], encoding="utf-8") as fp:
                    tracks = json.load(fp)
            except (OSError, ValueError) as e:
                print(f"warn: tracks unreadable, full frames: {e}", file=sys.stderr)
        else:
            argv.append(a)
    video_path, out_dir = argv[0], argv[1]
    specs = []
    for arg in argv[2:]:
        parts = arg.split(":")
        t = float(parts[0])
        t_from, t_to = max(0.0, t - PRE_SEC), t + POST_SEC
        if len(parts) >= 4:
            t_from = max(0.0, min(t_from, float(parts[2])))
            t_to = min(max(t_to, float(parts[3])), t_from + MAX_SPAN_SEC)
        specs.append((t, parts[1], t_from, t_to))
    os.makedirs(out_dir, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    written = 0
    for t, label, t_from, t_to in sorted(specs):
        frames, times = read_window(cap, fps, t_from, t_to)
        if not frames:
            print(f"warn: no frames around t={t}", file=sys.stderr)
            continue
        # 長い区間は1枚に詰めるとコマが小さくて読めないので、SHEET_MAX_TILES コマずつ別の画像に分ける
        for part, i in enumerate(range(0, len(frames), SHEET_MAX_TILES), start=1):
            suffix = "" if part == 1 else f"_{part}"
            name = f"{t:08.1f}_{label}_strip{suffix}.jpg".replace(" ", "0")
            fs, ts = frames[i:i + SHEET_MAX_TILES], times[i:i + SHEET_MAX_TILES]
            fh, fw = fs[0].shape[:2]
            # 枠はイベントの窓全体で決める（続きの端数ストリップも同じ枠にして、コマ数が少なくても全体に戻らない）
            crop = union_crop(tracks, t_from - STEP_SEC, t_to + STEP_SEC, fw, fh)
            sheet = build_sheet(fs, ts, crop)
            if os.environ.get("STRIP_VERBOSE"):
                print(f"{name}: src={fw}x{fh} crop={crop} sheet={sheet.shape[1]}x{sheet.shape[0]}", file=sys.stderr)
            cv2.imwrite(os.path.join(out_dir, name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
        write_detail(cap, fps, tracks, out_dir, t, label)
        written += 1

    cap.release()
    print(f"done: {written}/{len(specs)} strips", file=sys.stderr)


if __name__ == "__main__":
    main()
