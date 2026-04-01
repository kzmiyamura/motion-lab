/**
 * TF.js ブラウザ内学習・推論エンジン
 * Leader/Follower ロール分類（SHR + 相対位置特徴量ベース）
 */
import type { LayersModel } from '@tensorflow/tfjs';
import type { AnnotatedPoseLog } from '../types/pose';

export type { LayersModel as RoleModel };

const MODEL_KEY = 'indexeddb://salsa-role-model';
export const FEATURE_SIZE = 13;

type Pose = { landmarks: Array<{ x: number; y: number; z: number; visibility?: number }> };

/** 2人分のポーズから特徴ベクトルを抽出 (FEATURE_SIZE=13) */
export function extractFeatures(p0: Pose, p1: Pose): number[] {
  const lm0 = p0.landmarks, lm1 = p1.landmarks;

  // 3D肩幅・腰幅（XZ平面 hypot）
  const sw0 = Math.hypot(lm0[11].x - lm0[12].x, (lm0[11].z ?? 0) - (lm0[12].z ?? 0));
  const sw1 = Math.hypot(lm1[11].x - lm1[12].x, (lm1[11].z ?? 0) - (lm1[12].z ?? 0));
  const hw0 = Math.hypot(lm0[23].x - lm0[24].x, (lm0[23].z ?? 0) - (lm0[24].z ?? 0));
  const hw1 = Math.hypot(lm1[23].x - lm1[24].x, (lm1[23].z ?? 0) - (lm1[24].z ?? 0));

  // SHR（肩幅/腰幅比）
  const ps0 = hw0 > 0.01 ? sw0 / hw0 : 1.0;
  const ps1 = hw1 > 0.01 ? sw1 / hw1 : 1.0;

  // 身長（鼻→腰中点 Y距離）
  const midHipY0 = (lm0[23].y + lm0[24].y) / 2;
  const midHipY1 = (lm1[23].y + lm1[24].y) / 2;
  const bodyH0 = Math.max(0, midHipY0 - (lm0[0]?.y ?? 0));
  const bodyH1 = Math.max(0, midHipY1 - (lm1[0]?.y ?? 0));

  // 腰中点 X 位置
  const hipX0 = (lm0[23].x + lm0[24].x) / 2;
  const hipX1 = (lm1[23].x + lm1[24].x) / 2;

  return [
    ps0, ps1, ps0 - ps1,
    bodyH0, bodyH1, bodyH0 - bodyH1,
    hipX0, hipX1, hipX0 - hipX1,
    sw0, sw1,
    hw0, hw1,
  ];
}

/** アノテーション済み JSON から学習データを構築
 *
 * 使用するラベルと Leader 特定方法:
 *   standard_pos  → poses[0] = Leader（定義による）
 *   side_L_right  → hipX が大きい方 = Leader（右にいる）
 *   side_L_left   → hipX が小さい方 = Leader（左にいる）
 *   それ以外       → スキップ（Leader スロットを一意に特定できない）
 */
export function buildTrainingData(logs: AnnotatedPoseLog[]): {
  xs: number[][];
  ys: number[];
  sampleCount: number;
  breakdown: Record<string, number>;
} {
  const xs: number[][] = [], ys: number[] = [];
  const breakdown: Record<string, number> = {};

  for (const log of logs) {
    for (const frame of log.frames) {
      if (!frame.poses || frame.poses.length < 2) continue;
      const [p0, p1] = frame.poses;
      if (!p0?.landmarks || !p1?.landmarks) continue;
      if (p0.landmarks.length < 25 || p1.landmarks.length < 25) continue;

      let leaderIsSlot0: boolean | null = null;

      if (frame.label === 'standard_pos') {
        leaderIsSlot0 = true;
      } else if (frame.label === 'side_L_right') {
        // L右・F左: Leader は右側（hipX 大）
        const hx0 = (p0.landmarks[23].x + p0.landmarks[24].x) / 2;
        const hx1 = (p1.landmarks[23].x + p1.landmarks[24].x) / 2;
        leaderIsSlot0 = hx0 > hx1;
      } else if (frame.label === 'side_L_left') {
        // L左・F右: Leader は左側（hipX 小）
        const hx0 = (p0.landmarks[23].x + p0.landmarks[24].x) / 2;
        const hx1 = (p1.landmarks[23].x + p1.landmarks[24].x) / 2;
        leaderIsSlot0 = hx0 < hx1;
      }
      // overlap / complex_turn / single / ignore → スキップ

      if (leaderIsSlot0 === null) continue;

      const [leader, follower] = leaderIsSlot0 ? [p0, p1] : [p1, p0];
      xs.push(extractFeatures(leader, follower)); ys.push(0); // leader first
      xs.push(extractFeatures(follower, leader)); ys.push(1); // augmentation: follower first
      breakdown[frame.label] = (breakdown[frame.label] ?? 0) + 1;
    }
  }

  return { xs, ys, sampleCount: xs.length, breakdown };
}

/** モデルを作成・学習して LayersModel を返す */
export async function trainModel(
  xs: number[][],
  ys: number[],
  onProgress: (epoch: number, total: number, loss: number, acc: number) => void,
  shouldAbort?: () => boolean,
): Promise<LayersModel> {
  const tf = await import('@tensorflow/tfjs');

  const xsTensor = tf.tensor2d(xs, [xs.length, FEATURE_SIZE]);
  const ysTensor = tf.oneHot(tf.tensor1d(ys, 'int32'), 2);

  const model = tf.sequential({
    layers: [
      tf.layers.dense({ inputShape: [FEATURE_SIZE], units: 32, activation: 'relu' }),
      tf.layers.dropout({ rate: 0.2 }),
      tf.layers.dense({ units: 16, activation: 'relu' }),
      tf.layers.dense({ units: 2, activation: 'softmax' }),
    ],
  });

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy'],
  });

  const epochs = Math.min(120, Math.max(40, Math.floor(xs.length / 8)));

  await model.fit(xsTensor, ysTensor, {
    epochs,
    batchSize: 32,
    shuffle: true,
    validationSplit: 0.1,
    yieldEvery: 'batch',
    callbacks: {
      onEpochEnd: async (epoch, logs) => {
        onProgress(epoch + 1, epochs, logs?.loss ?? 0, (logs?.acc ?? 0) as number);
        if (shouldAbort?.()) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (model as any).stopTraining = true;
        }
      },
    },
  });

  tf.dispose([xsTensor, ysTensor]);
  return model as unknown as LayersModel;
}

/** IndexedDB にモデルを保存 */
export async function saveModel(model: LayersModel): Promise<void> {
  await model.save(MODEL_KEY);
}

/** IndexedDB からモデルを読み込む（存在しなければ null）*/
export async function loadModel(): Promise<LayersModel | null> {
  try {
    const tf = await import('@tensorflow/tfjs');
    return await tf.loadLayersModel(MODEL_KEY) as unknown as LayersModel;
  } catch {
    return null;
  }
}

/** モデルを JSON 文字列にシリアライズ（Drive 保存用）*/
export async function modelToJson(model: LayersModel): Promise<string> {
  const tf = await import('@tensorflow/tfjs');
  let artifacts: import('@tensorflow/tfjs').io.ModelArtifacts | null = null;

  await model.save(tf.io.withSaveHandler(async (a) => {
    artifacts = a;
    return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' as const } };
  }));

  if (!artifacts) throw new Error('モデルのシリアライズに失敗しました');
  const a = artifacts as import('@tensorflow/tfjs').io.ModelArtifacts;

  // weightData (ArrayBuffer) を base64 に変換
  const weightB64 = a.weightData
    ? btoa(String.fromCharCode(...new Uint8Array(a.weightData as ArrayBuffer)))
    : null;

  return JSON.stringify({ modelTopology: a.modelTopology, weightSpecs: a.weightSpecs, weightData: weightB64 });
}

/** JSON 文字列からモデルを復元（Drive 取得後）*/
export async function modelFromJson(json: string): Promise<LayersModel> {
  const tf = await import('@tensorflow/tfjs');
  const data = JSON.parse(json) as { modelTopology: unknown; weightSpecs: unknown; weightData: string | null };

  const weightData = data.weightData
    ? Uint8Array.from(atob(data.weightData), c => c.charCodeAt(0)).buffer
    : new ArrayBuffer(0);

  const model = await tf.loadLayersModel(tf.io.fromMemory(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data.modelTopology as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [{ paths: ['weights'], weights: data.weightSpecs }] as any,
    weightData,
  ));
  return model as unknown as LayersModel;
}

/** 同期推論: poses[0] が Leader である確率 (0–1) を返す */
export function predictLeaderProbSync(
  model: LayersModel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tf: any,
  p0: Pose,
  p1: Pose,
): number {
  const features = extractFeatures(p0, p1);
  let prob = 0.5;
  tf.tidy(() => {
    const input = tf.tensor2d([features], [1, FEATURE_SIZE]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (model as any).predict(input) as { dataSync(): Float32Array };
    prob = output.dataSync()[0];
  });
  return prob;
}
