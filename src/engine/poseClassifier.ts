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

// ─────────────────────────────────────────────────────────────────────────────
// V2 特徴量エンジン
// 特徴量: 13関節の腰基準正規化座標 × 2人 + 相対座標 + 速度ベクトル
// SHR などの加工済み数値を一切使わず、生のポーズ変化だけを学習の主役にする
// ─────────────────────────────────────────────────────────────────────────────

/** V2 で使う 13 関節インデックス（MediaPipe 33点から選択） */
export const KEY_JOINTS_V2 = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const;
// nose, L/R_shoulder, L/R_elbow, L/R_wrist, L/R_hip, L/R_knee, L/R_ankle

/** V2 で速度を計算する 6 関節（腰・手首・足首） */
export const VEL_JOINTS_V2 = [23, 24, 15, 16, 27, 28] as const;

/**
 * FEATURE_SIZE_V2 = 102
 *   positions p0 : 13 × 2 = 26
 *   positions p1 : 13 × 2 = 26
 *   relative      : 13 × 2 = 26
 *   velocity p0   :  6 × 2 = 12
 *   velocity p1   :  6 × 2 = 12
 */
export const FEATURE_SIZE_V2 = 102;

const MODEL_KEY_V2 = 'indexeddb://salsa-role-model-v2';

type LmPoint = { x: number; y: number };

/**
 * ランドマーク配列を腰中点基準・体長スケールで正規化し、
 * KEY_JOINTS_V2 の 13 点だけを返す
 */
export function normalizeKeyJointsV2(
  lm: Array<{ x: number; y: number; z?: number; visibility?: number }>,
): LmPoint[] {
  const cx = (lm[23].x + lm[24].x) / 2;
  const cy = (lm[23].y + lm[24].y) / 2;
  const scale = Math.hypot(lm[0].x - cx, lm[0].y - cy) || 1;
  return KEY_JOINTS_V2.map(j => ({
    x: (lm[j].x - cx) / scale,
    y: (lm[j].y - cy) / scale,
  }));
}

/**
 * V2 特徴ベクトルを抽出 (FEATURE_SIZE_V2 = 102)
 *
 * @param p0      スロット0のポーズ（Leaderとして渡す）
 * @param p1      スロット1のポーズ（Followerとして渡す）
 * @param hist0   p0 の過去フレーム正規化座標（新しい順, 最大5フレーム）
 * @param hist1   p1 の過去フレーム正規化座標（新しい順, 最大5フレーム）
 */
export function extractFeaturesV2(
  p0: Pose,
  p1: Pose,
  hist0: LmPoint[][] = [],
  hist1: LmPoint[][] = [],
): number[] {
  const n0 = normalizeKeyJointsV2(p0.landmarks);
  const n1 = normalizeKeyJointsV2(p1.landmarks);
  const features: number[] = [];

  // 1. 正規化座標 p0 (26)
  for (const pt of n0) { features.push(pt.x, pt.y); }
  // 2. 正規化座標 p1 (26)
  for (const pt of n1) { features.push(pt.x, pt.y); }
  // 3. 相対座標 p0 - p1 (26)
  for (let i = 0; i < KEY_JOINTS_V2.length; i++) {
    features.push(n0[i].x - n1[i].x, n0[i].y - n1[i].y);
  }

  // VEL_JOINTS_V2 の KEY_JOINTS_V2 内インデックスを事前計算
  const velIdx = VEL_JOINTS_V2.map(j => KEY_JOINTS_V2.indexOf(j));

  // 4. 速度 p0（3フレーム前との差分 / 3）(12)
  const prev0 = hist0.length >= 3 ? hist0[2] : null;
  for (const vi of velIdx) {
    features.push(prev0 ? (n0[vi].x - prev0[vi].x) / 3 : 0);
    features.push(prev0 ? (n0[vi].y - prev0[vi].y) / 3 : 0);
  }
  // 5. 速度 p1（3フレーム前との差分 / 3）(12)
  const prev1 = hist1.length >= 3 ? hist1[2] : null;
  for (const vi of velIdx) {
    features.push(prev1 ? (n1[vi].x - prev1[vi].x) / 3 : 0);
    features.push(prev1 ? (n1[vi].y - prev1[vi].y) / 3 : 0);
  }

  return features; // 102
}

/** アノテーション済み JSON から V2 学習データを構築 */
export async function buildTrainingDataV2(
  logs: AnnotatedPoseLog[],
  onProgress?: (done: number, total: number) => void,
): Promise<{
  xs: number[][];
  ys: number[];
  sampleCount: number;
  breakdown: Record<string, number>;
}> {
  const xs: number[][] = [], ys: number[] = [];
  const breakdown: Record<string, number> = {};

  const totalFrames = logs.reduce((s, l) => s + l.frames.length, 0);
  let processed = 0;

  for (const log of logs) {
    const frames = log.frames;
    for (let i = 0; i < frames.length; i++) {
      // 50フレームごとにブラウザに制御を返す
      if (processed % 50 === 0) {
        onProgress?.(processed, totalFrames);
        await new Promise(r => setTimeout(r, 0));
      }
      processed++;

      const frame = frames[i];
      if (!frame.poses || frame.poses.length < 2) continue;
      const [p0, p1] = frame.poses;
      if (!p0?.landmarks || !p1?.landmarks) continue;
      if (p0.landmarks.length < 29 || p1.landmarks.length < 29) continue;

      let leaderIsSlot0: boolean | null = null;
      if (frame.label === 'standard_pos') {
        leaderIsSlot0 = true;
      } else if (frame.label === 'side_L_right') {
        const hx0 = (p0.landmarks[23].x + p0.landmarks[24].x) / 2;
        const hx1 = (p1.landmarks[23].x + p1.landmarks[24].x) / 2;
        leaderIsSlot0 = hx0 > hx1;
      } else if (frame.label === 'side_L_left') {
        const hx0 = (p0.landmarks[23].x + p0.landmarks[24].x) / 2;
        const hx1 = (p1.landmarks[23].x + p1.landmarks[24].x) / 2;
        leaderIsSlot0 = hx0 < hx1;
      }
      if (leaderIsSlot0 === null) continue;

      // 過去3フレームの正規化座標を構築（速度特徴量用）
      const hist0: LmPoint[][] = [];
      const hist1: LmPoint[][] = [];
      for (let h = 1; h <= 3; h++) {
        const fi = i - h;
        if (fi >= 0 && frames[fi].poses?.length >= 2) {
          const pf0 = frames[fi].poses[0];
          const pf1 = frames[fi].poses[1];
          hist0.push(pf0?.landmarks?.length >= 29 ? normalizeKeyJointsV2(pf0.landmarks) : []);
          hist1.push(pf1?.landmarks?.length >= 29 ? normalizeKeyJointsV2(pf1.landmarks) : []);
        } else {
          hist0.push([]); hist1.push([]);
        }
      }

      const [leader, follower] = leaderIsSlot0 ? [p0, p1] : [p1, p0];
      const [lHist, fHist]     = leaderIsSlot0 ? [hist0, hist1] : [hist1, hist0];

      try {
        xs.push(extractFeaturesV2(leader, follower, lHist, fHist)); ys.push(0);
        xs.push(extractFeaturesV2(follower, leader, fHist, lHist)); ys.push(1);
        breakdown[frame.label] = (breakdown[frame.label] ?? 0) + 1;
      } catch { /* 不正なランドマークはスキップ */ }
    }
  }

  return { xs, ys, sampleCount: xs.length, breakdown };
}

/** V2 モデルを作成・学習して LayersModel を返す */
export async function trainModelV2(
  xs: number[][],
  ys: number[],
  onProgress: (epoch: number, total: number, loss: number, acc: number) => void,
  shouldAbort?: () => boolean,
): Promise<LayersModel> {
  const tf = await import('@tensorflow/tfjs');

  const xsTensor = tf.tensor2d(xs, [xs.length, FEATURE_SIZE_V2]);
  const ysTensor = tf.oneHot(tf.tensor1d(ys, 'int32'), 2);

  const model = tf.sequential({
    layers: [
      tf.layers.dense({ inputShape: [FEATURE_SIZE_V2], units: 32, activation: 'relu' }),
      tf.layers.dropout({ rate: 0.25 }),
      tf.layers.dense({ units: 16, activation: 'relu' }),
      tf.layers.dense({ units: 2, activation: 'softmax' }),
    ],
  });

  model.compile({
    optimizer: tf.train.adam(0.002),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy'],
  });

  const epochs = Math.min(60, Math.max(30, Math.floor(xs.length / 10)));

  await model.fit(xsTensor, ysTensor, {
    epochs,
    batchSize: 64,
    shuffle: true,
    validationSplit: 0.1,
    yieldEvery: 'epoch',
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

/** V2 モデルを IndexedDB に保存 */
export async function saveModelV2(model: LayersModel): Promise<void> {
  await model.save(MODEL_KEY_V2);
}

/** IndexedDB から V2 モデルを読み込む（存在しなければ null）*/
export async function loadModelV2(): Promise<LayersModel | null> {
  try {
    const tf = await import('@tensorflow/tfjs');
    return await tf.loadLayersModel(MODEL_KEY_V2) as unknown as LayersModel;
  } catch {
    return null;
  }
}

/** V2 モデルを JSON 文字列にシリアライズ */
export async function modelToJsonV2(model: LayersModel): Promise<string> {
  return modelToJson(model); // 同じシリアライズ処理を流用
}

/** V2 同期推論: poses[0] が Leader である確率 (0–1) を返す */
export function predictLeaderProbSyncV2(
  model: LayersModel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tf: any,
  p0: Pose,
  p1: Pose,
  hist0: LmPoint[][] = [],
  hist1: LmPoint[][] = [],
): number {
  const features = extractFeaturesV2(p0, p1, hist0, hist1);
  let prob = 0.5;
  tf.tidy(() => {
    const input = tf.tensor2d([features], [1, FEATURE_SIZE_V2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (model as any).predict(input) as { dataSync(): Float32Array };
    prob = output.dataSync()[0];
  });
  return prob;
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
