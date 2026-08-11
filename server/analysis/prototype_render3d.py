#!/usr/bin/env python3
"""
prototype_lift3d.py の出力を検証するためのレンダラ。

3D復元がちゃんとできているかを確かめる一番確実な方法は、
**元の動画には存在しないカメラ角度から見てみること**。2Dのままなら横から見た瞬間に
人が平面に潰れる。潰れずに立体として見えれば、奥行きが本当に入っている。

左パネル=元カメラとほぼ同じ正面視 / 右パネル=ぐるっと回り込む俯瞰カメラ、の2画面で出力する。

Usage:
  python prototype_render3d.py <lifted.json> <out.mp4> [--fps 10.5] [--size 640]
"""
import sys
import json
import math
import argparse

import cv2
import numpy as np

# MediaPipe Pose 33点の骨格。描画用の主要な接続のみ。
POSE_EDGES = [
    (11, 12), (11, 23), (12, 24), (23, 24),          # 胴
    (11, 13), (13, 15), (12, 14), (14, 16),          # 腕
    (23, 25), (25, 27), (27, 31), (24, 26), (26, 28), (28, 32),  # 脚
    (0, 11), (0, 12),                                 # 首まわり
]
LEADER_BGR = (255, 139, 61)     # #3d8bff (BGR)
FOLLOWER_BGR = (184, 77, 255)   # #ff4db8 (BGR)


def look_at(eye, target, up=np.array([0.0, 1.0, 0.0])):
    """ワールド→カメラ の回転行列と平行移動を返す（右手系・カメラは -Z を見る）"""
    f = target - eye
    f = f / np.linalg.norm(f)
    s = np.cross(f, up)
    s = s / np.linalg.norm(s)
    u = np.cross(s, f)
    R = np.stack([s, u, -f])  # 行がカメラ基底
    return R, eye


def project(pts, R, eye, f_px, w, h):
    """(N,3) ワールド点 → (N,2) スクリーン画素 + (N,) 深度。カメラ後方は深度<=0"""
    cam = (pts - eye) @ R.T
    z = -cam[:, 2]  # カメラ前方を正に
    with np.errstate(divide="ignore", invalid="ignore"):
        u = w / 2.0 + f_px * cam[:, 0] / z
        v = h / 2.0 - f_px * cam[:, 1] / z
    return np.stack([u, v], axis=1), z


def draw_floor(img, R, eye, f_px, w, h, extent=2.5, step=0.5):
    """床のグリッド。奥行きの手がかりが無いと立体かどうか判断できないので必ず描く"""
    lines = []
    n = int(extent / step)
    for i in range(-n, n + 1):
        c = i * step
        lines.append((np.array([-extent, 0.0, c]), np.array([extent, 0.0, c])))
        lines.append((np.array([c, 0.0, -extent]), np.array([c, 0.0, extent])))
    for a, b in lines:
        pts, z = project(np.stack([a, b]), R, eye, f_px, w, h)
        if z[0] <= 0.05 or z[1] <= 0.05:
            continue
        p0 = (int(pts[0][0]), int(pts[0][1]))
        p1 = (int(pts[1][0]), int(pts[1][1]))
        cv2.line(img, p0, p1, (54, 40, 28), 1, cv2.LINE_AA)


def draw_person(img, joints_world, vis, color, R, eye, f_px, w, h):
    """vis の約束: >=0.4 は観測、<0 は時間補間で埋めた推定、それ以外は描かない。
    推定で埋めた部分は暗く細く描き、観測と見分けがつくようにする（見た目を良くするために
    埋めた点を観測と同じ顔で出すと、後で精度を議論できなくなる）"""
    pts, z = project(joints_world, R, eye, f_px, w, h)
    ok = (z > 0.05) & np.isfinite(pts[:, 0]) & np.isfinite(pts[:, 1])
    observed = vis >= 0.4
    estimated = vis < 0
    usable = observed | estimated
    dim = tuple(int(c * 0.45) for c in color)

    for a, b in POSE_EDGES:
        if not (ok[a] and ok[b] and usable[a] and usable[b]):
            continue
        if observed[a] and observed[b]:
            cv2.line(img, (int(pts[a][0]), int(pts[a][1])),
                     (int(pts[b][0]), int(pts[b][1])), color, 3, cv2.LINE_AA)
        else:
            cv2.line(img, (int(pts[a][0]), int(pts[a][1])),
                     (int(pts[b][0]), int(pts[b][1])), dim, 2, cv2.LINE_AA)
    for i in range(len(pts)):
        if ok[i] and observed[i] and i in (0, 11, 12, 15, 16, 23, 24, 27, 28):
            cv2.circle(img, (int(pts[i][0]), int(pts[i][1])), 4, color, -1, cv2.LINE_AA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lifted")
    ap.add_argument("out")
    ap.add_argument("--fps", type=float, default=0.0)
    ap.add_argument("--size", type=int, default=640)
    args = ap.parse_args()

    data = json.load(open(args.lifted))
    frames = data["frames"]
    leader_pid = data.get("leaderPid", 0)
    # fps はメタデータではなく実際のタイムスタンプ間隔から出す
    # （上流で密に取り直すと sampledFps に古い値が残り、再生が3倍遅くなる）
    fps = args.fps
    if not fps:
        ts = [fr["t"] for fr in frames]
        dt = float(np.median(np.diff(ts))) if len(ts) > 2 else 0.0
        fps = 1.0 / dt if dt > 1e-6 else float(data.get("sampledFps") or 10.0)

    # 全フレームの絶対関節位置を先に組み立て、床の高さとペアの中心を決める
    built = []
    for fr in frames:
        ps = []
        for p in fr["persons"]:
            jw = np.array(p["joints"], dtype=np.float64) + np.array(p["root"], dtype=np.float64)
            ps.append({"pid": p["pid"], "jw": jw, "vis": np.array(p["vis"], dtype=np.float64)})
        built.append({"t": fr["t"], "persons": ps})

    all_pts = np.concatenate([p["jw"] for f in built for p in f["persons"]], axis=0)
    floor_y = np.percentile(all_pts[:, 1], 1.0)     # 足元
    center = np.array([np.median(all_pts[:, 0]), 0.0, np.median(all_pts[:, 2])])
    # 床が y=0、ペアの中心が原点に来るように平行移動
    shift = np.array([-center[0], -floor_y, -center[2]])
    for f in built:
        for p in f["persons"]:
            p["jw"] = p["jw"] + shift

    S = args.size
    W, H = S * 2, S
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    vw = cv2.VideoWriter(args.out, fourcc, fps, (W, H))
    f_px = (S / 2.0) / math.tan(math.radians(45.0) / 2.0)

    tgt = np.array([0.0, 0.85, 0.0])
    n = len(built)
    for i, fr in enumerate(built):
        panels = []

        # 左: 元カメラとほぼ同じ正面視（+Z から見る）
        eyeF = np.array([0.0, 1.2, 3.4])
        RF, _ = look_at(eyeF, tgt)

        # 右: 高さのある軌道カメラ。クリップ全体で 360 度回り込む
        az = (i / max(1, n - 1)) * 2 * math.pi
        r = 3.4
        eyeO = np.array([math.sin(az) * r, 2.1, math.cos(az) * r])
        RO, _ = look_at(eyeO, tgt)

        for label, R, eye in (("FRONT (元カメラ相当)", RF, eyeF),
                              (f"ORBIT {math.degrees(az):5.0f}deg", RO, eyeO)):
            img = np.full((S, S, 3), (24, 14, 10), dtype=np.uint8)
            draw_floor(img, R, eye, f_px, S, S)
            # 奥の人から描く（前後関係を正しく重ねる）
            order = sorted(fr["persons"], key=lambda p: -np.median(((p["jw"] - eye) @ R.T)[:, 2]))
            for p in order:
                color = LEADER_BGR if p["pid"] == leader_pid else FOLLOWER_BGR
                draw_person(img, p["jw"], p["vis"], color, R, eye, f_px, S, S)
            cv2.putText(img, label, (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1, cv2.LINE_AA)
            cv2.putText(img, f"t={fr['t']:.2f}s", (12, S - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (150, 150, 150), 1, cv2.LINE_AA)
            panels.append(img)

        vw.write(np.hstack(panels))

    vw.release()
    print(f"wrote {args.out}: {n} frames @ {fps:.2f}fps, {W}x{H}", file=sys.stderr)


if __name__ == "__main__":
    main()
