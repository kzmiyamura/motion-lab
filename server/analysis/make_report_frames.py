#!/usr/bin/env python3
"""
レポートの「技のタイムライン」の各場面に、2人の周りを切り取った連続コマ画像を付ける。

文章だけでは「ここで何をしているか」が掴みにくいので、見出し（**0:16 …** / **0:00〜0:04 …** /
- **00:08–00:09 …** / ### 0:16 … など。HEADING_RE 参照）の時刻から次の場面までを数コマに分け、
2人が収まる範囲を切り取って横に並べた画像を作り、見出しの直後に Markdown の画像行
（字下げなしの1行。ReportModal は行まるごとの ![..](..) だけを画像として描く）として差し込む。

切り取り範囲は tracks.json の採用ペア（pid 0/1）の bbox を区間全体で合わせたもの。
区間内で同じ範囲を使うので、コマ同士を見比べたときに位置の変化がそのまま分かる。

OpenCV のみ（make_strips.py と同じ環境で動く）。何度実行しても同じ結果になる（既存の画像行は差し替える）。

Usage: python make_report_frames.py <video_path> <tracks.json> <report.md> <out_dir> <url_prefix> [<out_report.md>]
  out_dir   : 画像の書き出し先（例: <job>/out/report_frames）
  url_prefix: レポートに書く画像URLの前置き（例: /analysis-output/<jobId>/out/report_frames）
  out_report.md を省略すると report.md を上書きする
"""
import json
import os
import re
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from frame_time import grab_at  # noqa: E402

FRAMES_PER_SCENE = 5
MIN_SPAN_SEC = 1.0
MAX_SPAN_SEC = 2.5
TILE_H = 360
MAX_SHEET_W = 1400
MARGIN = 0.08
LABEL_H = 30

# 場面の見出し行。Claude の書き方は揺れるので、以下をすべて受け付ける:
#   **0:16 …** / **0:00〜0:04 …** / - **00:08–00:09 …** / * **00:14 …** / 1. **0:20 …**
#   ### 0:16 … / - 0:16 … / **0:10.7〜0:11.1 …**
# 区切りは 〜 ~ - – — のいずれか。分は1〜2桁、秒の小数は任意
_TIME = r"(\d{1,2}):(\d{2})(?:\.(\d+))?"
HEADING_RE = re.compile(
    r"^(?P<list>(?:[-*+]|\d+[.)])\s+)?"   # 箇条書きの記号（任意）
    r"(?P<hash>#{1,6}\s+)?"                # Markdown 見出し（任意）
    r"(?P<bold>\*\*)?"                     # 太字（任意）
    + _TIME +
    r"(?:\s*[〜~\-–—]\s*" + _TIME + r")?"
    r"(?!\d)"
)
TIMELINE_SECTION_RE = re.compile(r"^(#{1,6})\s+.*タイムライン")
ANY_HEADING_RE = re.compile(r"^(#{1,6})\s+")
IMAGE_LINE_RE = re.compile(r"^!\[[^\]]*\]\([^)]*/report_frames/[^)]*\)\s*$")


def _to_sec(m, s, d):
    return int(m) * 60 + int(s) + (float(f"0.{d}") if d else 0.0)


def _timeline_range(lines):
    """「技のタイムライン」節の [開始行, 終了行)。節が無ければ None"""
    for i, line in enumerate(lines):
        h = TIMELINE_SECTION_RE.match(line.strip())
        if not h:
            continue
        level = len(h.group(1))
        for j in range(i + 1, len(lines)):
            nh = ANY_HEADING_RE.match(lines[j].strip())
            if nh and len(nh.group(1)) <= level:
                return i + 1, j
        return i + 1, len(lines)
    return None


def parse_scenes(lines):
    """見出し行の (行番号, 開始秒, 明示された終了秒 or None, 画像を差し込む行番号) を返す。

    「技のタイムライン」節があればその中だけを見る（根拠・難所の節の箇条書きに画像を付けない）。
    節が無いときは誤検出を避けるため、太字か # 見出しの形だけを場面とみなす。
    箇条書きの場面は、続く字下げ行（同じ項目の続き・子項目）の後ろに画像を差し込む
    （項目の途中に画像を挟んで入れ子の箇条書きを壊さないため）。
    """
    rng = _timeline_range(lines)
    lo, hi = rng if rng else (0, len(lines))
    scenes = []
    for i in range(lo, hi):
        line = lines[i]
        m = HEADING_RE.match(line.strip())
        if not m:
            continue
        if rng is None and not (m.group("bold") or m.group("hash")):
            continue
        t0 = _to_sec(m.group(4), m.group(5), m.group(6))
        t1 = _to_sec(m.group(7), m.group(8), m.group(9)) if m.group(7) else None
        after = i
        if m.group("list"):
            while after + 1 < hi and lines[after + 1].strip() and lines[after + 1][:1] in (" ", "\t"):
                after += 1
        scenes.append((i, t0, t1, after))
    return scenes


def scene_windows(scenes, duration):
    """各場面の [開始, 終了]。終了は明示があればそれ、無ければ次の場面の開始（MIN〜MAX_SPAN_SEC に収める）"""
    out = []
    for k, (_, t0, t1, _) in enumerate(scenes):
        if t1 is None or t1 <= t0:
            nxt = scenes[k + 1][1] if k + 1 < len(scenes) else t0 + MAX_SPAN_SEC
            t1 = min(max(nxt, t0 + MIN_SPAN_SEC), t0 + MAX_SPAN_SEC)
        out.append((t0, min(t1, duration)))
    return out


def pair_box(frames, t0, t1):
    """区間内の採用ペアの bbox を合わせた範囲（正規化座標）。取れなければ None"""
    xs1, ys1, xs2, ys2 = [], [], [], []
    for f in frames:
        if not (t0 - 0.15 <= f["t"] <= t1 + 0.15):
            continue
        for p in f.get("kept", []):
            if p.get("pid") not in (0, 1) or not p.get("bbox"):
                continue
            x1, y1, x2, y2 = p["bbox"]
            xs1.append(x1); ys1.append(y1); xs2.append(x2); ys2.append(y2)
    if not xs1:
        return None
    # 一瞬だけ誤検出された枠で範囲が広がりすぎないよう、端は外れ値を落とした値を使う
    lo = lambda v: float(np.percentile(v, 5))
    hi = lambda v: float(np.percentile(v, 95))
    x1, y1, x2, y2 = lo(xs1), lo(ys1), hi(xs2), hi(ys2)
    mx, my = (x2 - x1) * MARGIN, (y2 - y1) * MARGIN
    # 上は頭上に上げた手が bbox からはみ出しやすいので広めに取る
    return max(0.0, x1 - mx), max(0.0, y1 - my * 2.5), min(1.0, x2 + mx), min(1.0, y2 + my)


def grab(cap, t):
    """時刻 t（秒。ブラウザの video.currentTime と同じ PTS の時計）に画面に出ているコマ。
    cv2 の POS_MSEC のシークだけだと可変フレームレートで最大 0.3 秒遅れたコマになるので frame_time.grab_at で直す（README 27）"""
    frame, _ = grab_at(cap, t)
    return frame


def fmt_time(t):
    m, s = divmod(t, 60)
    return f"{int(m)}:{s:04.1f}"


def build_sheet(cap, box, times):
    tiles = []
    for t in times:
        frame = grab(cap, t)
        if frame is None:
            continue
        h, w = frame.shape[:2]
        if box:
            x1, y1, x2, y2 = int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)
            if x2 - x1 > 10 and y2 - y1 > 10:
                frame = frame[y1:y2, x1:x2]
        fh, fw = frame.shape[:2]
        tile = cv2.resize(frame, (max(1, int(round(fw * TILE_H / fh))), TILE_H))
        label = fmt_time(t)
        cv2.rectangle(tile, (0, 0), (12 + 15 * len(label), LABEL_H), (0, 0, 0), -1)
        cv2.putText(tile, label, (6, LABEL_H - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 235, 255), 2, cv2.LINE_AA)
        tiles.append(tile)
    if not tiles:
        return None
    gap = np.full((TILE_H, 4, 3), 255, np.uint8)
    row = [tiles[0]]
    for tile in tiles[1:]:
        row += [gap, tile]
    sheet = np.hstack(row)
    if sheet.shape[1] > MAX_SHEET_W:
        sheet = cv2.resize(sheet, (MAX_SHEET_W, int(round(sheet.shape[0] * MAX_SHEET_W / sheet.shape[1]))))
    return sheet


def main():
    if len(sys.argv) < 6:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    video_path, tracks_path, report_path, out_dir, url_prefix = sys.argv[1:6]
    out_report = sys.argv[6] if len(sys.argv) > 6 else report_path

    with open(report_path, encoding="utf-8") as f:
        lines = [ln for ln in f.read().split("\n") if not IMAGE_LINE_RE.match(ln.strip())]
    scenes = parse_scenes(lines)
    if not scenes:
        print("no timeline headings found; report unchanged", file=sys.stderr)
        with open(out_report, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        return

    frames = []
    if os.path.exists(tracks_path):
        with open(tracks_path, encoding="utf-8") as f:
            frames = json.load(f).get("frames", [])

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    duration = (cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / fps or 1e9
    os.makedirs(out_dir, exist_ok=True)

    inserts = {}
    for (_, _, _, line_idx), (t0, t1) in zip(scenes, scene_windows(scenes, duration)):
        n = FRAMES_PER_SCENE
        times = [t0 + (t1 - t0) * k / (n - 1) for k in range(n)]
        sheet = build_sheet(cap, pair_box(frames, t0, t1), times)
        if sheet is None:
            continue
        name = f"{t0:06.1f}.jpg"
        cv2.imwrite(os.path.join(out_dir, name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 80])
        inserts[line_idx] = f"![{fmt_time(t0)}〜{fmt_time(t1)}]({url_prefix.rstrip('/')}/{name})"
    cap.release()

    out_lines = []
    for i, line in enumerate(lines):
        out_lines.append(line)
        if i in inserts:
            out_lines.append(inserts[i])
    with open(out_report, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines))
    print(f"done: {len(inserts)}/{len(scenes)} scenes", file=sys.stderr)


if __name__ == "__main__":
    main()
