#!/usr/bin/env python3
"""
2D原盤(tracks.json) → 3Dモーションクリップ までを一括で通す。

段ごとに別スクリプトへ分けてあるのは差し替え・再実行をしやすくするためだが、
毎回6本を手で叩くのは現実的でないのでここから順に呼ぶ。中間ファイルは --workdir に残るので、
どの段で壊れたかを後から追える。

  1. lift3d      切り出し + MediaPipe単人検出 + 座標変換 + 弱透視で配置   ← 唯一重い（知覚）
  2. refocus     焦点距離の差し替え（幾何のみ・再推論なし）
  3. smooth3d    欠落の時間補間と平滑化
  4. groundplane 床拘束で体格バイアスを補正
  5. bonelength  剛体拘束（胴体の板・骨長固定・zの符号と胴体回転の時間連続性）
  6. armfix      腕の外れ値除去（胴体基準の局所座標で判定・補間）
  7. pairfix     ホールド拘束（観測の転写）+ 接地ロック（footskate除去）
  8. export_clip Web用クリップ書き出し

焦点距離は prototype_calib_f.py で別途推定する（この動画では f>=1750 までしか絞れず、
2524 を採用。詳細はそちらのコメント）。

Usage:
  python run_lift3d_pipeline.py <tracks.json> <video> <model.task> <out_clip.json>
      [--workdir DIR] [--fps 30] [--f-px 2524] [--hfov 58] [--target-height 1.70]
      [--preview out.mp4] [--python PATH]
"""
import os
import sys
import subprocess
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))


def run(py, script, *args):
    cmd = [py, os.path.join(HERE, script), *[str(a) for a in args]]
    print(f"\n=== {script} ===", file=sys.stderr)
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f"failed: {script} (exit {r.returncode})", file=sys.stderr)
        sys.exit(r.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tracks")
    ap.add_argument("video")
    ap.add_argument("model")
    ap.add_argument("out")
    ap.add_argument("--workdir", default=None, help="中間ファイルの置き場。既定は出力の隣")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--f-px", type=float, default=2524.0)
    ap.add_argument("--hfov", type=float, default=58.0)
    ap.add_argument("--target-height", type=float, default=1.70)
    ap.add_argument("--preview", default=None, help="検証用2画面mp4も書き出す")
    ap.add_argument("--python", default=sys.executable)
    args = ap.parse_args()

    wd = args.workdir or os.path.join(os.path.dirname(os.path.abspath(args.out)), "lift3d_work")
    os.makedirs(wd, exist_ok=True)
    p = lambda n: os.path.join(wd, n)
    py = args.python

    run(py, "prototype_lift3d.py", args.tracks, args.video, args.model, p("1_lift.json"),
        "--fps", args.fps, "--hfov", args.hfov)
    run(py, "prototype_refocus.py", p("1_lift.json"), p("2_focus.json"), "--f-px", args.f_px)
    run(py, "prototype_smooth3d.py", p("2_focus.json"), p("3_smooth.json"))
    run(py, "prototype_groundplane.py", p("3_smooth.json"), "--apply", p("4_ground.json"))
    run(py, "prototype_bonelength.py", p("4_ground.json"), p("5_rigid.json"))
    run(py, "prototype_armfix.py", p("5_rigid.json"), p("6_arms.json"))
    run(py, "prototype_pairfix.py", p("6_arms.json"), args.tracks, p("7_pair.json"),
        "--contact-speed", 0.03, "--contact-height", 0.22)
    run(py, "prototype_export_clip.py", p("7_pair.json"), args.out,
        "--target-height", args.target_height)
    if args.preview:
        run(py, "prototype_render3d.py", p("7_pair.json"), args.preview)

    print(f"\ndone: {args.out}  (中間ファイル: {wd})", file=sys.stderr)


if __name__ == "__main__":
    main()
