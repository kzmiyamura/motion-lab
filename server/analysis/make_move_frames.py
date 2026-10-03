#!/usr/bin/env python3
"""
振付シート用に、result.json の routine.moves の技1つにつき数コマ、主ペア（リーダー+フォロワー）を
大きく切り取った写真を作る。

アプリの「振付シート」は 1行 = 1技 で、文章の代わりにこの写真を見せる。スマホでは1コマずつ
横スクロールで大きく見せるので、コマは1枚ずつの画像にする（v2）。
技の区間は [start, 次の技の start]（routine は頭から隙間なく並ぶ前提）。次の技が無い・start が
前後しているときは counts × 拍間隔（routine.bpm → measurements の beatGrid → 既定値の順）で決める。

切り取り（crop_box）: tracks.json の主ペア（leaderPid とその相手。pid 0/1）の bbox を、各コマの前後
LOCAL_SEC 秒で合わせ、余白を足してから縦横比 CROP_ASPECT（2:3 の縦長）に広げる。画面収録の UI
（ステータスバー・Facebook のヘッダー・横のボタン）や後ろの観客が減り、2人がコマいっぱいに写る。
技の区間全体で合わせないのは、カメラが回り込む・寄る動画だと範囲が画面いっぱいになって切り取りが
効かないため。コマの前後でペアが取れないときは技の区間全体 → 動画全体のペアの範囲、tracks が
無ければフレーム全体を使う。はみ出す分（画面の端に寄っていて広げきれない）は黒で埋め、
全コマ同じ縦横比にそろえる。

コマの時刻（key_moments / pick_frames）: 等間隔ではなく、技の中の見どころを取る。0.6 秒おきの等間隔では
回転も「どこで通ったか」も写らない（ユーザー: 「写真から見て何が右ターンをどう2回かわからない」）:
  - 始まりと終わり（女性が画面の左右どちらにいるか）
  - 左右の入れ替わり（tracks.json の主ペアの腰の位置。normalize_routine が CV の CBL と重なるものだけ
    routine.moves[].sides.swapAt に残す）: 通過の瞬間と、抜けた後に2人とも写った最初のコマ
  - 回転（summary.events の Turn の spin.from〜to）: 回転中・回り始め・向き直り
  足りない分は一番広い隙間の真ん中で埋める。各コマに技の頭からの拍（routine.grid.beatSec）と短い説明を付ける
  （「2 男が下がる」「5 通過」「7 右回り中」）。説明は画像に焼かず index.json に入れ、アプリが文字の大きさを決める

書き出し:
  <out_dir>/<NN>_<start>_<k>.jpg  1コマずつ（k = 0 始まり。左上に時刻）
  <out_dir>/<NN>_<start>.jpg      同じコマを横に並べた帯（v1 のフロント向け。キャッシュされた古いアプリ用）
  <out_dir>/index.json            {"version": 2, "complete": bool,
                                   "moves": [{"index", "start", "end", "url",
                                              "frames": [{"t", "url", "count", "label"}]}]}
                                  index は routine.moves の 0 始まりの位置。url は帯。画像が作れなかった技は載せない。
                                  count は技の頭から数えた拍（1〜8）、label はそのコマの説明（空文字もある）
何度実行しても同じ結果になる（out_dir 内の古い jpg は消してから書く）。

Usage: python make_move_frames.py <video_path> <tracks.json> <result.json> <measurements.json> <out_dir> <url_prefix> [--only=2,5]
  url_prefix: index.json に書く画像URLの前置き（例: /analysis-output/<jobId>/out/move_frames）
  --only: その番号（1 始まり）の技だけ作る（確かめ用。index.json にもその技だけ載る）
"""
import glob
import json
import math
import os
import sys
import time

import cv2
import numpy as np

import pair_sides
from make_report_frames import fmt_time, grab

INDEX_VERSION = 2
DEFAULT_BEAT_SEC = 60 / 170   # サルサの標準的なテンポ（routineClip.ts の BASE_BPM と同じ）
MIN_SPAN_SEC = 1.0
MAX_SPAN_SEC = 12.0

CROP_ASPECT = 2 / 3           # 幅 / 高さ。立った2人が収まる縦長
TILE_W, TILE_H = 480, 720     # 1コマの出力サイズ（スマホで幅の半分強に出して 2〜3 倍密度）
STRIP_TILE_H = 360            # 帯（v1 互換）の高さ
JPEG_QUALITY = 80
MARGIN_X = 0.10               # bbox の幅に対する左右の余白
MARGIN_TOP = 0.12             # 頭上に上げた手が bbox からはみ出しやすいので上は広め（高さ比）
MARGIN_BOTTOM = 0.06          # 足元（画面収録の重ね文字で足首が切れることがある）
MIN_PAIR_FRAMES = 3           # 区間内でペアの枠がこれ未満なら動画全体の範囲を使う
LOCAL_SEC = 0.3               # 1コマの切り取りに使う前後の秒数（tracks は約 10fps）
MIN_LOCAL_FRAMES = 2          # コマの前後でペアの枠がこれ未満なら技の区間全体の範囲を使う


def pair_pids(tracks):
    """主ペアの pid（リーダー, フォロワー）。analyze_pair はペアに 0/1 を振り、leaderPid がリーダー"""
    lp = (tracks or {}).get("leaderPid")
    if lp in (0, 1):
        return lp, 1 - lp
    return 0, 1


def pair_bounds(frames, pids, t0=None, t1=None):
    """区間内（t0/t1 が None なら全体）の主ペアの bbox を合わせた範囲（正規化座標）と、使ったフレーム数。
    一瞬だけ誤検出された枠で広がりすぎないよう、端は外れ値を落とした値（5/95 パーセンタイル）"""
    xs1, ys1, xs2, ys2 = [], [], [], []
    n = 0
    for f in frames:
        t = f.get("t")
        if t0 is not None and not (t0 - 0.15 <= t <= t1 + 0.15):
            continue
        hit = False
        for p in f.get("kept", []):
            if p.get("pid") not in pids or not p.get("bbox"):
                continue
            x1, y1, x2, y2 = p["bbox"]
            xs1.append(x1); ys1.append(y1); xs2.append(x2); ys2.append(y2)
            hit = True
        n += hit
    if not xs1:
        return None, 0
    lo = lambda v: float(np.percentile(v, 5))
    hi = lambda v: float(np.percentile(v, 95))
    return (lo(xs1), lo(ys1), hi(xs2), hi(ys2)), n


def expand_to_aspect(box, frame_w, frame_h, aspect=CROP_ASPECT):
    """正規化 bbox に余白を足し、ピクセルで幅/高さ = aspect になるよう短い方を広げる。
    画面からはみ出す分は内側へずらし、それでも収まらなければ画面の端で切る（足りない分は描画時に黒で埋める）。
    返り値はピクセル座標 (x1, y1, x2, y2)"""
    x1, y1, x2, y2 = box
    bw, bh = (x2 - x1) * frame_w, (y2 - y1) * frame_h
    x1 = x1 * frame_w - bw * MARGIN_X
    x2 = x2 * frame_w + bw * MARGIN_X
    y1 = y1 * frame_h - bh * MARGIN_TOP
    y2 = y2 * frame_h + bh * MARGIN_BOTTOM
    w, h = x2 - x1, y2 - y1
    if w / h < aspect:
        w = h * aspect
    else:
        h = w / aspect
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

    def place(c, size, limit):
        size = min(size, limit)
        a = min(max(c - size / 2, 0.0), limit - size)
        return a, a + size

    nx1, nx2 = place(cx, w, frame_w)
    ny1, ny2 = place(cy, h, frame_h)
    return int(round(nx1)), int(round(ny1)), int(round(nx2)), int(round(ny2))


def crop_box(frames, pids, t0, t1, global_box, frame_w, frame_h, t=None):
    """1コマの切り取り範囲（ピクセル）。
    t があればそのコマの前後 LOCAL_SEC のペアの範囲（カメラが回り込む・寄る動画では技の区間全体を
    合わせると画面いっぱいになって切り取りが効かないため）。足りなければ技の区間全体、
    それも足りなければ動画全体の範囲、それも無ければ None（フレーム全体）"""
    box = None
    if t is not None:
        box, n = pair_bounds(frames, pids, t - LOCAL_SEC, t + LOCAL_SEC)
        if n < MIN_LOCAL_FRAMES:
            box = None
    if box is None:
        box, n = pair_bounds(frames, pids, t0, t1)
        if n < MIN_PAIR_FRAMES:
            box = None
    if box is None:
        box = global_box
    if box is None:
        return None
    return expand_to_aspect(box, frame_w, frame_h)


def render_tile(frame, crop, t):
    """1コマ: 切り取って TILE_W x TILE_H に収め（はみ出し分は黒）、左上に時刻を入れる。
    crop が None（ペア不明）ならフレーム全体を縦横比そのまま高さ TILE_H に"""
    if crop is not None and (crop[2] - crop[0] < 10 or crop[3] - crop[1] < 10):
        crop = None
    if crop is not None:
        x1, y1, x2, y2 = crop
        sub = frame[y1:y2, x1:x2]
        sh, sw = sub.shape[:2]
        scale = min(TILE_W / sw, TILE_H / sh)
        nw, nh = max(1, int(round(sw * scale))), max(1, int(round(sh * scale)))
        tile = np.zeros((TILE_H, TILE_W, 3), np.uint8)
        ox, oy = (TILE_W - nw) // 2, (TILE_H - nh) // 2
        tile[oy:oy + nh, ox:ox + nw] = cv2.resize(sub, (nw, nh), interpolation=cv2.INTER_AREA)
    else:
        fh, fw = frame.shape[:2]
        nw = max(1, min(TILE_H * 2, int(round(fw * TILE_H / fh))))
        tile = cv2.resize(frame, (nw, TILE_H), interpolation=cv2.INTER_AREA)
    label = fmt_time(t)
    cv2.rectangle(tile, (0, 0), (16 + 20 * len(label), 44), (0, 0, 0), -1)
    cv2.putText(tile, label, (8, 33), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 235, 255), 2, cv2.LINE_AA)
    return tile


def strip_of(tiles):
    """コマを横に並べた帯（v1 のフロント向け）"""
    gap = np.full((STRIP_TILE_H, 4, 3), 255, np.uint8)
    row = []
    for tile in tiles:
        h, w = tile.shape[:2]
        small = cv2.resize(tile, (max(1, int(round(w * STRIP_TILE_H / h))), STRIP_TILE_H), interpolation=cv2.INTER_AREA)
        row += ([gap] if row else []) + [small]
    return np.hstack(row)


def beat_interval(routine, summary):
    """1拍の秒数。routine.bpm → beatGrid.beatIntervalSec → beatGrid.bpm → 既定値"""
    bpm = (routine or {}).get("bpm")
    if isinstance(bpm, (int, float)) and 40 <= bpm <= 260:
        return 60.0 / bpm
    grid = (summary or {}).get("beatGrid") or {}
    sec = grid.get("beatIntervalSec")
    if isinstance(sec, (int, float)) and 0.15 <= sec <= 1.5:
        return float(sec)
    gbpm = grid.get("bpm")
    if isinstance(gbpm, (int, float)) and 40 <= gbpm <= 260:
        return 60.0 / gbpm
    return DEFAULT_BEAT_SEC


def move_windows(moves, beat_sec, duration=None):
    """各技の (開始秒, 終了秒)。start が無い・動画の外の技は None"""
    out = []
    for k, mv in enumerate(moves):
        t0 = mv.get("start")
        if not isinstance(t0, (int, float)) or t0 < 0 or (duration is not None and t0 >= duration):
            out.append(None)
            continue
        counts = mv.get("counts")
        if not isinstance(counts, (int, float)) or counts <= 0:
            counts = 8
        nxt = None
        for later in moves[k + 1:]:
            s = later.get("start")
            if isinstance(s, (int, float)) and s > t0 and (duration is None or s < duration):
                nxt = s
                break
        t1 = nxt if nxt is not None else t0 + counts * beat_sec
        t1 = min(max(t1, t0 + MIN_SPAN_SEC), t0 + MAX_SPAN_SEC)
        if duration is not None:
            t1 = min(t1, duration)
        out.append((float(t0), float(t1)))
    return out


def frame_times(t0, t1, counts):
    """技の区間から取るコマの時刻（等間隔）。8カウントまでは5コマ、それより長い技は6コマ。
    最後のコマは次の技の頭と重ならないよう少し手前にする"""
    n = frame_count(counts)
    end = max(t0, t1 - 0.05)
    return [t0 + (end - t0) * k / (n - 1) for k in range(n)]


def frame_count(counts):
    return 5 if (counts or 8) <= 8 else 6


SIDE_JA = {"left": "左", "right": "右"}
DIR_JA = {"right": "右回り", "left": "左回り"}
MIN_KEY_GAP = 0.25      # 秒。選んだコマどうしがこれより近ければ後の方は取らない
AFTER_PASS_SEC = 0.5    # 通過の後、新しい側で2人とも写った最初のコマをこの秒数以降から探す
TURN_MIN_OVERLAP = 0.3  # 回転の区間が技の区間とこれ以上重なれば、その技の回転として扱う

# 間を埋めるコマの説明（On2 = Eddie Torres の数え方。docs/salsa-knowledge/on2-timing-and-terms.md §2.2）
# ベーシックは 2 で男が下がり 6 で前へ。CBL 系は男が 7〜1 で開き切る（女が 2 で横を通り 5 で着地する）
FILL_LABEL = {2: "男が下がる", 6: "男が前へ"}
CBL_FILL_LABEL = {1: "男が開く", 6: "男が前へ"}   # 通過・着地は見えたコマ（key_moments）にだけ書く
CBL_MOVES = {"cbl", "cbl_inside_turn", "cbl_outside_turn", "reverse_cbl"}


def count_of(t, t0, beat, counts):
    """技の頭（カウント1）からの t の拍（1〜counts、最寄りの拍）"""
    if not beat:
        return None
    k = int(math.floor((t - t0) / beat + 0.5))
    k = min(max(k, 0), max(1, int(counts or 8)) - 1)
    return k % 8 + 1


def key_moments(mv, t0, t1, series, crosses, events):
    """技の区間の中の見どころの時刻 [(t, label, 優先度)]（優先度は小さいほど先に取る）。
    - 始まり・終わり（女性が画面の左右どちらにいるか付き）
    - 左右の入れ替わり: 通過の瞬間（隠れていた区間の中点）と、抜けた後に2人とも写った最初のコマ
    - 回転: 回り始め・回転中・向き直り（analyze_pair が全フレームで数えた spin.from〜to）"""
    end = max(t0, t1 - 0.05)
    sides = mv.get("sides") or {}
    out = []
    s0, s1 = SIDE_JA.get(sides.get("followerStart")), SIDE_JA.get(sides.get("followerEnd"))
    out.append((t0, f"スタート（女は{s0}）" if s0 else "スタート", 0))
    swap_at = sides.get("swapAt") or []
    for c in crosses:
        if not (t0 <= c["t"] < t1):
            continue
        # normalize_routine が CV の入れ替わりと重なるものだけ swapAt に残している（密着中の腰の重なりは除く）
        if "sides" in mv and not any(abs(c["t"] - s) <= 0.05 for s in swap_at):
            continue
        out.append((c["t"], "通過", 1))
        after = next((t for t, s in series if t >= c["t"] + AFTER_PASS_SEC and s == c["to"]), None)
        if after is not None and after < end:
            out.append((after, f"女が{SIDE_JA[c['to']]}へ抜けた", 4))
    turn = mv.get("turn") if isinstance(mv.get("turn"), dict) else {}
    who = "leader" if mv.get("move") == "leader_turn" or turn.get("by") == "leader" else "follower"
    d = DIR_JA.get(turn.get("direction"))
    for e in events:
        if e.get("type") != "Turn" or e.get("by") != who:
            continue
        sp = e.get("spin") or {}
        a, b = sp.get("from"), sp.get("to")
        if not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
            a = b = e.get("t")
        if not isinstance(a, (int, float)):
            continue
        lo, hi = max(a, t0), min(b, end)
        if hi - lo < TURN_MIN_OVERLAP and not (t0 <= e.get("t", -1) < t1):
            continue
        # 向きは技の欄の向き。CV の数えた向きが混ざる（左に回ってから右に回り直した等）区間では書かない
        dirs = {r.get("dir") for r in sp.get("runs") or []}
        spinning = f"{d}中" if d and dirs <= {turn.get("direction")} else "回転中"
        if hi - lo >= 0.2:
            out.append(((lo + hi) / 2, spinning, 2))
            out.append((lo, "回り始め" if a >= t0 else spinning, 5))
            out.append((hi, "向き直り" if b <= end else spinning, 6))
        else:
            out.append((max(t0, min(e["t"], end)), spinning, 2))
    s1_label = f"終わり（女は{s1}）" if s1 else "終わり"
    out.append((end, s1_label, 3))
    return out


def pick_frames(cands, t0, t1, n):
    """優先度の順に MIN_KEY_GAP 以上離れたものを n 個まで取り、足りなければ一番広い隙間の真ん中で埋める。
    戻り値 [(t, label|None)]（時刻順。label None は埋めたコマ）"""
    chosen = []
    for t, label, _ in sorted(cands, key=lambda c: (c[2], c[0])):
        if len(chosen) >= n:
            break
        if all(abs(t - c[0]) >= MIN_KEY_GAP for c in chosen):
            chosen.append((t, label))
    end = max(t0, t1 - 0.05)
    while len(chosen) < n:
        pts = sorted([t0, end] + [c[0] for c in chosen])
        gaps = [(b - a, a, b) for a, b in zip(pts, pts[1:])]
        w, a, b = max(gaps)
        if w < 2 * 0.05:
            break
        chosen.append(((a + b) / 2, None))
    return sorted(chosen)


def labeled_frames(mv, t0, t1, beat, series, crosses, events):
    """1つの技のコマ [(t, count, label)]。見どころのコマに説明を付け、間を埋めたコマは拍の説明（On2）"""
    counts = mv.get("counts") or 8
    picks = pick_frames(key_moments(mv, t0, t1, series, crosses, events), t0, t1, frame_count(counts))
    out = []
    for t, label in picks:
        c = count_of(t, t0, beat, counts)
        if label is None:
            label = (CBL_FILL_LABEL if mv.get("move") in CBL_MOVES else FILL_LABEL).get(c, "")
        out.append((t, c, label))
    return out


def write_index(out_dir, entries, done):
    """index.json を原子的に書く（読み手が書きかけの JSON を掴まない）。
    done=False は作成中の印で、フロントは揃うまで読み直す"""
    path = os.path.join(out_dir, "index.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": INDEX_VERSION, "complete": done, "moves": entries}, f, ensure_ascii=False, indent=1)
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            # Windows: サーバーが配信中で開いていると置き換えられない。少し待ってやり直す
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def main():
    if len(sys.argv) < 7:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    video_path, tracks_path, result_path, meas_path, out_dir, url_prefix = sys.argv[1:7]
    # --only=2,5: その番号（1 始まり）の技だけ作る（確かめ用）
    only = None
    for a in sys.argv[7:]:
        if a.startswith("--only="):
            only = {int(x) for x in a[len("--only="):].split(",") if x.strip().isdigit()}

    with open(result_path, encoding="utf-8") as f:
        routine = (json.load(f) or {}).get("routine") or {}
    moves = routine.get("moves") or []
    if not moves:
        print("no routine.moves; nothing to do", file=sys.stderr)
        return

    summary = {}
    if os.path.exists(meas_path):
        with open(meas_path, encoding="utf-8") as f:
            summary = (json.load(f) or {}).get("summary") or {}
    tracks = {}
    if os.path.exists(tracks_path):
        with open(tracks_path, encoding="utf-8") as f:
            tracks = json.load(f) or {}
    frames = tracks.get("frames", [])
    pids = pair_pids(tracks)
    global_box, _ = pair_bounds(frames, pids)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    duration = (cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / fps or None

    os.makedirs(out_dir, exist_ok=True)
    # 古い画像を消す前に index を空にしておく（消えた画像を指す index が残らないように）
    write_index(out_dir, [], done=False)
    for old in glob.glob(os.path.join(out_dir, "*.jpg")):
        os.remove(old)

    # 見どころ（左右の入れ替わり・回転）を選ぶ材料: 主ペアの立ち位置の時系列と CV の技イベント
    series = pair_sides.follower_series(tracks)
    crosses = pair_sides.crossings(pair_sides.settled_runs(series))
    events = [e for e in (summary.get("events") or []) if isinstance(e, dict)]
    grid_beat = ((routine.get("grid") or {}).get("beatSec"))
    beat = grid_beat if isinstance(grid_beat, (int, float)) and grid_beat > 0 else beat_interval(routine, summary)

    entries = []
    windows = move_windows(moves, beat_interval(routine, summary), duration)
    for i, (mv, win) in enumerate(zip(moves, windows)):
        if win is None or (only is not None and i + 1 not in only):
            continue
        t0, t1 = win
        stem = f"{i + 1:02d}_{t0:05.1f}"
        tiles, shots = [], []
        for t, count, label in labeled_frames(mv, t0, t1, beat, series, crosses, events):
            frame = grab(cap, t)
            if frame is None:
                continue
            # メタデータの寸法は当てにならないことがあるので実フレームの寸法で決める
            fh, fw = frame.shape[:2]
            crop = crop_box(frames, pids, t0, t1, global_box, fw, fh, t)
            tile = render_tile(frame, crop, t)
            name = f"{stem}_{len(tiles)}.jpg"
            cv2.imwrite(os.path.join(out_dir, name), tile, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            tiles.append(tile)
            shot = {"t": round(t, 2), "url": f"{url_prefix.rstrip('/')}/{name}", "label": label}
            if count is not None:
                shot["count"] = count
            shots.append(shot)
        if not tiles:
            continue
        cv2.imwrite(os.path.join(out_dir, f"{stem}.jpg"), strip_of(tiles), [cv2.IMWRITE_JPEG_QUALITY, 78])
        entries.append({
            "index": i, "start": round(t0, 2), "end": round(t1, 2),
            "url": f"{url_prefix.rstrip('/')}/{stem}.jpg",
            "frames": shots,
        })
        # 1枚できるたびに index.json を書き直す（作っている途中にレポートを開いても、できた分の写真は出る）
        write_index(out_dir, entries, done=False)
    cap.release()

    write_index(out_dir, entries, done=True)
    print(f"done: {len(entries)}/{len(moves)} moves", file=sys.stderr)


if __name__ == "__main__":
    main()
