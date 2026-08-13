#!/usr/bin/env python3
"""
復元3D → Web(three.js) が読むモーションクリップ。

必要な19関節（基本13 + 耳2 + かかと/つま先4）に絞り、
ステージ座標（床 y=0・ペアの中心が原点）へ正規化して出す。
Web 側で余計な計算をさせないため、正規化はここで済ませる。

出力スキーマ:
{
  "fps": 10.5, "leaderPid": 0, "duration": 31.4,
  "joints": ["nose","lShoulder",...],          # 19個の名前（順序が j の並び）
  "events": [...],                              # 技イベント（技名ラベル用にそのまま同梱）
  "frames": [
    {"t": 0.0, "p": {"0": {"r":[x,y,z], "j":[x,y,z, x,y,z, ...57個], "v":[...19]}, "1": {...}}}
  ]
}
v = 各関節の信頼度（1=観測, 0.5=時間補間で埋めた推定, 0=無し）

Usage:
  python prototype_export_clip.py <lifted.json> <out.json> [--decimals 3]
      [--measurements measurements.json]   # beatGrid をクリップに同梱（ハイブリッドモードの拍同期用）
"""
import sys
import json
import math
import argparse

import numpy as np

# MediaPipe 33点のうち Web のリグで使う19点。
# 既存13点の並びは変えず末尾に追加する（Web 側の関節インデックス互換のため）。
# 追加6点: 耳（頭のヨー = スポッティング表現）と かかと・つま先（足の向き = サルサの足元表現）
PICK = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28,
        7, 8, 29, 30, 31, 32]
NAMES = ["nose", "lShoulder", "rShoulder", "lElbow", "rElbow", "lWrist", "rWrist",
         "lHip", "rHip", "lKnee", "rKnee", "lAnkle", "rAnkle",
         "lEar", "rEar", "lHeel", "rHeel", "lToe", "rToe"]


HOLD_WINDOW_SEC = 0.35   # イベント時刻の前後この範囲を見る
HOLD_2D_MAX = 0.22       # 画面上でこれ（身長比）より離れた組は握っていない ≒ 腕1本分
HOLD_2D_CONF = 0.40      # YOLO キーポイント信頼度の下限
BACK_HAND_M = 0.35       # 相手の胴中心にこれより近い手は「背中に回した手」とみなす（3D）

COCO_WRIST = {"lWrist": 9, "rWrist": 10}


def recompute_holds(out_frames, events, leader_pid, idx, tracks, aspect=1.0):
    """イベントごとの「つないでいる手」を決め直す。

    ■ 何を直すか
    analyze_pair.py の hold は **画像上の最近接**で決めている（COCO 17点に z が無いため）。
    実測（2fda2815 t=3.40）では、クローズドポジションで**背中に回したリーダーの右手**が
    相手の手首と画面上で重なって勝ち、本当に握っている組が4通り中いちばん遠い扱いになっていた。

    ■ ただし「3Dで選び直す」は誤り（14セッション目に実測して却下）
    腕の3D推定誤差は median 26.5cm・p95 65cm あり、4通りの3D距離の大小はほぼノイズ。
    3本の動画で測ると、3Dで選び直した組は画面上で **中央値 1.2〜1.6 肩幅** 離れており
    （最大 9 肩幅）、元の2D判定に画像近さで 5:14 で負けていた。**画像は真実・奥行きだけが推定**。

    ■ 採る方式: 画像で絞り、3Dは「背中の手」と「根拠の無い手」を落とすためだけに使う
    1. 4通りを画像距離（肩幅で正規化）で評価し、HOLD_2D_MAX を超える組は捨てる
    2. 補間で埋めた手首（v<1）は候補にしない。実観測だけで何も残らないときのみ補間も許す
    3. 相手の胴中心に 3D で近すぎる手（＝背中に回した手）を落とす。全部落ちるときは落とさない
    4. 残りの最小を採る。何も残らなければ **その瞬間は手をつないでいない**（hold=None）。
       開いて踊る区間でも無理に4通りから選ばせていたのが、そもそもの誤りの温床だった

    真値のある 2fda2815 t=3.40（クローズド）で確認: 画像で絞ると L手×F右手(0.36sw) と
    L手×F左手(0.35sw) が並ぶが、F左手は補間値なので 2 で落ち、正解の L手×F右手 が残る。
    背中に回ったリーダー右手は画像距離 1.13sw で 1 の時点で落ちている。
    """
    if not tracks:
        return 0, 0
    fpid = 1 - leader_pid

    def dist2d(p, q):
        # キーポイントは軸ごとに 0..1 正規化されている。縦長動画では x と y の1目盛りの
        # 長さが違うので、x をアスペクト比で画素比に戻してから測る
        return math.hypot((p[0] - q[0]) * aspect, p[1] - q[1])

    W = ("lWrist", "rWrist")
    T = ("lShoulder", "rShoulder", "lHip", "rHip")
    tframes = tracks.get("frames") or []

    def pos3(p, name):
        i = idx[name] * 3
        return np.array(p["j"][i:i + 3])

    def torso3(p):
        return np.mean([pos3(p, n) for n in T], axis=0)

    n_changed = n_cleared = 0
    for ev in events:
        scores = {}   # (lk, fk) -> そのイベント窓での画像距離たち
        for tf in tframes:
            if abs(tf["t"] - ev["t"]) > HOLD_WINDOW_SEC:
                continue
            kept = {p.get("pid"): p for p in tf.get("kept", []) if p.get("kps")}
            if leader_pid not in kept or fpid not in kept:
                continue
            ka, kb = kept[leader_pid]["kps"], kept[fpid]["kps"]
            # 尺度は身長（bbox の高さ）。肩幅は横を向いた瞬間に潰れるので使えない
            # ── 潰れた肩幅で割ると、本当に握っている組まで「遠い」と判定されてしまう
            bb = [kept[leader_pid].get("bbox"), kept[fpid].get("bbox")]
            if not all(bb):
                continue
            hgt = sum(b[3] - b[1] for b in bb) / 2
            if hgt < 1e-6:
                continue
            # 同時刻の3D（背中の手を落とすためだけに使う）
            f3 = min(out_frames, key=lambda f: abs(f["t"] - tf["t"])) if out_frames else None
            a3 = b3 = None
            if f3 is not None and abs(f3["t"] - tf["t"]) <= 0.1:
                a3, b3 = f3["p"].get(str(leader_pid)), f3["p"].get(str(fpid))

            cands = []
            for lk in W:
                pa2 = ka[COCO_WRIST[lk]]
                if pa2[2] < HOLD_2D_CONF:
                    continue
                for fk in W:
                    pb2 = kb[COCO_WRIST[fk]]
                    if pb2[2] < HOLD_2D_CONF:
                        continue
                    d2 = dist2d(pa2, pb2) / hgt
                    if d2 > HOLD_2D_MAX:
                        continue
                    # 3Dで「相手の胴に張り付いた手」＝背中に回した手を見分ける
                    back = False
                    if a3 is not None and b3 is not None:
                        back = (float(np.linalg.norm(pos3(a3, lk) - torso3(b3))) < BACK_HAND_M or
                                float(np.linalg.norm(pos3(b3, fk) - torso3(a3))) < BACK_HAND_M)
                    # 3Dが補間値の手首は「根拠が無い」— 実観測だけで決まらないときの予備に回す
                    interp = (a3 is not None and b3 is not None and
                              min(a3["v"][idx[lk]], b3["v"][idx[fk]]) < 1.0)
                    cands.append((d2, back, interp, lk, fk))
            if not cands:
                continue
            # 実観測 → 背中でない、の順に優先して絞る。全部落ちるときは落とさない
            real = [c for c in cands if not c[2]] or cands
            free = [c for c in real if not c[1]] or real
            d2, _, _, lk, fk = min(free)
            scores.setdefault((lk, fk), []).append(d2)

        # フレームごとに勝った組を集め、まず勝ち数、同数なら距離の中央値で決める。
        # 絞り込み（背中の手・補間値）はフレーム単位でしか効かないので、
        # 全フレームの距離を混ぜて比べると、落としたはずの組が別フレームから紛れ込む
        jp = {"lWrist": "左手", "rWrist": "右手"}
        label = None
        if scores:
            lk, fk = max(scores, key=lambda k: (len(scores[k]), -float(np.median(scores[k]))))
            label = f"リーダー{jp[lk]}×フォロワー{jp[fk]}"
        if ev.get("hold") != label:
            if ev.get("hold") is not None:
                ev["hold2d"] = ev["hold"]   # 元の判定を残す（追えるように）
            if label is None:
                n_cleared += 1
            else:
                n_changed += 1
        ev["hold"] = label
    return n_changed, n_cleared


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("out")
    ap.add_argument("--decimals", type=int, default=3)
    ap.add_argument("--target-height", type=float, default=0.0,
                    help="立ち姿の頭頂高をこの値[m]に合わせてシーン全体を一様スケールする。"
                         "MediaPipe のメートル推定は平均体型に引かれて小さめに出る（実測 約1.4m）ため、"
                         "見た目の説得力を出す用。位置も関節も同じ倍率で拡大するので相対関係は不変。0で無効")
    ap.add_argument("--measurements", default=None,
                    help="measurements.json のパス。summary.beatGrid をクリップへ同梱する")
    ap.add_argument("--tracks", default=None,
                    help="measurements.tracks.json のパス（2Dキーポイント）。"
                         "イベントの hold（つないだ手）を画像座標で決め直すのに使う。"
                         "省略すると hold は上流の値のまま")
    args = ap.parse_args()

    beat_grid = None
    if args.measurements:
        try:
            m = json.load(open(args.measurements))
            bg = (m.get("summary") or {}).get("beatGrid")
            if bg and bg.get("bpm"):
                beat_grid = {k: bg[k] for k in
                             ("bpm", "firstBeatSec", "beatIntervalSec", "confidence") if k in bg}
        except (OSError, json.JSONDecodeError) as e:
            print(f"warn: measurements 読み込み失敗 ({e}) — beatGrid なしで続行", file=sys.stderr)

    data = json.load(open(args.lifted))
    frames = data["frames"]

    # --- ステージ座標へ正規化 ---
    # 全フレームの絶対関節位置を集め、足元を y=0、ペアの中心を原点に置く。
    allp = []
    for fr in frames:
        for p in fr["persons"]:
            j = np.array(p["joints"])[PICK] + np.array(p["root"])
            allp.append(j)
    allp = np.concatenate(allp, axis=0)
    floor_y = float(np.percentile(allp[:, 1], 1.0))
    cx = float(np.median(allp[:, 0]))
    cz = float(np.median(allp[:, 2]))
    shift = np.array([-cx, -floor_y, -cz])

    # 一様スケール。床を y=0 に合わせた *後* に掛けるので、床は床のまま
    scale = 1.0
    if args.target_height > 0:
        tops = []
        for fr in frames:
            for p in fr["persons"]:
                j = np.array(p["joints"])[PICK] + np.array(p["root"]) + shift
                tops.append(float(j[:, 1].max()))
        cur = float(np.median(tops))
        if cur > 1e-6:
            scale = args.target_height / cur
            print(f"uniform scale x{scale:.3f} (頭頂 {cur:.2f}m -> {args.target_height:.2f}m)",
                  file=sys.stderr)

    d = args.decimals
    out_frames = []
    for fr in frames:
        ps = {}
        for p in fr["persons"]:
            j = (np.array(p["joints"])[PICK] + np.array(p["root"]) + shift) * scale
            vis = np.array(p["vis"])[PICK]
            # 観測=1 / 補間=0.5 / 無し=0 の3値に畳む（Web 側は描く/描かないの判断だけできればよい）
            v = np.where(vis >= 0.4, 1.0, np.where(vis < 0, 0.5, 0.0))
            root = (np.array(p["root"]) + shift) * scale
            ps[str(p["pid"])] = {
                "r": [round(float(x), d) for x in root],
                "j": [round(float(x), d) for x in j.reshape(-1)],
                "v": [float(x) for x in v],
            }
        if ps:
            out_frames.append({"t": round(fr["t"], 3), "p": ps})

    # fps はメタデータではなく実際のタイムスタンプ間隔から出す（上流で取り直すと古い値が残る）
    ts_all = [fr["t"] for fr in out_frames]
    dt = float(np.median(np.diff(ts_all))) if len(ts_all) > 2 else 0.0
    eff_fps = round(1.0 / dt, 2) if dt > 1e-6 else data.get("sampledFps")

    # つないでいる手を決め直す（画像で絞り、3Dは背中の手を落とすためだけに使う）
    events = data.get("events") or []
    leader_pid = data.get("leaderPid", 0)
    if events and args.tracks:
        try:
            tracks = json.load(open(args.tracks, encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"warn: tracks 読み込み失敗 ({e}) — hold は上流の値のまま", file=sys.stderr)
            tracks = None
        idx = {n: i for i, n in enumerate(NAMES)}
        cam = data.get("camera") or {}
        aspect = (cam.get("width") or 1) / (cam.get("height") or 1)
        n_changed, n_cleared = recompute_holds(out_frames, events, leader_pid, idx, tracks, aspect)
        print(f"  hold 再判定: {n_changed}/{len(events)} 件を訂正・"
              f"{n_cleared} 件は「つないでいない」に変更", file=sys.stderr)

    clip = {
        "version": 1,
        "video": data.get("video"),
        "fps": eff_fps,
        "duration": out_frames[-1]["t"] if out_frames else 0.0,
        "leaderPid": leader_pid,
        "joints": NAMES,
        "events": events,
        "frames": out_frames,
    }
    if beat_grid:
        clip["beatGrid"] = beat_grid
        print(f"  beatGrid 同梱: bpm={beat_grid['bpm']}", file=sys.stderr)
    json.dump(clip, open(args.out, "w"), separators=(",", ":"))

    import os
    size = os.path.getsize(args.out)
    print(f"wrote {args.out}: {len(out_frames)} frames, {size/1024:.0f}KB", file=sys.stderr)
    print(f"  floor_y={floor_y:.2f}  center=({cx:.2f}, {cz:.2f})", file=sys.stderr)
    hs = []
    for fr in out_frames:
        for p in fr["p"].values():
            j = np.array(p["j"]).reshape(-1, 3)
            hs.append(j[:, 1].max())
    print(f"  頭頂の高さ median={np.median(hs):.2f}m (床からの立ち姿の高さの目安)", file=sys.stderr)


if __name__ == "__main__":
    main()
