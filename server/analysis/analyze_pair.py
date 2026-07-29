#!/usr/bin/env python3
"""
サルサペア動画から MediaPipe Pose Landmarker (Heavy, num_poses=2) で
2人分の骨格を計測し、SHR（3D肩腰比）に基づく Leader/Follower の一次判定と
「判定が難しい区間（contested）」を抽出する。

docs/folder-analysis-detailed-design.md §8.1 参照

- 10fps 相当に間引き（Heavy×CPUの処理時間を抑える。男女判定に30fpsは不要）
- num_poses=4 で候補を多めに検出し、bbox面積の大きい上位2人をペアとして採用
  （背景の鏡・通行人など第三者がスロットを汚染するのを防ぐ。ThinkCentre実機検証の申し送り#1）
- スロット割り当ては前フレームの腰位置との Nearest Neighbor（オフライン処理
  なので速度予測は持たない。1フレーム欠けても次フレームで復帰できれば十分）
- SHR = 3D肩幅 / 3D腰幅。hypot(dx, dz) により横向き時も骨格の厚みから計測
  （ブラウザ実装 usePoseEstimation.ts と同じ考え方）
- verdict 用の SHR 平均はオクルージョンフレームを除外した「クリーンフレーム」のみから算出
  （密着姿勢で計測が崩れたフレームの混入を防ぐ。申し送り#2）

出力: measurements.json（スキーマは詳細設計 §8.1）

Usage: python analyze_pair.py <video_path> <model_path> <output_json_path>
"""
import sys
import json
import math
import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
LEFT_HIP = 23
RIGHT_HIP = 24

TARGET_FPS = 10.0          # 間引き後の実効fps
NUM_POSES = 4              # 検出候補数（上位2人をbbox面積で選別するため多めに取る）
SHR_DIFF_THRESHOLD = 0.05  # これ未満は「拮抗」
CONTESTED_MIN_SEC = 3.0    # 拮抗が続いたら contested とみなす最小長
OCCLUSION_DIST = 0.10      # 腰中点間の正規化距離がこれ未満ならオクルージョン
MAX_CONTESTED = 5          # Claude に渡す contested 区間の上限
SMOOTH_WINDOW = 20         # SHR差の移動平均窓（10fpsで2秒）
MIN_CLEAN_SAMPLES = 10     # verdict をクリーンフレームから出すのに必要な最小サンプル数


def hypot3d_xz(a, b):
    """X-Z平面での距離（横向きでも骨格の厚みが取れる）"""
    return math.hypot(a.x - b.x, (a.z or 0.0) - (b.z or 0.0))


def measure_person(lm):
    """1人分のランドマークから計測値を返す。取れなければ None"""
    try:
        sl, sr = lm[LEFT_SHOULDER], lm[RIGHT_SHOULDER]
        hl, hr = lm[LEFT_HIP], lm[RIGHT_HIP]
    except IndexError:
        return None
    shoulder_w = hypot3d_xz(sl, sr)
    hip_w = hypot3d_xz(hl, hr)
    if hip_w < 1e-6:
        return None
    # bbox面積（全ランドマークのx/yスパン）: 手前の人ほど大きい。第三者フィルタに使う
    xs = [p.x for p in lm]
    ys = [p.y for p in lm]
    bbox_area = (max(xs) - min(xs)) * (max(ys) - min(ys))
    return {
        "hipX": round((hl.x + hr.x) / 2, 4),
        "hipY": round((hl.y + hr.y) / 2, 4),
        "shr3d": round(shoulder_w / hip_w, 4),
        "shoulderW": round(shoulder_w, 4),
        "bboxArea": round(bbox_area, 5),
    }


def pick_main_pair(persons):
    """検出候補から bbox 面積の大きい上位2人（＝カメラ手前のダンサーペア）を選ぶ。

    背景の鏡・通行人など小さく写る第三者を弾く。3人目が主ペアと同等サイズの
    場合は選別できないが、その場合はスロットNNトラッキングの連続性に委ねる。
    """
    if len(persons) <= 2:
        return persons
    return sorted(persons, key=lambda p: p["bboxArea"], reverse=True)[:2]


def assign_slots(persons, prev_slots):
    """
    検出された人物（最大2）を前フレームの腰位置との Nearest Neighbor で
    スロット 0/1 に割り当てる。戻り値は [slot0の計測 or None, slot1の計測 or None]
    """
    slots = [None, None]
    if not persons:
        return slots
    if prev_slots[0] is None and prev_slots[1] is None:
        # 初回: hipX の小さい方（画面左）を slot0 に
        ordered = sorted(persons, key=lambda p: p["hipX"])
        for i, p in enumerate(ordered[:2]):
            slots[i] = p
        return slots

    def dist(p, s):
        if s is None:
            return 0.5  # 空スロットへの割り当てコスト（中立）
        return math.hypot(p["hipX"] - s["hipX"], p["hipY"] - s["hipY"])

    if len(persons) == 1:
        p = persons[0]
        target = 0 if dist(p, prev_slots[0]) <= dist(p, prev_slots[1]) else 1
        slots[target] = p
    else:
        a, b = persons[0], persons[1]
        direct = dist(a, prev_slots[0]) + dist(b, prev_slots[1])
        swapped = dist(a, prev_slots[1]) + dist(b, prev_slots[0])
        if direct <= swapped:
            slots[0], slots[1] = a, b
        else:
            slots[0], slots[1] = b, a
    return slots


def moving_average(values, window):
    out = []
    acc = 0.0
    buf = []
    for v in values:
        buf.append(v)
        acc += v
        if len(buf) > window:
            acc -= buf.pop(0)
        out.append(acc / len(buf))
    return out


def extract_contested(frames, effective_fps):
    """
    contested 区間を抽出する:
      (a) 平滑化したSHR差 < SHR_DIFF_THRESHOLD が CONTESTED_MIN_SEC 以上続く区間
      (b) オクルージョン率 > 50% の区間（同じ最小長）
    frames: [{t, shrDiff or None, occluded}, ...]
    """
    # SHR差が取れないフレームは直前値で補間（区間検出の連続性のため）
    diffs = []
    last = SHR_DIFF_THRESHOLD * 2  # 初期値は「拮抗していない」扱い
    for f in frames:
        if f["shrDiff"] is not None:
            last = f["shrDiff"]
        diffs.append(last)
    smooth = moving_average(diffs, SMOOTH_WINDOW)

    min_frames = int(CONTESTED_MIN_SEC * effective_fps)
    segments = []

    def flush(start_idx, end_idx, reason):
        if end_idx - start_idx + 1 >= min_frames:
            segments.append({
                "from": round(frames[start_idx]["t"], 2),
                "to": round(frames[end_idx]["t"], 2),
                "reason": reason,
            })

    # (a) SHR拮抗
    run_start = None
    for i, d in enumerate(smooth):
        if d < SHR_DIFF_THRESHOLD:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                flush(run_start, i - 1, f"shr_diff<{SHR_DIFF_THRESHOLD}")
                run_start = None
    if run_start is not None:
        flush(run_start, len(smooth) - 1, f"shr_diff<{SHR_DIFF_THRESHOLD}")

    # (b) オクルージョン連続
    run_start = None
    for i, f in enumerate(frames):
        if f["occluded"]:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                flush(run_start, i - 1, "occlusion")
                run_start = None
    if run_start is not None:
        flush(run_start, len(frames) - 1, "occlusion")

    # 重複マージはせず長い順に上限まで（切り捨ては呼び出し元で記録）
    segments.sort(key=lambda s: s["to"] - s["from"], reverse=True)
    dropped = max(0, len(segments) - MAX_CONTESTED)
    kept = sorted(segments[:MAX_CONTESTED], key=lambda s: s["from"])
    return kept, dropped


def main():
    if len(sys.argv) != 4:
        print("Usage: analyze_pair.py <video_path> <model_path> <output_json_path>", file=sys.stderr)
        sys.exit(1)

    video_path, model_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

    options = PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=RunningMode.VIDEO,
        num_poses=NUM_POSES,
    )

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"failed to open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = max(1, round(fps / TARGET_FPS))
    effective_fps = fps / frame_interval

    frame_idx = 0
    sampled = 0
    prev_slots = [None, None]
    person_frames = []   # persons 配列（出力用）
    contest_frames = []  # contested 抽出用の軽量列
    # スロット別サマリ集計。verdict にはクリーン（非オクルージョン）のみ使う
    clean_stats = [{"sum": 0.0, "sumsq": 0.0, "n": 0} for _ in range(2)]
    all_stats = [{"sum": 0.0, "sumsq": 0.0, "n": 0} for _ in range(2)]

    with PoseLandmarker.create_from_options(options) as landmarker:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % frame_interval != 0:
                frame_idx += 1
                continue

            t_sec = frame_idx / fps
            t_ms = int(t_sec * 1000)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            result = landmarker.detect_for_video(mp_image, t_ms)

            persons = []
            for lm in (result.pose_landmarks or []):
                m = measure_person(lm)
                if m is not None:
                    persons.append(m)
            persons = pick_main_pair(persons)  # 背景の第三者を弾く

            slots = assign_slots(persons, prev_slots)
            # 検出できたスロットのみ prev を更新（欠けたスロットは位置を保持して復帰を待つ）
            for i in range(2):
                if slots[i] is not None:
                    prev_slots[i] = slots[i]

            both = slots[0] is not None and slots[1] is not None
            occluded = False
            if both:
                d = math.hypot(slots[0]["hipX"] - slots[1]["hipX"], slots[0]["hipY"] - slots[1]["hipY"])
                occluded = d < OCCLUSION_DIST
            elif len(persons) == 1 and prev_slots[0] is not None and prev_slots[1] is not None:
                occluded = True  # 2人いたはずが1人しか検出できない＝重なりの可能性

            z_front = -1
            if both:
                z_front = 0 if slots[0]["shoulderW"] >= slots[1]["shoulderW"] else 1

            shr_diff = None
            if both:
                shr_diff = abs(slots[0]["shr3d"] - slots[1]["shr3d"])
            for i in range(2):
                if slots[i] is not None:
                    all_stats[i]["sum"] += slots[i]["shr3d"]
                    all_stats[i]["sumsq"] += slots[i]["shr3d"] ** 2
                    all_stats[i]["n"] += 1
                    # 密着姿勢では肩・腰の3D計測が崩れるため verdict 母集団から除外
                    if not occluded:
                        clean_stats[i]["sum"] += slots[i]["shr3d"]
                        clean_stats[i]["sumsq"] += slots[i]["shr3d"] ** 2
                        clean_stats[i]["n"] += 1

            person_frames.append({
                "t": round(t_sec, 3),
                "slots": [
                    ({**{k: slots[i][k] for k in ("hipX", "hipY", "shr3d")}, "occluded": occluded}
                     if slots[i] is not None else None)
                    for i in range(2)
                ],
                "zFront": z_front,
            })
            contest_frames.append({"t": t_sec, "shrDiff": shr_diff, "occluded": occluded})

            sampled += 1
            frame_idx += 1

    cap.release()

    # サマリ
    def slot_summary(s):
        if s["n"] == 0:
            return {"shrMean": None, "shrStd": None, "samples": 0}
        mean = s["sum"] / s["n"]
        var = max(0.0, s["sumsq"] / s["n"] - mean ** 2)
        return {"shrMean": round(mean, 4), "shrStd": round(math.sqrt(var), 4), "samples": s["n"]}

    # verdict はクリーンフレーム優先。不足時は全フレームにフォールバック（basisで明示）
    clean0, clean1 = slot_summary(clean_stats[0]), slot_summary(clean_stats[1])
    all0, all1 = slot_summary(all_stats[0]), slot_summary(all_stats[1])
    use_clean = clean0["samples"] >= MIN_CLEAN_SAMPLES and clean1["samples"] >= MIN_CLEAN_SAMPLES
    v0, v1 = (clean0, clean1) if use_clean else (all0, all1)
    basis = "clean" if use_clean else "all_frames_fallback"

    if v0["shrMean"] is not None and v1["shrMean"] is not None:
        diff = v0["shrMean"] - v1["shrMean"]
        if abs(diff) >= SHR_DIFF_THRESHOLD:
            verdict = {
                "leader": 0 if diff > 0 else 1,
                "confidence": round(min(0.95, 0.5 + abs(diff) * 5), 2),
                "basis": basis,
            }
        else:
            verdict = {"leader": None, "confidence": 0.5, "basis": basis}
    else:
        verdict = {"leader": None, "confidence": 0.0, "basis": basis}

    # 出力の slot サマリは verdict に使った側（クリーン優先）。全フレーム値は samplesAll で併記
    sum0 = {**v0, "samplesAll": all0["samples"]}
    sum1 = {**v1, "samplesAll": all1["samples"]}

    contested, dropped = extract_contested(contest_frames, effective_fps)
    # 全体拮抗（平均差が閾値未満）なら、区間に関係なく全編が判定困難であることを明示
    if verdict["leader"] is None and sum0["samples"] > 0 and sum1["samples"] > 0:
        if not contested:
            total_t = contest_frames[-1]["t"] if contest_frames else 0.0
            contested = [{"from": 0.0, "to": round(total_t, 2), "reason": "shr_mean_diff<threshold"}]

    with open(output_path, "w") as f:
        json.dump({
            "fps": fps,
            "sampledFps": round(effective_fps, 2),
            "totalFrames": frame_idx,
            "sampledFrames": sampled,
            "persons": person_frames,
            "summary": {
                "slot0": sum0,
                "slot1": sum1,
                "verdictByRule": verdict,
                "contested": contested,
                "contestedDropped": dropped,
            },
        }, f)

    print(
        f"done: {sampled}/{frame_idx} frames sampled, "
        f"slot0 shr={sum0['shrMean']} (n={sum0['samples']}), "
        f"slot1 shr={sum1['shrMean']} (n={sum1['samples']}), "
        f"verdict={verdict}, contested={len(contested)} (+{dropped} dropped)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
