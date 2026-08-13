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


HOLD_WINDOW_SEC = 0.35   # イベント時刻の前後この範囲で多数決する
BACK_HAND_M = 0.35       # 相手の胴中心にこれより近い手は「背中に回した手」とみなす
HOLD_CLOSE_M = 0.20      # ただし手どうしがこれより近ければ、胴に近くてもつないでいる
HOLD_MAX_M = 1.20        # これ以上離れていたら手はつないでいない


def recompute_holds(out_frames, events, leader_pid, idx):
    """イベントごとの「つないでいる手」を3Dで決め直す。

    ■ なぜ決め直すか
    analyze_pair.py の hold は **2D画像座標の最近接**で決めている（COCO 17点に z が無いため）。
    画面上で近いことと触れていることは別で、実測（2fda2815 t=3.40）では
    クローズドポジションで**背中に回したリーダーの右手**が、相手の手首と画面上で重なって勝ち、
    本当につないでいる「リーダー左手×フォロワー右手」が4通り中いちばん遠い扱いになっていた。

    ■ 3Dなら分けられる2つの見分け
    1. 補間で埋めた手首は候補にしない（上の例では相方が補間値だった＝根拠が無い）
    2. 相手の胴中心に近すぎる手は「背中の手」として候補から外す。
       ただし **手どうしが触れる距離（HOLD_CLOSE_M）まで近い組は外さない** —
       クローズドポジションでは握った手も互いの体のすぐ近くにあるため。
       全部外れてしまうときも外さない（密着時に誤って空にしないため）

    絶対距離では判定しない。腕の推定誤差は median 26.5cm・p95 65cm もあるので、
    「触れているか」ではなく **4通りのどれか** を選ぶ問題として解く。
    """
    fpid = 1 - leader_pid
    W = ("lWrist", "rWrist")
    T = ("lShoulder", "rShoulder", "lHip", "rHip")

    def pos(p, name):
        i = idx[name] * 3
        return np.array(p["j"][i:i + 3])

    def torso(p):
        return np.mean([pos(p, n) for n in T], axis=0)

    n_changed = 0
    for ev in events:
        votes = {}
        for fr in out_frames:
            if abs(fr["t"] - ev["t"]) > HOLD_WINDOW_SEC:
                continue
            a = fr["p"].get(str(leader_pid))
            b = fr["p"].get(str(fpid))
            if a is None or b is None:
                continue
            ta, tb = torso(a), torso(b)
            for vmin in (1.0, 0.5):   # まず実観測だけで。無ければ補間も許す
                cands = []
                for lk in W:
                    if a["v"][idx[lk]] < vmin:
                        continue
                    for fk in W:
                        if b["v"][idx[fk]] < vmin:
                            continue
                        pa, pb = pos(a, lk), pos(b, fk)
                        d = float(np.linalg.norm(pa - pb))
                        # 手が触れる距離まで近いなら、胴に近くてもそれはつないだ手。
                        # クローズドポジションでは握った手も互いの体の近くにある。
                        back = d > HOLD_CLOSE_M and (
                            np.linalg.norm(pa - tb) < BACK_HAND_M or
                            np.linalg.norm(pb - ta) < BACK_HAND_M)
                        cands.append((d, back, lk, fk))
                if not cands:
                    continue
                free = [c for c in cands if not c[1]]
                pick = min(free or cands)
                if pick[0] <= HOLD_MAX_M:
                    key = (pick[2], pick[3])
                    votes[key] = votes.get(key, 0) + 1
                break
        if not votes:
            continue
        lk, fk = max(votes, key=lambda k: votes[k])
        jp = {"lWrist": "左手", "rWrist": "右手"}
        label = f"リーダー{jp[lk]}×フォロワー{jp[fk]}"
        if ev.get("hold") != label:
            if ev.get("hold") is not None:
                ev["hold2d"] = ev["hold"]   # 元の2D判定を残す（追えるように）
            n_changed += 1
        ev["hold"] = label
    return n_changed


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

    # つないでいる手は3Dで決め直す（2D最近接は背中に回した手に釣られる）
    events = data.get("events") or []
    leader_pid = data.get("leaderPid", 0)
    if events:
        idx = {n: i for i, n in enumerate(NAMES)}
        n_changed = recompute_holds(out_frames, events, leader_pid, idx)
        print(f"  hold を3Dで再判定: {n_changed}/{len(events)} 件を訂正", file=sys.stderr)

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
