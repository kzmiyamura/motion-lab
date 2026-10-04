#!/usr/bin/env python3
"""
ターンの向き・回転数を Claude に画像で判定させる（turn judge）ための下ごしらえと書き戻し。

CV（肩の左右の並び＋顔の向き）は「右回りを左回りと読む」誤りが片寄って出る（正解表で向きの誤り 6 件が全てこの向き。
27fps・角度の unwrap・顔の見え方で決める版でも直らなかった。docs/salsa-knowledge/README.md 反映済み 8）。
人が 0.1 秒刻みのコマを見れば迷わず読めるので、写真で分かる判断は Claude に聞く（server/CLAUDE.md その9 の方針）。

  strips: 女性・男性のターン（と、手を上げた CBL でターンの検出が無いもの）ごとに、回る人の上半身を追って切り出した
          0.08〜0.1 秒刻み 10〜16 コマの一覧画像（JPEG 1 枚）を書き、events.json（Claude に渡す一覧）を書く
  merge:  Claude の答え（judge.json）を measurements.json の summary.events に書き戻す。
          自信が medium 以上なら向き・回転数を Claude の値にし（spin.runs も書き換えるので normalize_routine と
          裁定役（runner）がそのまま使う）、CV の値は dirCV / rotationsCV / spin.runsCV に残す。
          low・答え無しは CV のまま dirSource: "cv?"（「?」付き）

Usage:
  python turn_judge.py strips <video> <tracks.json> <measurements.json> <out_dir>
  python turn_judge.py merge <measurements.json> <out_dir>/events.json <judge.json> [--out=<measurements.json>]
"""
import json
import math
import os
import re
import sys

STEP_SEC = 0.1              # コマの間隔
MIN_FRAMES = 10             # これより少ししか読めなかった（動画の端）場面は聞かない（実際は半分まで許す）
MAX_FRAMES = 16             # 1 場面のコマ数（1.5 秒）
DEFAULT_PRE_SEC = 0.6       # 区間の既定: 検出時刻のこの秒数前から
CLUSTER_SEC = 0.6           # 反転の塊（回っている最中）を探す幅
CLUSTER_MIN = 3             # 塊とみなす反転の数
FLIP_MARGIN = 0.015         # analyze_pair.TURN_FLIP_MARGIN と同じ（真横付近の揺れは数えない）
CBL_TURN_NEAR_SEC = 1.2     # CBL の前後この秒数に女性のターンが検出されていれば CBL は別に聞かない
MAX_EVENTS = 24             # 1 回の呼び出しで聞くイベントの上限（画像の合計を 1〜2 MB に抑える）
TILE_W = 190                # 1 コマの幅（px）。高さは上半身の切り出しの比率で決まる
TILE_W_MANY = 160           # イベントが多いとき（> 16 件）は小さくする
JPEG_QUALITY = 64
CROP_MARGIN = 0.06          # bbox 幅に対する左右の余白
CROP_TOP = 0.16             # 頭上の手が入るよう上は広め（bbox 高さ比）
UPPER_BODY = 0.50           # bbox の上から何割を上半身として切るか
LABEL_H = 22

# analyze_pair.py の色（BGR）と同じ: リーダー青 #0066ff / フォロワーピンク #ff00cc
COLOR = {"leader": (255, 102, 0), "follower": (204, 0, 255)}
CONF_RANK = {"low": 0, "medium": 1, "high": 2}
MIN_CONF = "medium"


# ---------------------------------------------------------------- 区間とイベントの選び方（cv2 不要。テスト対象）

def _person(df, pid):
    for p in df.get("kept") or []:
        if p.get("pid") == pid:
            return p
    return None


def flip_times(frames, pid, t_from, t_to):
    """pid の肩の左右の並び（shDx）の符号が変わった時刻（真横付近は数えない）"""
    series = [(df["t"], p["shDx"]) for df in frames if t_from <= df["t"] <= t_to
              for p in [_person(df, pid)] if p and abs(p.get("shDx", 0)) >= FLIP_MARGIN]
    return [t1 for (t0, d0), (t1, d1) in zip(series, series[1:]) if (d0 > 0) != (d1 > 0)]


def densest_cluster(flips, span=CLUSTER_SEC):
    """span 秒以内に入る反転の最多の塊: (個数, 中心時刻)。無ければ (0, None)"""
    best = (0, None)
    for i, a in enumerate(flips):
        inside = [x for x in flips[i:] if x - a <= span]
        if len(inside) > best[0]:
            best = (len(inside), (inside[0] + inside[-1]) / 2)
    return best


def turn_window(frames, pid, t, spin=None, kind="turn"):
    """ストリップの区間 (from, to, step, コマ数)。MAX_FRAMES コマ（1.5 秒）。
    10fps の検出時刻 t は回り始めの最初の反転で、正解の回転の区間（0.6〜0.8 秒）は t の 1.2 秒前〜1.3 秒後に散らばる
    （正解表 bb0efcb9）。だから既定は t−0.6〜t+0.9 とし、反転が CLUSTER_MIN 個以上かたまる所（回っている最中）が
    その中心部から外れていれば、そこを中心に取り直す。全フレームで数え直した spin.from/to があればその中央を中心にする。
    CBL は入れ替わりの時刻 t−0.6 から（反転を追うと次のターンの区間と同じ画像になる）"""
    span = (MAX_FRAMES - 1) * STEP_SEC
    lo = t - DEFAULT_PRE_SEC
    if kind != "cbl":
        center = None
        if spin and isinstance(spin.get("from"), (int, float)) and isinstance(spin.get("to"), (int, float)):
            a, b = spin["from"], spin["to"]
            center = (a + b) / 2 if b - a <= span - 0.4 else a + span / 2 - 0.3
        else:
            n, c = densest_cluster(flip_times(frames, pid, t - 0.6, t + 1.6))
            if n >= CLUSTER_MIN and not (lo + 0.4 <= c <= lo + span - 0.4):
                center = c
        if center is not None:
            lo = center - span / 2
    lo = max(0.0, lo)
    return round(lo, 2), round(lo + span, 2), STEP_SEC, MAX_FRAMES


def select_events(events, leader_pid):
    """聞くイベント: ターン全部（回る人が分かるもの）と、手を上げた CBL で近くに女性のターンの検出が無いもの。
    戻り値: [(index in events, kind, turner_role, turner_pid)]"""
    if leader_pid is None:
        return []
    follower_pid = 1 - leader_pid
    f_turns = [e["t"] for e in events if e.get("type") == "Turn" and e.get("by") == "follower"]
    out = []
    for i, e in enumerate(events):
        if e.get("type") == "Turn" and e.get("by") in ("leader", "follower"):
            out.append((i, "turn", e["by"], leader_pid if e["by"] == "leader" else follower_pid))
        elif (e.get("type") == "CBL" and (e.get("handRaise") or {}).get("raised")
              and not any(abs(e["t"] - ft) <= CBL_TURN_NEAR_SEC for ft in f_turns)):
            out.append((i, "cbl", "follower", follower_pid))
    if len(out) > MAX_EVENTS:
        turns = [x for x in out if x[1] == "turn"]
        cbls = [x for x in out if x[1] == "cbl"]
        keep = turns[:MAX_EVENTS] if len(turns) >= MAX_EVENTS else turns + sample_evenly(cbls, MAX_EVENTS - len(turns))
        if len(turns) > MAX_EVENTS:
            keep = sample_evenly(turns, MAX_EVENTS)
        out = sorted(keep, key=lambda x: x[0])
    return out


def sample_evenly(items, n):
    if n <= 0:
        return []
    if len(items) <= n:
        return list(items)
    if n == 1:
        return [items[0]]
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]


def bbox_at(frames, pid, t, max_gap=0.35):
    """時刻 t に最も近い tracks のコマでの pid の bbox（正規化）。max_gap 秒以内に無ければ None"""
    best, bd = None, max_gap
    for df in frames:
        d = abs(df["t"] - t)
        if d <= bd:
            p = _person(df, pid)
            if p and p.get("bbox"):
                best, bd = p, d
    return best


# ---------------------------------------------------------------- Claude の答えの読み方・書き戻し（cv2 不要。テスト対象）

# 1 コマずつの向きの記号: F 正面（カメラを向く）/ B 背中 / L 鼻が画面左を向く横顔 / R 鼻が画面右を向く横顔
# 本人の右回り（上から見て時計回り）は F→L→B→R→F、左回りは F→R→B→L→F（カメラが向かい合っているので
# 「本人の右」は画面の左。analyze_pair.spin_hint の「正面→背中を画面右向きで通過 = 左回り」と同じ決まり）
NEXT_RIGHT = {"F": "L", "L": "B", "B": "R", "R": "F"}
NEXT_LEFT = {v: k for k, v in NEXT_RIGHT.items()}


def parse_facing(seq):
    """"F L B R F" / "F>L>B>R>F" / "FLBRF" → ["F","L","B","R","F"]（?・空白・矢印は捨て、続く同じ記号は 1 つに）"""
    toks = [c for c in re.sub(r"[^FBLR?]", "", (seq or "").upper())]
    out = []
    for c in toks:
        if c == "?":
            out.append(c)
        elif not out or out[-1] != c:
            out.append(c)
    return out


def direction_from_facing(seq):
    """向きの記号列から (direction, quarter_steps)。隣り合う 2 つが 90° ずつ進んだ数を右・左で数え、
    多い方の向きを返す（同数・読めなければ None）。180° 飛び（F→B 等）は向きが決まらないので数えない"""
    toks = [c for c in parse_facing(seq) if c != "?"]
    r = l = 0
    for a, b in zip(toks, toks[1:]):
        if NEXT_RIGHT.get(a) == b:
            r += 1
        elif NEXT_LEFT.get(a) == b:
            l += 1
    if r == l:
        return None, 0
    return ("right", r) if r > l else ("left", l)


def round_half(x):
    return max(0.5, round(float(x) * 2) / 2)


def _cv_runs(spin):
    """CV の向きの連続。10fps の spin_hint は seq だけなので analyze_pair._spin_runs でまとめる"""
    spin = spin or {}
    if spin.get("runs") is not None:
        return spin["runs"]
    if not spin.get("seq"):
        return None
    from analyze_pair import _spin_runs  # ultralytics を読み込むので要るときだけ
    return _spin_runs(spin["seq"])


def _main_dir(e):
    runs = _cv_runs(e.get("spin")) or []
    known = [r for r in runs if r.get("dir") in ("left", "right")]
    if known:
        return max(known, key=lambda r: r.get("turns") or 0)["dir"]
    return None


def merge(meas, listing, judge):
    """judge = {"events": [{id, turner, direction, rotations, confidence, facing?, notes?}]}。
    measurements の summary.events を直に書き換え、集計 {claude, cvUnsure, missing, seqConflict} を返す"""
    events = meas["summary"]["events"]
    answers = {str(a.get("id")): a for a in (judge or {}).get("events") or [] if isinstance(a, dict)}
    tally = {"asked": len(listing), "claude": 0, "cvUnsure": 0, "missing": 0, "seqConflict": 0, "changedDir": 0}
    for item in listing:
        e = events[item["index"]]
        a = answers.get(item["id"])
        cv_dir = _main_dir(e)
        e.setdefault("dirCV", cv_dir)
        if a is None:
            tally["missing"] += 1
            if e.get("type") == "Turn":
                e["dirSource"] = "cv?"
            continue
        d = a.get("direction") if a.get("direction") in ("left", "right") else None
        conf = a.get("confidence") if a.get("confidence") in CONF_RANK else "low"
        seq_dir, _ = direction_from_facing(a.get("facing"))
        # 書いた向きの並びと答えの向きが食い違うなら、どちらかを読み違えている → 自信を low に落とす
        if d and seq_dir and seq_dir != d:
            conf = "low"
            tally["seqConflict"] += 1
        rot = a.get("rotations")
        rot = round_half(rot) if isinstance(rot, (int, float)) and rot > 0 else None
        e["turnJudge"] = {
            "direction": d, "rotations": rot, "turner": a.get("turner"), "confidence": conf,
            "facing": a.get("facing"), "notes": (a.get("notes") or "")[:200], "kind": item["kind"],
        }
        if e.get("type") != "Turn":
            continue    # CBL の判定は記録だけ（CBL の向きは CV に無い）
        if d and CONF_RANK[conf] >= CONF_RANK[MIN_CONF] and a.get("turner") in (e.get("by"), "both"):
            sp = e.get("spin") or {"seq": "", "netDeg": None}
            if "runsCV" not in sp:
                sp["runsCV"] = _cv_runs(sp)
            turns = rot or (sum(r.get("turns") or 0 for r in sp.get("runsCV") or []) or None) or 1.0
            sp["runs"] = [{"dir": d, "turns": turns}]
            sp["runsSource"] = "claude"
            e["spin"] = sp
            e.setdefault("rotationsCV", e.get("rotations"))
            if rot:
                e["rotations"] = rot
            e["dirSource"] = "claude"
            tally["claude"] += 1
            tally["changedDir"] += int(cv_dir is not None and cv_dir != d)
        else:
            e["dirSource"] = "cv?"
            tally["cvUnsure"] += 1
    meas["summary"]["turnJudge"] = tally
    return tally


# ---------------------------------------------------------------- 画像（cv2 を使う）

def _crop_box(frames, pid, lo, hi, w, h):
    """区間内の pid の bbox の大きさの中央値（腕を広げたコマで広がりすぎないよう最大は使わない）から、
    上半身を切り出す固定サイズ（px）を返す"""
    ws, hs = [], []
    for df in frames:
        if lo - 0.2 <= df["t"] <= hi + 0.2:
            p = _person(df, pid)
            if p and p.get("bbox"):
                x0, y0, x1, y1 = p["bbox"]
                ws.append((x1 - x0) * w)
                hs.append((y1 - y0) * h)
    if not ws:
        return None
    bw, bh = sorted(ws)[len(ws) // 2], sorted(hs)[len(hs) // 2]
    ch = bh * (UPPER_BODY + CROP_TOP)
    cw = max(bw * (1 + 2 * CROP_MARGIN), ch * 0.7)
    return cw, ch


def _read_frames(cap, fps, times):
    import cv2
    from frame_time import seek_read
    # POS_MSEC のシークは可変フレームレートで最大 0.3 秒遅れて着くので、手前に着いたことを確かめてから読む（README 27）
    frame, cur = seek_read(cap, times[0] - 0.05)
    out, k = [], 0
    while frame is not None and k < len(times):
        while k < len(times) and cur >= times[k] - 0.5 / fps:
            out.append(frame)
            k += 1
        ret, frame = cap.read()
        if not ret:
            break
        cur = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
    return out


def build_grid(frames, times, centers, size, role, partner_pts, tile_w):
    """1 コマずつ回る人の上半身を同じ大きさで切り出し、時刻・役割の色の枠と相手の印を描いて 4 列に並べる"""
    import cv2
    import numpy as np
    cw, ch = size
    tile_h = int(round(tile_w * ch / cw))
    cols = 4
    rows = math.ceil(len(frames) / cols)
    sheet = np.full((rows * tile_h, cols * tile_w, 3), 255, np.uint8)
    color = COLOR[role]
    other = COLOR["leader" if role == "follower" else "follower"]
    for i, (f, t, c, pp) in enumerate(zip(frames, times, centers, partner_pts)):
        H, W = f.shape[:2]
        cx, top = c
        x0 = int(round(cx - cw / 2))
        y0 = int(round(top))
        pad = int(max(cw, ch))
        big = cv2.copyMakeBorder(f, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(40, 40, 40))
        crop = big[y0 + pad:y0 + pad + int(ch), x0 + pad:x0 + pad + int(cw)]
        tile = cv2.resize(crop, (tile_w, tile_h))
        if pp is not None:   # 相手の頭（鼻か bbox 上端）がこのコマに入っていれば、顔を隠さないよう少し上に相手の色の小さな点
            px = (pp[0] - x0) * tile_w / cw
            py = (pp[1] - y0) * tile_h / ch - 0.09 * tile_h
            if 0 <= px < tile_w and 0 <= py < tile_h:
                py = max(LABEL_H + 6, py)
                cv2.circle(tile, (int(px), int(py)), 5, other, -1)
                cv2.circle(tile, (int(px), int(py)), 5, (255, 255, 255), 1)
        cv2.rectangle(tile, (0, 0), (tile_w - 1, tile_h - 1), color, 3)
        cv2.rectangle(tile, (0, 0), (62, LABEL_H), (0, 0, 0), -1)
        cv2.putText(tile, f"{t:.2f}", (4, LABEL_H - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 235, 255), 1, cv2.LINE_AA)
        r, cc = divmod(i, cols)
        sheet[r * tile_h:(r + 1) * tile_h, cc * tile_w:(cc + 1) * tile_w] = tile
    return sheet


def make_strips(video_path, tracks, meas, out_dir):
    import cv2
    frames = tracks["frames"]
    leader_pid = tracks.get("leaderPid")
    events = meas["summary"].get("events") or []
    picked = select_events(events, leader_pid)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if f.endswith(".jpg"):
            os.remove(os.path.join(out_dir, f))
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise SystemExit(f"failed to open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    tile_w = TILE_W if len(picked) <= 16 else TILE_W_MANY
    listing, total_bytes = [], 0
    for n, (idx, kind, role, pid) in enumerate(picked, start=1):
        e = events[idx]
        lo, hi, step, count = turn_window(frames, pid, e["t"], e.get("spin"), kind)
        times = [round(lo + k * step, 2) for k in range(count)]
        size = _crop_box(frames, pid, lo, hi, W, H)
        if size is None:
            continue
        centers, partner_pts = [], []
        last = None
        for t in times:
            p = bbox_at(frames, pid, t)
            if p:
                x0, y0, x1, y1 = p["bbox"]
                last = ((x0 + x1) / 2 * W, y0 * H - (y1 - y0) * H * CROP_TOP)
            centers.append(last)
            q = bbox_at(frames, 1 - pid, t, 0.15)
            pt = None
            if q:
                k = q.get("kps")
                if k and k[0][2] >= 0.3:
                    pt = (k[0][0] * W, k[0][1] * H)
                else:
                    bx0, by0, bx1, by1 = q["bbox"]
                    pt = ((bx0 + bx1) / 2 * W, (by0 + (by1 - by0) * 0.08) * H)
            partner_pts.append(pt)
        # 先頭で追跡が無いコマは最初に見えた位置で埋める
        first = next((c for c in centers if c is not None), None)
        if first is None:
            continue
        centers = [c if c is not None else first for c in centers]
        imgs = _read_frames(cap, fps, times)
        if len(imgs) < MIN_FRAMES // 2:
            continue
        times, centers, partner_pts = times[:len(imgs)], centers[:len(imgs)], partner_pts[:len(imgs)]
        sheet = build_grid(imgs, times, centers, size, role, partner_pts, tile_w)
        eid = f"e{n:02d}"
        name = f"{eid}_{e['t']:06.2f}_{kind}_{role}.jpg"
        path = os.path.join(out_dir, name)
        cv2.imwrite(path, sheet, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        total_bytes += os.path.getsize(path)
        listing.append({
            "id": eid, "index": idx, "file": name, "t": e["t"], "kind": kind, "cvTurner": role,
            "from": times[0], "to": times[-1], "step": step, "frames": len(times),
            "cvRotations": e.get("rotations"),
        })
    cap.release()
    with open(os.path.join(out_dir, "events.json"), "w", encoding="utf-8") as f:
        json.dump({"events": listing, "totalBytes": total_bytes}, f, ensure_ascii=False, indent=1)
    return listing, total_bytes


def main(argv):
    if len(argv) >= 6 and argv[1] == "strips":
        video, tracks_p, meas_p, out_dir = argv[2:6]
        tracks = json.load(open(tracks_p, encoding="utf-8"))
        meas = json.load(open(meas_p, encoding="utf-8"))
        listing, total = make_strips(video, tracks, meas, out_dir)
        print(f"turn judge strips: {len(listing)} events, {total / 1e6:.2f} MB", file=sys.stderr)
        print(json.dumps({"events": len(listing), "bytes": total}))
        return 0
    if len(argv) >= 5 and argv[1] == "merge":
        meas_p, listing_p, judge_p = argv[2:5]
        out_p = next((a.split("=", 1)[1] for a in argv[5:] if a.startswith("--out=")), meas_p)
        meas = json.load(open(meas_p, encoding="utf-8"))
        listing = json.load(open(listing_p, encoding="utf-8"))["events"]
        judge = json.load(open(judge_p, encoding="utf-8"))
        tally = merge(meas, listing, judge)
        with open(out_p, "w", encoding="utf-8") as f:
            json.dump(meas, f, ensure_ascii=False)
        print(f"turn judge merge: {json.dumps(tally)}", file=sys.stderr)
        return 0
    print(__doc__, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
