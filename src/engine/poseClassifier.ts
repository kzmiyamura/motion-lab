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

/** アノテーション済み JSON から学習データを構築 */
export function buildTrainingData(logs: AnnotatedPoseLog[]): {
  xs: number[][];
  ys: number[];
  sampleCount: number;
} {
  const xs: number[][] = [], ys: number[] = [];

  for (const log of logs) {
    for (const frame of log.frames) {
      if (frame.label !== 'standard_pos') continue;
      if (!frame.poses || frame.poses.length < 2) continue;
      const [p0, p1] = frame.poses;
      if (!p0?.landmarks || !p1?.landmarks) continue;
      if (p0.landmarks.length < 25 || p1.landmarks.length < 25) continue;

      // poses[0]=Leader のサンプル
      xs.push(extractFeatures(p0, p1)); ys.push(0);
      // 対称 augmentation: swap → poses[1]=Leader
      xs.push(extractFeatures(p1, p0)); ys.push(1);
    }
  }

  return { xs, ys, sampleCount: xs.length };
}

/** モデルを作成・学習して LayersModel を返す */
export async function trainModel(
  xs: number[][],
  ys: number[],
  onProgress: (epoch: number, total: number, loss: number, acc: number) => void,
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
      onEpochEnd: (epoch, logs) =>
        onProgress(epoch + 1, epochs, logs?.loss ?? 0, (logs?.acc ?? 0) as number),
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

/** 同期推論: poses[0] が Leader である確率 (0–1) を返す */
export function predictLeaderProbSync(
  model: LayersModel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tf: any,
  p0: Pose,
  p1: Pose,
): number {
  const features = extractFeatures(p0, p1);
  const input = tf.tensor2d([features], [1, FEATURE_SIZE]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output = (model as any).predict(input) as { dataSync(): Float32Array; dispose(): void };
  const probs = output.dataSync();
  input.dispose();
  output.dispose();
  return probs[0];
}
