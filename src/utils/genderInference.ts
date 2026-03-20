/**
 * genderInference.ts — Cold Start 性別推定（Ephemeral AI 設計）
 *
 * face-api.js（window.faceapi）を使用して動画の最初のフレームで
 * 2人の性別確率を推定し、Leader/Follower 初期割り当てに活用する。
 *
 * Ephemeral 設計:
 *   - 呼び出しは1回限り（usePoseEstimation 内の coldStartDoneRef で管理）
 *   - 関数終了後、ローカル参照は GC 対象になる
 *   - 以降のフレームでは MediaPipe 座標追跡のみ使用
 *
 * モデルファイル（/public/models/ に配置済み）:
 *   - tiny_face_detector_model-weights_manifest.json + shard1 (~189KB)
 *   - age_gender_model-weights_manifest.json + shard1 (~420KB)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { faceapi?: any; }
}

export interface FaceGenderResult {
  /** 男性確率 (0.0=確実に女性 〜 1.0=確実に男性) — Leader スコアとして使用 */
  maleProb: number;
  /** 判定確信度（genderProbability の高い方） */
  confidence: number;
  /** 動画ネイティブ座標系のバウンディングボックス（ピクセル） */
  box: { x: number; y: number; w: number; h: number };
}

let modelsLoaded = false;

/**
 * 動画から全ての顔を検出し性別推定を実行する。
 * 初回呼び出し時のみモデルをロード（/public/models から fetch）。
 * 以降のフレームでは呼ばない — MediaPipe に全リソースを委ねる。
 */
export async function detectGendersFromVideo(
  video: HTMLVideoElement,
): Promise<FaceGenderResult[]> {
  const faceapi = window.faceapi;
  if (!faceapi) return [];

  if (!modelsLoaded) {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.ageGenderNet.loadFromUri('/models'),
    ]);
    modelsLoaded = true;
  }

  let detections: any[];
  try {
    detections = await faceapi
      .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.35 }))
      .withAgeAndGender();
  } catch {
    return [];
  }

  if (!detections || detections.length === 0) return [];

  return detections.map((d: any) => {
    const isMale = d.gender === 'male';
    return {
      maleProb: isMale ? d.genderProbability : 1 - d.genderProbability,
      confidence: d.genderProbability,
      box: {
        x: d.detection.box.x,
        y: d.detection.box.y,
        w: d.detection.box.width,
        h: d.detection.box.height,
      },
    };
  });
  // ← 関数スコープ終了 → detections / faceapi ローカル参照は GC 対象
}
