#!/usr/bin/env python3
"""
復元3D → Web(three.js) が読むモーションクリップ。

必要な13関節だけに絞り、ステージ座標（床 y=0・ペアの中心が原点）へ正規化して出す。
Web 側で余計な計算をさせないため、正規化はここで済ませる。

出力スキーマ:
{
  "fps": 10.5, "leaderPid": 0, "duration": 31.4,
  "joints": ["nose","lShoulder",...],          # 13個の名前（順序が j の並び）
  "events": [...],                              # 技イベント（技名ラベル用にそのまま同梱）
  "frames": [
    {"t": 0.0, "p": {"0": {"r":[x,y,z], "j":[x,y,z, x,y,z, ...39個], "v":[...13]}, "1": {...}}}
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

# MediaPipe 33点のうち Web のリグで使う13点
PICK = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
NAMES = ["nose", "lShoulder", "rShoulder", "lElbow", "rElbow", "lWrist", "rWrist",
         "lHip", "rHip", "lKnee", "rKnee", "lAnkle", "rAnkle"]


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

    clip = {
        "version": 1,
        "video": data.get("video"),
        "fps": eff_fps,
        "duration": out_frames[-1]["t"] if out_frames else 0.0,
        "leaderPid": data.get("leaderPid", 0),
        "joints": NAMES,
        "events": data.get("events") or [],
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
