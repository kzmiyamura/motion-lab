#!/usr/bin/env python3
"""
区間だけの再解析用に、その区間（from〜to 秒）専用の画像を作る（make_strips.py の関数を再利用）。

  seg_overview.jpg   … 区間全体を step 秒刻みで並べた一覧（2人の外接矩形で切り取り）
  seg_detail_<n>.jpg … 2人の上半身を大きく、dstep 秒刻み 6 コマの 3x2（腕の形・手のつなぎ・頭に手をかける動きを読む）
  seg_meta.json      … {width,height,fps,cuts:[秒]}。cuts は連続コマの色ヒストグラムの相関が急に落ちた時刻（撮影の編集で場面が切り替わった所）

Usage: python make_segment_images.py <video> <out_dir> --from=<秒> --to=<秒> [--tracks=<tracks.json>]
         [--step=0.2] [--dstep=0.3] [--max-detail=3] [--no-overview] [--no-detail]
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_strips as ms  # noqa: E402

CUT_CORR = 0.6   # 連続コマのヒストグラム相関がこれ未満なら場面の切り替わり


def hist(img):
    small = cv2.resize(img, (64, 64), interpolation=cv2.INTER_AREA)
    h = cv2.calcHist([small], [0, 1, 2], None, [8, 8, 8], [0, 256] * 3)
    return cv2.normalize(h, h).flatten()


def find_cuts(frames, times):
    cuts = []
    prev = None
    for f, t in zip(frames, times):
        h = hist(f)
        if prev is not None and cv2.compareHist(prev, h, cv2.HISTCMP_CORREL) < CUT_CORR:
            cuts.append(round(t - ms.STEP_SEC / 2, 2))
        prev = h
    return cuts


def main():
    args = {}
    pos = []
    for a in sys.argv[1:]:
        if a.startswith("--"):
            k, _, v = a[2:].partition("=")
            args[k] = v
        else:
            pos.append(a)
    if len(pos) < 2 or "from" not in args or "to" not in args:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    video, out_dir = pos
    t_from, t_to = float(args["from"]), float(args["to"])
    step = float(args.get("step", 0.2))
    dstep = float(args.get("dstep", 0.3))
    max_detail = int(args.get("max-detail", 3))
    dn = int(args.get("dn", ms.DETAIL_N))          # 詳細画像 1 枚のコマ数
    dscale = float(args.get("dscale", 1.0))        # 詳細画像のタイルの大きさの倍率
    oscale = float(args.get("oscale", 1.0))        # 一覧画像のタイルの大きさの倍率
    tracks = None
    if args.get("tracks"):
        with open(args["tracks"], encoding="utf-8") as fp:
            tracks = json.load(fp)
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print(f"failed to open video: {video}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    dense, dtimes = ms.read_window(cap, fps, t_from, t_to, ms.STEP_SEC)
    if not dense:
        print("no frames", file=sys.stderr)
        sys.exit(1)
    h, w = dense[0].shape[:2]
    meta = {"width": w, "height": h, "fps": fps, "cuts": find_cuts(dense, dtimes)}
    written = []

    if "no-overview" not in args:
        frames, times = ms.read_window(cap, fps, t_from, t_to, step)
        frames, times = frames[:ms.SHEET_MAX_TILES], times[:ms.SHEET_MAX_TILES]
        crop = ms.union_crop(tracks, t_from - step, t_to + step, w, h)
        cols = min(7 if h >= w else 5, len(frames))
        tile = ms.tile_size(w, h, cols, crop)
        if oscale != 1.0:
            tile = (max(int(tile[0] * oscale), 16), max(int(tile[1] * oscale), 16))
        sheet = ms.build_sheet(frames, times, crop, tile=tile)
        cv2.imwrite(os.path.join(out_dir, "seg_overview.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
        written.append("seg_overview.jpg")

    if "no-detail" not in args and tracks:
        t = t_from
        n = 0
        d_end = float(args.get("detail-to", t_to))
        while t <= d_end + 1e-6 and n < max_detail:
            d_to = t + dstep * (dn - 1)
            frames, times = ms.read_window(cap, fps, t, d_to, dstep)
            if frames:
                crop = ms.upper_body_crop(tracks, t - 0.1, d_to + 0.1, w, h)
                if crop is not None:
                    tw, th = ms.detail_tile_size(crop)  # 6 コマ前提の大きさ
                    tile = (max(int(tw * dscale), 16), max(int(th * dscale), 16))
                    sheet = ms.build_sheet(frames, times, crop, cols=3 if dn > 4 else 2, tile=tile)
                    n += 1
                    name = f"seg_detail_{n}.jpg"
                    cv2.imwrite(os.path.join(out_dir, name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
                    written.append(name)
            t = d_to + dstep
    cap.release()
    meta["files"] = written
    with open(os.path.join(out_dir, "seg_meta.json"), "w", encoding="utf-8") as fp:
        json.dump(meta, fp)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
