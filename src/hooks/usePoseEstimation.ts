import { useEffect, useRef, useState, useCallback } from 'react';

// @mediapipe/tasks-vision の exports 形式が非標準のため型を自前定義
interface NormalizedLandmark { x: number; y: number; z: number; visibility?: number; }

export type VizMode      = 'off' | 'full' | 'salsa' | 'trail';
export type SalsaStyle   = 'on1' | 'on2';
export type PersonRole   = 'leader' | 'follower' | null;

export interface SequenceEvent {
  id: number;
  time: number;       // video currentTime in seconds
  action: string;     // 'Turn' | 'SideStep' | 'Dip' | 'CBL' | 'Hammerlock' | 'Basic'
  quality: number;    // 0.0 - 1.0
  beatNum?: number;   // 1-8
}

/** フレームごとのスナップショット（デバッグログ用） */
export interface FrameSnapshot {
  frameIndex: number;
  videoTime: number;
  distanceBetweenPersons: number;  // -1 = 1人のみ
  isOccluded: boolean;             // オクルージョン中フラグ
  zOrderFront: number;             // 手前スロットインデックス (-1 = 未判定)
  persons: Array<{
    slotIdx: 0 | 1;
    role: PersonRole;
    hipX: number; hipY: number; hipZ: number;
    velX: number; velY: number;      // 正規化座標/フレーム
    shoulderWidth: number;           // 正規化座標。-1 = 不明
    bodyHeight: number;              // 鼻〜足首中点（正規化）。-1 = 不明
    noseX: number; noseY: number;    // -1 = 不明
    predictedX: number;              // 遮蔽中の予測X (-1 = 通常検出)
    predictedY: number;              // 遮蔽中の予測Y (-1 = 通常検出)
    omega: number;                   // 推定角速度 rad/frame (0 = ターンなし)
    dynamicsScore: number;           // リード動力学スコア（Inception/Centripetal/Space）
  }>;
}

/** Swap & Mark アノテーション */
export interface AnnotationEntry {
  errorFrameIndex: number;
  videoTime: number;
  preSceneData: FrameSnapshot[];    // swap 直前 5フレーム
  postSceneData: FrameSnapshot[];   // swap 直後 5フレーム
  resolvedBy: 'manual_swap';
  salsaStyle: SalsaStyle;
  swapDetail: {
    slot0RoleBefore: PersonRole;
    slot1RoleBefore: PersonRole;
    slot0RoleAfter: PersonRole;
    slot1RoleAfter: PersonRole;
  };
}

/** デバッグパネル用のリアルタイムスロット情報 */
export interface PoseDebugSlot {
  slotIdx: 0 | 1;
  role: PersonRole;
  lockSource: 'face' | 'shr' | null;  // ロール確定の根拠
  dynamicsScore: number;
  omega: number;
  zFront: boolean;
  isDetected: boolean;   // 今フレームで検出できたか
  // ── Cold Start 骨格スコアデバッグ ─────────────────────────────────────
  swh: number;           // 現フレームの ShoulderWidth/BodyHeight（遠近法不変構造比率）
  swhAvg: number;        // プロファイル平均 SW/H（実際のスコアに使われる値）
  avgSW: number;         // プロファイル平均肩幅（shoulderSamples で正規化）
  avgBH: number;         // プロファイル平均身長（sampleCount で正規化）
  shr: number;           // 肩幅 / 腰幅比
  frontalN: number;      // 正面向きフレーム累積数
  profileScore: number;  // profileLeaderScore の現在値（大きい方が Leader）
  profileSamples: number; // プロファイルサンプル数（n: 表示用）
  shoulderSamples: number; // 肩幅が実際に蓄積されたフレーム数
  isFrontal: boolean;    // 現フレームが正面向きか
}

export interface PoseDebugInfo {
  slots: [PoseDebugSlot, PoseDebugSlot];
  isOccluded: boolean;
  zOrderFront: number;   // 手前スロットインデックス (-1 = 未判定)
  profileComplete: boolean;  // 初期骨格判定が完了したか
  genderLocked: boolean;     // ps性別判定ハードロック中か
  manualLocked: boolean;     // 手動 Swap による永続ハードロック中か
  faceLocked: boolean;       // face-api.js 顔性別判定ロック中か
  faceReady: boolean;        // face-api.js モデル読み込み完了か
  faceSuspending: boolean;   // SHR ロックを face 待機でサスペンド中か
}

export interface UsePoseEstimationResult {
  lockAt: (canvasX: number, canvasY: number) => void;
  unlock: () => void;
  isLocked: boolean;
  sequence: SequenceEvent[];
  clearSequence: () => void;
  syncError: boolean;
  clearRoles: () => void;
  roleDetected: boolean;
  swapRoles: () => void;
  annotations: AnnotationEntry[];
  exportDebugLog: (videoName?: string) => void;
  debugInfo: PoseDebugInfo | null;
  roleConfidenceLow: boolean;  // Safety Guard: 初期判定の確信度が低い（動き出し優先）
}

// ── 定数 ─────────────────────────────────────────────────────────────────

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const NUM_POSES     = 5;
const VIS_THRESHOLD = 0.5;   // landmark の visibility チェック閾値（描画用）
// ペアワークで密着・オクルージョンが多いため検出閾値は低めに設定
const DETECT_CONFIDENCE = 0.2;  // minPoseDetectionConfidence（2人目の部分オクルージョンに対応）
const PRESENCE_CONFIDENCE = 0.2; // minPosePresenceConfidence
const TRACKING_CONFIDENCE = 0.2; // minTrackingConfidence

// 適応型サンプリング
const DETECT_FAST   = 33;    // ~30fps（動きが速いとき）
const DETECT_SLOW   = 100;   // ~10fps（静止時）
const MOVEMENT_TH   = 0.015; // 正規化座標での閾値

// ターゲット追跡
const TRAIL_LENGTH  = 10;    // 足首軌跡のフレーム数
const OCCLUSION_MAX = 12;    // オクルージョン時の最大予測フレーム数

// パターン検出
const COOLDOWN_SEC  = 1.5;   // 同じアクション間の最小インターバル（秒）

// ── 型 ───────────────────────────────────────────────────────────────────

type Connection  = { start: number; end: number };
type Letterbox   = { offsetX: number; offsetY: number; renderW: number; renderH: number };
type Centroid    = { x: number; y: number };
type VelocityVec = { vx: number; vy: number };
type AnkleFrame  = { lx: number; ly: number; rx: number; ry: number };
type DrawColors  = { line: string; joint: string; lw: number; jr: number };

/** 個人の体格プロファイル（プロファイリング期間中に蓄積） */
interface PersonProfile {
  totalHeight: number;            // 鼻〜足首中点の2D累積（生値）
  totalNormHeight: number;        // パース補正済み身長の累積
  totalHeadBodyRatio: number;     // (鼻〜足首) / (耳幅) の累積 — パース不変量
  totalShoulderWidth: number;     // 肩幅の累積
  shoulderSamples: number;        // 肩幅を蓄積できたフレーム数（sampleCountと別管理）
  totalHipWidth: number;          // 腰幅の累積
  hipSamples: number;             // 腰幅を蓄積できたフレーム数（sampleCountと別管理）
  maxShoulderX: number;           // 最大2D X肩幅（Zノイズなし、正面向き時のベスト値）
  maxHipX: number;                // 最大2D X腰幅（Zノイズなし）
  totalEarWidth: number;          // 耳幅（lm[7]〜lm[8]）の累積 — 顔幅の代理指標
  totalHeadTriangleArea: number;  // 鼻-左耳-右耳 三角形面積の累積（Hair & Head Volume）
  coldPrepLeader: number;         // 準備動作: 足首固定+腰/肩先行フレーム数
  coldPrepFollower: number;       // 準備動作: 垂直ヒップ振動フレーム数
  // ── 正面向きフレームのみ蓄積（遠近法不変量）─────────────────────────────
  frontalShoulderWidth: number;  // 正面向き時の肩幅累積
  frontalHipWidth: number;       // 正面向き時の腰幅累積（SHR計算に使用）
  frontalBodyHeight: number;     // 正面向き時の身長（鼻〜足首）累積
  frontalSampleCount: number;    // 正面向きフレーム数（SW+HW+BH 全て有効なフレーム）
  sampleCount: number;           // 有効サンプル数（鼻+足首が見えたフレーム）
  ratioSamples: number;          // headBodyRatio の有効サンプル数
}
const makeProfile = (): PersonProfile => ({
  totalHeight: 0, totalNormHeight: 0, totalHeadBodyRatio: 0,
  totalShoulderWidth: 0, shoulderSamples: 0,
  totalHipWidth: 0, hipSamples: 0,
  maxShoulderX: 0, maxHipX: 0,
  totalEarWidth: 0,
  totalHeadTriangleArea: 0, coldPrepLeader: 0, coldPrepFollower: 0,
  frontalShoulderWidth: 0, frontalHipWidth: 0, frontalBodyHeight: 0, frontalSampleCount: 0,
  sampleCount: 0, ratioSamples: 0,
});

type RoleSlot = {
  hip:      Centroid | null;
  hipZ:     number;
  role:     PersonRole;
  xHistory: number[];
  staleness: number;
  nose:     Centroid | null;  // 顔アンカー（Re-ID用）
  velX:     number;           // 直前フレームの腰速度（オクルージョン予測用）
  velY:     number;
  profile:  PersonProfile;    // 体格プロファイル
  // ── 物理ステートマシン ───────────────────────────────────
  zFront:       boolean;        // カメラに近い方（遮蔽判定）
  omegaHist:    number[];       // raw X座標履歴（角速度推定用、最大OMEGA_HIST_LEN）
  omega:        number;         // 推定角速度（rad/frame）
  angPhase:     number;         // 現在の位相（ラジアン）
  angCenter:    number;         // X振動の中心
  angAmplitude: number;         // X振動の振幅
  phantomPos:   Centroid | null; // 遮蔽中の予測座標
  // ── ダンス動力学 ─────────────────────────────────────────
  dynamicsScore:    number;     // リード動力学スコア（正=Leader的）減衰付き累積
  wristPrev:        { mx: number; my: number } | null; // 前フレームの手首中点
  wristVel:         number;     // 手首速度大きさ（正規化座標/frame）
  wasMoving:        boolean;    // 前フレームの手首運動状態
  motionOnsetFrame: number;     // 直近の動き出しフレームインデックス（-1 = 未検出）
  // ── Cold Start 準備動作検出 ──────────────────────────────
  coldFrameCount:   number;     // Cold Start 蓄積フレーム数
  prevAnkleMid:     Centroid | null; // 前フレームの足首中点（準備動作検出用）
  detectedIdx:      number;     // 今フレームで対応する all[] のインデックス（-1 = 未検出）
  lockSource:       'face' | 'shr' | null; // ロール確定の根拠
};

// ── ロール描画カラー ──────────────────────────────────────────────────────
const COLOR_LEADER:   DrawColors = { line: '#0066ff', joint: '#66aaff', lw: 3,   jr: 5 };
const COLOR_FOLLOWER: DrawColors = { line: '#ff00cc', joint: '#ff66ee', lw: 3,   jr: 5 };
const COLOR_MAIN:     DrawColors = { line: 'rgba(255,60,60,0.95)',   joint: 'rgba(255,210,50,0.95)', lw: 3,   jr: 5 };
const COLOR_OTHER:    DrawColors = { line: 'rgba(255,255,255,0.45)', joint: 'rgba(200,200,200,0.50)', lw: 1.5, jr: 3 };

// ── ロール検出定数 ────────────────────────────────────────────────────────
const ROLE_MATCH_DIST   = 0.55;  // スロットマッチング距離閾値
const FACE_MATCH_DIST   = 0.40;  // 顔アンカーマッチング距離閾値
const NOSE_SEP_MIN      = 0.08;  // 顔が独立していると見なす最小距離
const PHASE_WINDOW      = 6;     // 位相モニタリングウィンドウ（サンプル数）
const SLOT_STALE_FRAMES = 20;    // この連続フレーム数途切れたらスロット位置をリセット
const PROFILE_FRAMES    = 8;     // 体格プロファイリング期間（フレーム数）— 3D計測で早期確定
const OCCLUSION_DIST    = 0.18;  // オクルージョン判定距離（正規化座標）
// 合成人体フィルタ定数（同色衣装で2人が1体として誤検出されるケースを除去）
const MAX_BODY_HEIGHT   = 0.72;  // 正規化座標での最大有効体長（これ以上は合成人体）
const MIN_UL_RATIO      = 0.22;  // 上半身/下半身比の最小値
const MAX_UL_RATIO      = 4.5;   // 上半身/下半身比の最大値
const FRAME_BUFFER_SIZE = 90;    // フレームバッファサイズ（~3秒分）
const POST_SCENE_FRAMES = 5;     // Swap後に収集するフレーム数
// ── Cold Start 定数 ───────────────────────────────────────────────────────
// 判定基準参考値: 男性(Leader)のSHR > 1.10, 女性(Follower)のSHR < 1.05
const ANKLE_STILL_THRESH      = 0.008; // 準備動作: 足首静止判定閾値（正規化座標/frame）
const HIP_MOVE_THRESH         = 0.008; // 準備動作: 腰先行判定閾値（正規化座標/frame）
const FRONTAL_SHOULDER_Z_THRESH = 0.08; // 肩の Z 差がこれ未満 = 正面向き（遠近法不変）
const MIN_FRONTAL_SAMPLES     = 3;     // 正面データ優先に必要な最小サンプル数

// ── ダンス動力学（Dynamics）定数 ─────────────────────────────────────────
const INCEPTION_VEL_THRESHOLD    = 0.012; // 先行動作の動き出し速度閾値（正規化座標/frame）
const INCEPTION_FRAME_WINDOW     = 4;     // 先行動作として認める最大フレーム差（~130ms @ 30fps）
const INCEPTION_SCORE            = 0.5;   // Inception 検知スコア加算量
const CENTRIPETAL_SCORE          = 0.12;  // 向心力スコア（ターン中毎フレーム加算）
const SPACE_SCORE                = 0.7;   // スペース管理スコア（オクルージョン直前）
const DYNAMICS_DECAY             = 0.993; // スコア減衰係数（毎フレーム; ~100f で半減）
// DYNAMICS_WEIGHT は第0原則により性別判定には使用しない（dynamicsScore は別用途で継続計算）

// ── 物理ステートマシン定数 ────────────────────────────────────────────────
const OMEGA_HIST_LEN = 90;  // 角速度推定用 X履歴フレーム数（~3秒 @ 30fps）

// ── ハイブリッドアーキテクチャ定数 ──────────────────────────────────────────
// iOS Safari は Worker 内 WebGL が利用不可 → メインスレッド専用
const IS_IOS = typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const SLOW_RATE_THRESHOLD = 0.5;  // この再生速度以下で2パスカスケード有効（iOS）
const CACHE_MAX_FRAMES    = 600;  // analysisCache 最大フレーム数（~20秒 @ 30fps）
const CACHE_TIME_TOL      = 0.5;  // キャッシュ検索の時間許容幅（秒）

// ── face-api.js 顔性別判定 ──────────────────────────────────────────────────
const FACE_GENDER_CONFIDENCE = 0.90; // 顔性別判定の確信度閾値（これ以上でロール確定）
const FACE_SCAN_INTERVAL_MS  = 500;  // 顔スキャン間隔（ms）— 重い処理なので2fps
const FACE_SCAN_SUSPEND_MS   = 15000; // init 開始後この時間は SHR ロックを待機（face 優先）— iOS CDN+モデルロードに最大13秒かかるため
const FACE_ROI_EAR_MULT      = 2.5;  // ROI半径 = 耳幅 × 2.5（1フレーム遅れでも顔がはみ出さないマージン）

// MediaPipe Pose の33点接続（PC Worker モードで PoseLandmarker import を省略するため定数化）
const POSE_CONNECTIONS: Connection[] = [
  { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 7 },
  { start: 0, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 6 }, { start: 6, end: 8 },
  { start: 9, end: 10 },
  { start: 11, end: 12 }, { start: 11, end: 13 }, { start: 13, end: 15 },
  { start: 15, end: 17 }, { start: 15, end: 19 }, { start: 15, end: 21 }, { start: 17, end: 19 },
  { start: 12, end: 14 }, { start: 14, end: 16 }, { start: 16, end: 18 },
  { start: 16, end: 20 }, { start: 16, end: 22 }, { start: 18, end: 20 },
  { start: 11, end: 23 }, { start: 12, end: 24 }, { start: 23, end: 24 },
  { start: 23, end: 25 }, { start: 24, end: 26 }, { start: 25, end: 27 },
  { start: 26, end: 28 }, { start: 27, end: 29 }, { start: 28, end: 30 },
  { start: 29, end: 31 }, { start: 30, end: 32 }, { start: 27, end: 31 }, { start: 28, end: 32 },
];

/**
 * face-api.js ROI 計算
 * nose を中心に、耳幅 × roiMult（デフォルト 2.5）のサイズで顔クロップ範囲を返す。
 * 鼻は顔の下寄りなので、上方向に 1.3、下方向に 0.7 の非対称マージンを設ける。
 */
function computeFaceROI(
  nose: Centroid,
  lm: NormalizedLandmark[] | null,
  vw: number, vh: number,
  roiMult: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  let halfW: number;
  if (lm) {
    const lEar = lm[7], rEar = lm[8];
    if (lEar && rEar && (lEar.visibility ?? 1) >= VIS_THRESHOLD && (rEar.visibility ?? 1) >= VIS_THRESHOLD) {
      const earPx = Math.hypot(rEar.x - lEar.x, rEar.y - lEar.y) * vw;
      halfW = (earPx * roiMult) / 2;
    } else {
      const lSh = lm[11], rSh = lm[12];
      if (lSh && rSh && (lSh.visibility ?? 1) >= VIS_THRESHOLD && (rSh.visibility ?? 1) >= VIS_THRESHOLD) {
        halfW = Math.abs(rSh.x - lSh.x) * vw * 0.4;
      } else {
        halfW = vw * 0.13;
      }
    }
  } else {
    halfW = vw * 0.13;
  }
  halfW = Math.max(halfW, 40); // 最小 40px
  const cx = nose.x * vw;
  const cy = nose.y * vh;
  const sx = Math.max(0, Math.round(cx - halfW));
  const sy = Math.max(0, Math.round(cy - halfW * 1.3)); // 鼻より上（額・頭頂）に広め
  const ex = Math.min(vw, Math.round(cx + halfW));
  const ey = Math.min(vh, Math.round(cy + halfW * 0.7)); // 鼻より下（顎）は控えめ
  if (ex - sx < 20 || ey - sy < 20) return null;
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

/** face-api.js を CDN <script> タグで動的ロード（Rollup バンドル対象外）*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFaceApiFromCDN(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).faceapi) return Promise.resolve((window as any).faceapi);
  return new Promise<unknown>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    script.onload = () => resolve((window as any).faceapi);
    script.onerror = (e) => reject(e);
    document.head.appendChild(script);
  });
}

/** analysisCache: スロー再生中の検出結果を保存し通常速度で再生する */
type CachedResult = { time: number; landmarks: NormalizedLandmark[][] };

/** face-api.js 顔性別スキャン結果（1フレーム分） */
type FaceScanResult = {
  normX: number;   // 正規化顔中心 X
  normY: number;   // 正規化顔中心 Y
  gender: 'male' | 'female';
  genderProb: number;
};

/** face-api.js 顔バウンディングボックス（可視化用・信頼度問わず全検出） */
type FaceVisualization = {
  normX: number; normY: number;   // bbox 左上（正規化）
  normW: number; normH: number;   // bbox サイズ（正規化）
  gender: string;
  prob: number;
};

interface PatternDetectionState {
  turnFrames: number;
  sideFrames: number;
  dipFrames: number;
  cblFrames: number;
  hammerFrames: number;
  baseShoulderSpan: number;   // -1 = not initialized
  baseHipX: number;           // -1 = not initialized
  lastEventTime: Record<string, number>;  // action → last video time
}

function makeInitialPatternState(): PatternDetectionState {
  return {
    turnFrames: 0,
    sideFrames: 0,
    dipFrames: 0,
    cblFrames: 0,
    hammerFrames: 0,
    baseShoulderSpan: -1,
    baseHipX: -1,
    lastEventTime: {},
  };
}

function runPatternDetection(
  lm: NormalizedLandmark[],
  videoTime: number,
  bpmVal: number,
  state: PatternDetectionState,
  emit: (action: string, quality: number, beatNum: number | undefined) => void,
) {
  const beatNum = bpmVal > 0
    ? Math.floor((videoTime * bpmVal / 60) % 8) + 1
    : undefined;

  const canEmit = (action: string) => {
    const last = state.lastEventTime[action] ?? -Infinity;
    return videoTime - last >= COOLDOWN_SEC;
  };

  const doEmit = (action: string, quality: number) => {
    state.lastEventTime[action] = videoTime;
    emit(action, quality, beatNum);
  };

  // Key landmarks
  const nose = lm[0];
  const sL   = lm[11];  // left shoulder
  const sR   = lm[12];  // right shoulder
  const hL   = lm[23];  // left hip
  const hR   = lm[24];  // right hip
  const aL   = lm[27];  // left ankle
  const aR   = lm[28];  // right ankle
  const elbowR  = lm[14]; // right elbow
  const wristR  = lm[16]; // right wrist
  const shoulderR = lm[12]; // right shoulder (same as sR)

  const hasVis = (landmark: NormalizedLandmark | undefined) =>
    landmark !== undefined && (landmark.visibility ?? 1) >= VIS_THRESHOLD;

  // Hip mid-point
  const hipMidX = hasVis(hL) && hasVis(hR)
    ? (hL.x + hR.x) / 2
    : hasVis(hL) ? hL.x : hasVis(hR) ? hR.x : null;
  const hipMidY = hasVis(hL) && hasVis(hR)
    ? (hL.y + hR.y) / 2
    : hasVis(hL) ? hL.y : hasVis(hR) ? hR.y : null;

  // ── 1. Turn detection ────────────────────────────────────────────────
  if (hasVis(sL) && hasVis(sR)) {
    const shoulderSpan = Math.abs(sR.x - sL.x);

    if (state.baseShoulderSpan < 0) {
      state.baseShoulderSpan = shoulderSpan;
    }

    const isTurning = shoulderSpan < state.baseShoulderSpan * 0.40;

    if (isTurning) {
      state.turnFrames++;
      if (state.turnFrames >= 4 && canEmit('Turn')) {
        const quality = Math.min(1, 0.5 + state.turnFrames * 0.05);
        doEmit('Turn', quality);
        state.turnFrames = 0;
      }
    } else {
      state.turnFrames = 0;
      // Slowly update baseline when not turning
      state.baseShoulderSpan = state.baseShoulderSpan * 0.95 + shoulderSpan * 0.05;
    }
  }

  // ── 2. SideStep detection ─────────────────────────────────────────────
  if (hipMidX !== null && hasVis(aL) && hasVis(aR)) {
    const hipX = hipMidX;
    const maxDev = Math.max(Math.abs(aL.x - hipX), Math.abs(aR.x - hipX));

    if (maxDev > 0.20) {
      state.sideFrames++;
      if (state.sideFrames >= 3 && canEmit('SideStep')) {
        doEmit('SideStep', 0.7);
        state.sideFrames = 0;
      }
    } else {
      state.sideFrames = 0;
    }
  }

  // ── 3. Dip detection ──────────────────────────────────────────────────
  if (nose && hasVis(nose) && hipMidY !== null) {
    // In MediaPipe normalized coords, higher Y = lower on screen
    if (nose.y > hipMidY + 0.05) {
      state.dipFrames++;
      if (state.dipFrames >= 5 && canEmit('Dip')) {
        const quality = Math.min(1, 0.6 + state.dipFrames * 0.04);
        doEmit('Dip', quality);
        state.dipFrames = 0;
      }
    } else {
      state.dipFrames = 0;
    }
  }

  // ── 4. CBL (Cross Body Lead) detection ───────────────────────────────
  if (hipMidX !== null) {
    const hipX = hipMidX;

    if (state.baseHipX < 0) {
      state.baseHipX = hipX;
    }

    const hipShift = Math.abs(hipX - state.baseHipX);

    if (hipShift > 0.20) {
      state.cblFrames++;
      if (state.cblFrames >= 5 && canEmit('CBL')) {
        doEmit('CBL', 0.65);
        state.cblFrames = 0;
        state.baseHipX = hipX; // reset baseline after emit
      }
    } else {
      state.cblFrames = 0;
      // Slowly update baseHipX when stable
      state.baseHipX = state.baseHipX * 0.98 + hipX * 0.02;
    }
  }

  // ── 5. Hammerlock detection ──────────────────────────────────────────
  if (hasVis(shoulderR) && hasVis(elbowR) && hasVis(wristR) && hipMidY !== null) {
    // Calculate angle at right elbow (landmarks 12, 14, 16)
    const ax = shoulderR.x - elbowR.x;
    const ay = shoulderR.y - elbowR.y;
    const bx = wristR.x - elbowR.x;
    const by = wristR.y - elbowR.y;
    const dot = ax * bx + ay * by;
    const magA = Math.hypot(ax, ay);
    const magB = Math.hypot(bx, by);
    const elbowAngle = magA > 0 && magB > 0
      ? Math.acos(Math.max(-1, Math.min(1, dot / (magA * magB)))) * 180 / Math.PI
      : 180;

    const isHammer = elbowAngle < 70 && wristR.y > hipMidY;

    if (isHammer) {
      state.hammerFrames++;
      if (state.hammerFrames >= 4 && canEmit('Hammerlock')) {
        const quality = Math.min(1, 0.5 + state.hammerFrames * 0.05);
        doEmit('Hammerlock', quality);
        state.hammerFrames = 0;
      }
    } else {
      state.hammerFrames = 0;
    }
  }
}

// ── letterbox 計算（object-fit: contain 相当） ────────────────────────────

function computeLetterbox(cw: number, ch: number, vw: number, vh: number): Letterbox {
  if (vw <= 0 || vh <= 0) return { offsetX: 0, offsetY: 0, renderW: cw, renderH: ch };
  const cAR = cw / ch;
  const vAR = vw / vh;
  if (vAR > cAR) {
    const renderH = cw / vAR;
    return { offsetX: 0, offsetY: (ch - renderH) / 2, renderW: cw, renderH };
  }
  const renderW = ch * vAR;
  return { offsetX: (cw - renderW) / 2, offsetY: 0, renderW, renderH: ch };
}

// ── ユーティリティ ────────────────────────────────────────────────────────

function computeCentroid(landmarks: NormalizedLandmark[]): Centroid | null {
  const vis = landmarks.filter(lm => (lm.visibility ?? 1) >= VIS_THRESHOLD);
  if (!vis.length) return null;
  return {
    x: vis.reduce((s, l) => s + l.x, 0) / vis.length,
    y: vis.reduce((s, l) => s + l.y, 0) / vis.length,
  };
}

function computeMidHip(landmarks: NormalizedLandmark[]): Centroid | null {
  const hL = landmarks[23], hR = landmarks[24];
  if (!hL && !hR) return null;
  const lv = hL ? (hL.visibility ?? 1) : 0;
  const rv = hR ? (hR.visibility ?? 1) : 0;
  if (lv >= VIS_THRESHOLD && rv >= VIS_THRESHOLD) return { x: (hL.x + hR.x) / 2, y: (hL.y + hR.y) / 2 };
  if (lv >= VIS_THRESHOLD) return { x: hL.x, y: hL.y };
  if (rv >= VIS_THRESHOLD) return { x: hR.x, y: hR.y };
  return computeCentroid(landmarks);
}

/** 垂直軸からの傾き角度（左傾: 負、右傾: 正）*/
function tiltAngleDeg(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(bx - ax, by - ay) * 180 / Math.PI;
}

/** 水平軸からの傾き角度 */
function horzAngleDeg(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
}

function findMainPersonIndex(landmarksArray: NormalizedLandmark[][]): number {
  let minDist = Infinity, idx = 0;
  for (let i = 0; i < landmarksArray.length; i++) {
    const c = computeCentroid(landmarksArray[i]);
    if (!c) continue;
    const d = Math.hypot(c.x - 0.5, c.y - 0.5);
    if (d < minDist) { minDist = d; idx = i; }
  }
  return idx;
}

interface TrackResult { idx: number; dist: number; hip: Centroid | null }

/** 速度予測付きの最近傍探索（Mid-Hip ベース） */
function findNearestToTarget(
  landmarksArray: NormalizedLandmark[][],
  lastHip: Centroid,
  vel: VelocityVec,
  occlusionFrames: number,
): TrackResult {
  // オクルージョン中は速度ベクトルで位置を予測
  const search: Centroid = occlusionFrames > 0
    ? { x: lastHip.x + vel.vx * occlusionFrames, y: lastHip.y + vel.vy * occlusionFrames }
    : lastHip;

  let minDist = Infinity, nearest = 0, nearestHip: Centroid | null = null;
  for (let i = 0; i < landmarksArray.length; i++) {
    const hip = computeMidHip(landmarksArray[i]);
    if (!hip) continue;
    const dist = Math.hypot(hip.x - search.x, hip.y - search.y);
    if (dist < minDist) { minDist = dist; nearest = i; nearestHip = hip; }
  }
  return { idx: nearest, dist: minDist, hip: nearestHip };
}

// ── テキストをミラー補正して描画するヘルパー ─────────────────────────────

function fillTextMirrorSafe(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  cw: number,
  mirrored: boolean,
) {
  ctx.save();
  if (mirrored) {
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
    ctx.fillText(text, cw - x, y);
  } else {
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

// ── ロール → 描画カラー ────────────────────────────────────────────────────

function getRoleColors(role: PersonRole, isMain: boolean): DrawColors {
  if (role === 'leader')   return COLOR_LEADER;
  if (role === 'follower') return COLOR_FOLLOWER;
  return isMain ? COLOR_MAIN : COLOR_OTHER;
}

// ── Draw: Full モード（全身33点） ─────────────────────────────────────────

function drawFullPerson(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  connections: Connection[],
  lb: Letterbox,
  dc: DrawColors,
) {
  const toC = (lm: NormalizedLandmark) => ({ x: lb.offsetX + lm.x * lb.renderW, y: lb.offsetY + lm.y * lb.renderH });

  ctx.strokeStyle = dc.line; ctx.lineWidth = dc.lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const { start, end } of connections) {
    const a = landmarks[start], b = landmarks[end];
    if (!a || !b || (a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    const pA = toC(a), pB = toC(b);
    ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
  }
  ctx.fillStyle = dc.joint;
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    const p = toC(lm);
    ctx.beginPath(); ctx.arc(p.x, p.y, dc.jr, 0, Math.PI * 2); ctx.fill();
  }
}

// ── Draw: Salsa Focus モード（軸傾き・肩腰水平角度付き） ─────────────────

function drawSalsaPerson(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  lb: Letterbox,
  isMain: boolean,
  cw: number,
  mirrored: boolean,
) {
  const op      = isMain ? 1.0 : 0.35;
  const axisC   = `rgba(255,235,0,${op})`;
  const hLineC  = `rgba(0,220,220,${op})`;
  const dotC    = `rgba(255,235,0,${isMain ? 0.95 : 0.40})`;
  const axisW   = isMain ? 4.5 : 2;
  const hW      = isMain ? 3.5 : 1.5;
  const dotR    = isMain ? 6 : 3;

  const toC = (lm: NormalizedLandmark) => ({ x: lb.offsetX + lm.x * lb.renderW, y: lb.offsetY + lm.y * lb.renderH });
  const midLm = (a: NormalizedLandmark, b: NormalizedLandmark): NormalizedLandmark => ({
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  });

  const nose = landmarks[0], sL = landmarks[11], sR = landmarks[12];
  const hL = landmarks[23], hR = landmarks[24], aL = landmarks[27], aR = landmarks[28];
  if (!nose || !sL || !sR || !hL || !hR || !aL || !aR) return;

  const hipMid = midLm(hL, hR), ankleMid = midLm(aL, aR);

  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // 垂直中心軸（ネオンイエロー）
  ctx.strokeStyle = axisC; ctx.lineWidth = axisW;
  for (const [a, b] of [[nose, hipMid], [hipMid, ankleMid]] as [NormalizedLandmark, NormalizedLandmark][]) {
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    ctx.beginPath(); ctx.moveTo(toC(a).x, toC(a).y); ctx.lineTo(toC(b).x, toC(b).y); ctx.stroke();
  }

  // 水平ライン（シアン）
  ctx.strokeStyle = hLineC; ctx.lineWidth = hW;
  for (const [a, b] of [[sL, sR], [hL, hR]] as [NormalizedLandmark, NormalizedLandmark][]) {
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    ctx.beginPath(); ctx.moveTo(toC(a).x, toC(a).y); ctx.lineTo(toC(b).x, toC(b).y); ctx.stroke();
  }

  // キーポイントドット
  ctx.fillStyle = dotC;
  for (const lm of [nose, sL, sR, hL, hR, aL, aR, hipMid, ankleMid]) {
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    const p = toC(lm);
    ctx.beginPath(); ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2); ctx.fill();
  }

  // ── メインのみ：角度テキスト（ミラー補正あり）
  if (isMain) {
    ctx.save();
    ctx.font = 'bold 11px monospace';
    ctx.shadowColor = 'black'; ctx.shadowBlur = 3;

    const pHip = toC(hipMid);
    const pSL = toC(sL);
    const pHL = toC(hL);

    const noseVis = (nose.visibility ?? 1) >= VIS_THRESHOLD;
    const hipMidVis = (hipMid.visibility ?? 1) >= VIS_THRESHOLD;
    const sLv = (sL.visibility ?? 1) >= VIS_THRESHOLD;
    const sRv = (sR.visibility ?? 1) >= VIS_THRESHOLD;
    const hLv = (hL.visibility ?? 1) >= VIS_THRESHOLD;
    const hRv = (hR.visibility ?? 1) >= VIS_THRESHOLD;

    if (noseVis && hipMidVis) {
      const angle = tiltAngleDeg(nose.x, nose.y, hipMid.x, hipMid.y);
      ctx.fillStyle = 'rgba(255,235,0,0.95)';
      fillTextMirrorSafe(ctx, `軸 ${angle >= 0 ? '+' : ''}${angle.toFixed(1)}°`, pHip.x + 14, pHip.y, cw, mirrored);
    }
    if (sLv && sRv) {
      const a = horzAngleDeg(sL.x, sL.y, sR.x, sR.y);
      ctx.fillStyle = 'rgba(0,220,220,0.95)';
      fillTextMirrorSafe(ctx, `肩 ${a >= 0 ? '+' : ''}${a.toFixed(1)}°`, pSL.x, pSL.y - 8, cw, mirrored);
    }
    if (hLv && hRv) {
      const a = horzAngleDeg(hL.x, hL.y, hR.x, hR.y);
      ctx.fillStyle = 'rgba(0,220,220,0.95)';
      fillTextMirrorSafe(ctx, `腰 ${a >= 0 ? '+' : ''}${a.toFixed(1)}°`, pHL.x, pHL.y + 16, cw, mirrored);
    }
    ctx.restore();
  }
}

// ── Draw: Step Trail モード ────────────────────────────────────────────────

function drawStepTrail(
  ctx: CanvasRenderingContext2D,
  history: AnkleFrame[],
  lb: Letterbox,
  isMain: boolean,
) {
  if (!history.length) return;
  const n = history.length;
  const alpha = isMain ? 1.0 : 0.45;

  for (let side = 0; side < 2; side++) {
    const [rr, gg, bb] = side === 0 ? [80, 200, 255] : [255, 180, 30];

    // 軌跡ライン
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const f = history[i];
      const nx = side === 0 ? f.lx : f.rx;
      const ny = side === 0 ? f.ly : f.ry;
      if (nx < 0) continue;
      const px = lb.offsetX + nx * lb.renderW, py = lb.offsetY + ny * lb.renderH;
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = `rgba(${rr},${gg},${bb},${0.45 * alpha})`;
    ctx.lineWidth = isMain ? 2 : 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();

    // ドット（新しいほど大きく明るく）
    for (let i = 0; i < n; i++) {
      const f = history[i];
      const nx = side === 0 ? f.lx : f.rx;
      const ny = side === 0 ? f.ly : f.ry;
      if (nx < 0) continue;
      const px = lb.offsetX + nx * lb.renderW, py = lb.offsetY + ny * lb.renderH;
      const ageFrac = i / Math.max(n - 1, 1); // 0=最古, 1=最新
      const r = 2 + ageFrac * (isMain ? 7 : 4);
      const a = (0.1 + ageFrac * 0.9) * alpha;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rr},${gg},${bb},${a})`;
      ctx.fill();
    }
  }
}

// ── Draw: ターゲットインジケーター（足元の照準） ─────────────────────────

function drawTargetIndicator(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  lb: Letterbox,
) {
  const ankleL = landmarks[27], ankleR = landmarks[28];
  if (!ankleL && !ankleR) return;
  const lv = ankleL && (ankleL.visibility ?? 1) >= VIS_THRESHOLD;
  const rv = ankleR && (ankleR.visibility ?? 1) >= VIS_THRESHOLD;
  let footX: number, footY: number;
  if (lv && rv) { footX = (ankleL.x + ankleR.x) / 2; footY = Math.max(ankleL.y, ankleR.y); }
  else if (lv)  { footX = ankleL.x; footY = ankleL.y; }
  else if (rv)  { footX = ankleR.x; footY = ankleR.y; }
  else return;

  const px = lb.offsetX + footX * lb.renderW, py = lb.offsetY + footY * lb.renderH + 18;
  const r = 14;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,120,0,0.95)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,120,0,0.18)'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,120,0,0.95)'; ctx.fill();
  for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]] as [number, number][]) {
    ctx.beginPath();
    ctx.moveTo(px + dx * (r + 1), py + dy * (r + 1));
    ctx.lineTo(px + dx * (r + 5), py + dy * (r + 5)); ctx.stroke();
  }
  ctx.restore();
}

// ── Draw: ビートフェーズインジケーター ───────────────────────────────────

function drawBeatIndicator(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  bpm: number,
  currentTime: number,
  mirrored: boolean,
) {
  if (bpm <= 0) return;
  const totalBeats  = currentTime * bpm / 60;
  const beatInMeasure = totalBeats % 8;
  const beatNum    = Math.floor(beatInMeasure) + 1;
  const beatFrac   = beatInMeasure % 1;
  const isAccent   = beatNum === 1 || beatNum === 5;

  const x = 10, y = ch - 26;
  const bw = 76, bh = 5;

  ctx.save();
  ctx.shadowColor = 'black'; ctx.shadowBlur = 4;
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = isAccent ? 'rgba(255,80,80,0.95)' : 'rgba(255,255,100,0.85)';
  fillTextMirrorSafe(ctx, `♩ ${beatNum}/8`, x, y, cw, mirrored);

  // Progress bar
  ctx.shadowBlur = 0;
  const barX = mirrored ? (cw - x - bw) : x;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(barX, y + 5, bw, bh);
  ctx.fillStyle = isAccent ? 'rgba(255,80,80,0.9)' : 'rgba(255,220,50,0.9)';
  if (mirrored) {
    ctx.fillRect(barX + bw * (1 - beatFrac), y + 5, bw * beatFrac, bh);
  } else {
    ctx.fillRect(barX, y + 5, bw * beatFrac, bh);
  }
  ctx.restore();
}

// ── Draw: デバッグオーバーレイ（ロック中のみ） ───────────────────────────

function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  tapPos: { x: number; y: number } | null,
  lockedHip: Centroid | null,
  dist: number,
  occlusionFrames: number,
  personCount: number,
  lb: Letterbox,
  cw: number,
  mirrored: boolean,
) {
  // 赤い点：タップした位置
  if (tapPos) {
    ctx.save();
    ctx.beginPath(); ctx.arc(tapPos.x, tapPos.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,0,0,0.85)'; ctx.fill();
    ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }

  // 青い大きな丸：ロック中の腰
  if (lockedHip) {
    const px = lb.offsetX + lockedHip.x * lb.renderW;
    const py = lb.offsetY + lockedHip.y * lb.renderH;
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(30,120,255,0.95)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.fillStyle = 'rgba(30,120,255,0.25)'; ctx.fill();
    ctx.restore();
  }

  // テキスト情報
  const occStr = occlusionFrames > 0 ? ` occ:${occlusionFrames}` : '';
  ctx.save();
  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = 'rgba(255,255,60,0.95)';
  ctx.shadowColor = 'black'; ctx.shadowBlur = 4;
  fillTextMirrorSafe(ctx, `dist:${dist.toFixed(3)} n:${personCount}${occStr}`, 8, 20, cw, mirrored);
  if (lockedHip) {
    fillTextMirrorSafe(ctx, `hip(${lockedHip.x.toFixed(2)}, ${lockedHip.y.toFixed(2)})`, 8, 36, cw, mirrored);
  }
  ctx.restore();
}

// ── Draw: ロールバッジ（LEADER / FOLLOWER ラベル） ───────────────────────

function drawRoleBadge(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  lb: Letterbox,
  role: PersonRole,
  cw: number,
  mirrored: boolean,
) {
  if (!role) return;
  const nose = landmarks[0];
  if (!nose || (nose.visibility ?? 1) < VIS_THRESHOLD) return;
  const px = lb.offsetX + nose.x * lb.renderW;
  const py = lb.offsetY + nose.y * lb.renderH - 24;
  const color = role === 'leader' ? '#0066ff' : '#ff00cc';
  const label = role === 'leader' ? 'LEADER' : 'FOLLOWER';
  ctx.save();
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = color;
  ctx.shadowColor = 'black';
  ctx.shadowBlur = 4;
  fillTextMirrorSafe(ctx, label, px, py, cw, mirrored);
  ctx.restore();
}

// ── Draw: face-api ステータスバッジ ──────────────────────────────────────

function drawFaceStatusBadge(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  lb: Letterbox,
  cw: number,
  mirrored: boolean,
  faceStatus: 'loading' | 'scanning' | 'locked',
  lastConf: number,       // -1 = 未取得
  lastMatchMsAgo: number, // -1 = 一度も見ていない
  syncOk: boolean | null, // null = 不明
) {
  const nose = landmarks[0];
  if (!nose || (nose.visibility ?? 1) < VIS_THRESHOLD) return;
  const px = lb.offsetX + nose.x * lb.renderW;
  const py = lb.offsetY + nose.y * lb.renderH - 56; // LEADER ラベルより上

  const statusColor = faceStatus === 'locked' ? '#00ee88'
    : faceStatus === 'scanning'               ? '#ffcc00'
    : '#888888';
  const confStr = lastConf >= 0 ? ` ${(lastConf * 100).toFixed(0)}%` : '';

  const timeStr = lastMatchMsAgo < 0   ? 'never'
    : lastMatchMsAgo < 1000 ? `${Math.round(lastMatchMsAgo)}ms ago`
    : `${(lastMatchMsAgo / 1000).toFixed(1)}s ago`;
  const syncSuffix = syncOk === true ? ' ✓' : syncOk === false ? ' ✗' : '';
  const line2Color = syncOk === true ? '#00ee88' : syncOk === false ? '#ff4444' : '#999999';

  ctx.save();
  ctx.font = '10px monospace';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 3;
  ctx.fillStyle = statusColor;
  fillTextMirrorSafe(ctx, `face:${faceStatus.toUpperCase()}${confStr}`, px, py, cw, mirrored);
  ctx.fillStyle = line2Color;
  fillTextMirrorSafe(ctx, `${timeStr}${syncSuffix}`, px, py + 13, cw, mirrored);
  ctx.restore();
}

// ── パース補正身長 ────────────────────────────────────────────────────────
/**
 * 足首Y座標を基準に遠近補正した見かけ上の身長を返す。
 * 画面下端（y≒0.9）ほどカメラに近く大きく見えるため、
 * ankleY / REF_ANKLE_Y で割って正規化する。
 */
function getNormalizedHeight(lm: NormalizedLandmark[]): number {
  const nose = lm[0], aL = lm[27], aR = lm[28];
  if (!nose || !aL || !aR || (nose.visibility ?? 1) < VIS_THRESHOLD) return 0;
  const ankleY = (aL.y + aR.y) / 2;
  const h2d    = Math.abs(nose.y - ankleY);
  // 3D 補正: Z スケールは推定値のため 0.4 で減衰（Lite モデルは Z が小さい）
  const dz   = ((nose.z ?? 0) - ((aL.z ?? 0) + (aR.z ?? 0)) / 2) * 0.4;
  const h3d  = Math.sqrt(h2d * h2d + dz * dz);
  // 足元Y基準の遠近補正（参照距離 = 0.7）
  const perspFactor = Math.max(0.3, ankleY / 0.7);
  return h3d / perspFactor;
}

// ── 頭身比率（パース不変量） ──────────────────────────────────────────────
/**
 * (鼻〜足首中点の距離) / (左右耳間の距離) を返す。
 * 同一人物では距離・角度に依らず安定する身体特徴量。
 * カメラからの距離（遠近）が変わっても比率は変わらない。
 */
function getHeadBodyRatio(lm: NormalizedLandmark[]): number {
  const nose = lm[0], lEar = lm[7], rEar = lm[8], aL = lm[27], aR = lm[28];
  if (!nose || !lEar || !rEar || !aL || !aR) return 0;
  if ((nose.visibility ?? 1) < VIS_THRESHOLD) return 0;
  if ((lEar.visibility ?? 1) < VIS_THRESHOLD || (rEar.visibility ?? 1) < VIS_THRESHOLD) return 0;
  const earW = Math.hypot(rEar.x - lEar.x, rEar.y - lEar.y, ((rEar.z ?? 0) - (lEar.z ?? 0)) * 0.4);
  if (earW < 0.015) return 0; // 横顔でほぼ0になる場合は無効
  const ankleY = (aL.y + aR.y) / 2;
  const bodyH  = Math.abs(nose.y - ankleY);
  return bodyH / earW;
}

// ── 合成人体フィルタ ──────────────────────────────────────────────────────
/**
 * MediaPipe が2人のランドマークを1体として誤接続した「合成人体」を検出する。
 * 例: 男性の頭 + 女性の足（同色ズボンで脚が区別できない密着時）
 *
 * 判定基準:
 *  1. Y軸解剖学的順序: 鼻 < 肩 < 腰 でなければ無効
 *  2. 体長が MAX_BODY_HEIGHT を超えたら無効（合成人体は異常に長い）
 *  3. 上半身/下半身比が正常範囲外なら無効（腰の位置が偏っている）
 */
function isPoseCoherent(lm: NormalizedLandmark[], relaxed = false): boolean {
  const nose = lm[0];
  const lSh = lm[11], rSh = lm[12];
  const lHip = lm[23], rHip = lm[24];
  const lAnk = lm[27], rAnk = lm[28];

  if (!lSh || !rSh || !lHip || !rHip) return true; // 必須点なし → 判定スキップ

  // genderLocked 済み（relaxed=true）: 肩・腰が両方見えていれば無条件に通す。
  // 手や腕が顔に触れてもスロットが消えない「粘り腰」モード。
  if (relaxed
      && (lSh.visibility ?? 1) >= VIS_THRESHOLD && (rSh.visibility ?? 1) >= VIS_THRESHOLD
      && (lHip.visibility ?? 1) >= VIS_THRESHOLD && (rHip.visibility ?? 1) >= VIS_THRESHOLD) {
    return true;
  }

  const shoulderY = (lSh.y + rSh.y) / 2;
  const hipY      = (lHip.y + rHip.y) / 2;

  // 肩が腰より下にある（Y軸逆転） → 合成人体の典型
  if (shoulderY > hipY + 0.03) return false;

  // 鼻が肩より大幅に下 → 頭と胴体が別人
  if (nose && (nose.visibility ?? 1) >= VIS_THRESHOLD) {
    if (nose.y > shoulderY + 0.10) return false;
  }

  // 足首が存在する場合: 体長・上下比チェック
  if (lAnk && rAnk) {
    const ankleY = (lAnk.y + rAnk.y) / 2;

    // 体長チェック（鼻がない場合は肩〜足首で代替）
    const topY   = (nose && (nose.visibility ?? 1) >= VIS_THRESHOLD) ? nose.y : shoulderY - 0.05;
    const bodyH  = Math.abs(topY - ankleY);
    if (bodyH > MAX_BODY_HEIGHT) return false;

    // 上半身(肩〜腰) / 下半身(腰〜足首) 比率チェック
    const upperH = Math.abs(shoulderY - hipY);
    const lowerH = Math.abs(hipY - ankleY);
    if (lowerH > 0.02) {
      const ratio = upperH / lowerH;
      if (ratio < MIN_UL_RATIO || ratio > MAX_UL_RATIO) return false;
    }
  }

  return true;
}

// ── 正面向き判定 ──────────────────────────────────────────────────────────
/**
 * 両肩の Z 差が小さい（ = カメラに正面を向いている）かどうかを返す。
 * 横向きの場合は肩幅が狭く出るため、正面向きフレームのみを骨格スコアに使用する。
 */
function isFrontalPose(lm: NormalizedLandmark[]): boolean {
  const sL = lm[11], sR = lm[12];
  if (!sL || !sR) return false;
  if ((sL.visibility ?? 1) < VIS_THRESHOLD || (sR.visibility ?? 1) < VIS_THRESHOLD) return false;
  return Math.abs((sL.z ?? 0) - (sR.z ?? 0)) < FRONTAL_SHOULDER_Z_THRESH;
}

// ── 体格スコア（リーダーらしさ） ─────────────────────────────────────────
/**
 * 第0原則: 正面向きフレームの平均SHR（肩幅/腰幅）でLeaderスコアを算出。
 *
 * 優先順位:
 * 1. frontalSampleCount >= 1 の場合: 正面向き平均（最も信頼性が高い）
 * 2. フォールバック: 最大2D X幅（横向きのみの場合の保険）
 *
 * 典型値: 男性（Leader）SHR > 1.10, 女性（Follower）SHR < 1.05
 */
function profileLeaderScore(p: PersonProfile, _heightWeight: number): number {
  // 正面データが1フレームでも揃っていればそちらを優先（Zノイズなし・高信頼）
  if (p.frontalSampleCount >= 1 && p.frontalHipWidth > 0) {
    const avgSW = p.frontalShoulderWidth / p.frontalSampleCount;
    const avgHW = p.frontalHipWidth      / p.frontalSampleCount;
    if (avgSW > 0 && avgHW > 0) return avgSW / avgHW;
  }
  // フォールバック: 最大2D X幅
  if (p.maxShoulderX === 0 || p.maxHipX === 0) return 0;
  return p.maxShoulderX / p.maxHipX;
}

// ロック条件の物理的制約
// SHR差がこれ未満 → 確信度不足（グレー維持）
const CONFIDENCE_THRESHOLD = 0.05;
// 正面向きでなければ達成できない最小肩幅 → 横向きノイズによる早期誤ロックを防ぐ
const MIN_FRONTAL_SHOULDER_WIDTH = 0.12;

// ── ロールスロットマッチング（顔アンカー優先 + Nearest Neighbor） ─────────

function matchRoleSlots(
  all: NormalizedLandmark[][],
  slots: [RoleSlot, RoleSlot],
  useNosePrimary: boolean,   // オクルージョン離脱直後や顔分離確認時に true
  justSeparated: boolean = false, // 今フレームがオクルージョン解除の瞬間
): [number, number] {
  if (all.length === 0) return [-1, -1];
  const hips  = all.map(lm => computeMidHip(lm));
  const noses = all.map(lm => {
    const n = lm[0];
    return (n && (n.visibility ?? 1) >= VIS_THRESHOLD) ? { x: n.x, y: n.y } : null;
  });

  // 両スロット未初期化時: 最初の2人を割り当て
  if (!slots[0].hip && !slots[1].hip) {
    return [0, all.length > 1 ? 1 : -1];
  }

  const result: [number, number] = [-1, -1];
  const used = new Set<number>();

  // ─ 顔優先マッチング（useNosePrimary=true かつ両スロットに顔アンカーがある場合）
  if (useNosePrimary && slots[0].nose && slots[1].nose) {
    for (let s = 0; s < 2; s++) {
      if (!slots[s].nose) continue;
      let minDist = FACE_MATCH_DIST, best = -1;
      for (let i = 0; i < all.length; i++) {
        if (used.has(i)) continue;
        const n = noses[i];
        if (!n) continue;
        const d = Math.hypot(n.x - slots[s].nose!.x, n.y - slots[s].nose!.y);
        if (d < minDist) { minDist = d; best = i; }
      }
      if (best >= 0) { result[s] = best; used.add(best); }
    }
    // 顔マッチで割り当てられなかったスロットは腰でフォールバック
    for (let s = 0; s < 2; s++) {
      if (result[s] >= 0) continue;
      if (!slots[s].hip) {
        for (let i = 0; i < all.length; i++) {
          if (!used.has(i) && hips[i]) { result[s] = i; used.add(i); break; }
        }
      } else {
        let minDist = ROLE_MATCH_DIST, best = -1;
        for (let i = 0; i < all.length; i++) {
          if (used.has(i)) continue;
          const h = hips[i]; if (!h) continue;
          const d = Math.hypot(h.x - slots[s].hip!.x, h.y - slots[s].hip!.y);
          if (d < minDist) { minDist = d; best = i; }
        }
        if (best >= 0) { result[s] = best; used.add(best); }
      }
    }
    return result;
  }

  // ─ justSeparated: 継続追跡スロット優先マッチング
  // オクルージョン解除の瞬間はサイン波ファントムが長期誤差を蓄積しており信頼できない。
  // staleness=0（継続追跡）のスロットを先にマッチさせ、残りを遮蔽スロットに割り当てる。
  // これにより「女性が男性の前を通り過ぎた後」のID入れ替わりを防止する。
  if (justSeparated) {
    const order = slots[0].staleness <= slots[1].staleness ? [0, 1] : [1, 0];
    for (const s of order) {
      if (!slots[s].hip) {
        for (let i = 0; i < all.length; i++) {
          if (!used.has(i) && hips[i]) { result[s] = i; used.add(i); break; }
        }
        continue;
      }
      if (slots[s].staleness === 0) {
        // 継続追跡スロット: 正確な腰座標でマッチ（phantom 不使用）
        let minDist = ROLE_MATCH_DIST, best = -1;
        for (let i = 0; i < all.length; i++) {
          if (used.has(i)) continue;
          const h = hips[i]; if (!h) continue;
          const d = Math.hypot(h.x - slots[s].hip!.x, h.y - slots[s].hip!.y);
          if (d < minDist) { minDist = d; best = i; }
        }
        if (best >= 0) { result[s] = best; used.add(best); }
      } else {
        // 長期遮蔽スロット: phantom に頼らず残った検出を無条件で割り当て
        for (let i = 0; i < all.length; i++) {
          if (!used.has(i) && hips[i]) { result[s] = i; used.add(i); break; }
        }
      }
    }
    return result;
  }

  // ─ 通常: 腰ベース Nearest Neighbor
  // ターン中（omega > 0.05）はファントム予測座標をサーチセンターに使い
  // 回転の連続性（サイン波位相）で Re-ID 精度を最大化する
  for (let s = 0; s < 2; s++) {
    if (!slots[s].hip) {
      for (let i = 0; i < all.length; i++) {
        if (!used.has(i) && hips[i]) { result[s] = i; used.add(i); break; }
      }
      continue;
    }
    // ターン中: 1フレーム先のファントム座標をサーチ中心にする（位相精度優先）
    const searchCenter: Centroid = slots[s].omega > 0.05
      ? (buildPhantomPos(slots[s], 1) ?? slots[s].hip!)
      : slots[s].hip!;
    let minDist = ROLE_MATCH_DIST, best = -1;
    for (let i = 0; i < all.length; i++) {
      if (used.has(i)) continue;
      const h = hips[i]; if (!h) continue;
      const d = Math.hypot(h.x - searchCenter.x, h.y - searchCenter.y);
      if (d < minDist) { minDist = d; best = i; }
    }
    if (best >= 0) { result[s] = best; used.add(best); }
  }
  return result;
}

// ── 2パスカスケード用ヘルパー ─────────────────────────────────────────────

/** 顔中心の楕円マスク（正規化座標）— デバッグ可視化にも使用 */
type EllipseMask = {
  cx: number; cy: number;   // 楕円中心（正規化）— nose 座標
  rx: number; ry: number;   // 楕円半径（正規化）
};

/**
 * 1人分のランドマークから head-only 楕円マスクを計算する。
 * 優先順位:
 *   1. 肩幅 (lm[11]〜lm[12]) が取れる → rx = sw*0.35, ry = sw*0.45
 *   2. 耳幅 (lm[7]〜lm[8])   が取れる → rx = ew*2.0,  ry = ew*2.5
 *   3. フォールバック             → rx=0.08, ry=0.10（画像幅の 8%）
 */
/** 両肩の3D距離（XZ平面 hypot）を返す。不可視なら -1 */
function compute3DSW(lm: NormalizedLandmark[]): number {
  const sL = lm[11], sR = lm[12];
  if (!sL || !sR
      || (sL.visibility ?? 1) < VIS_THRESHOLD
      || (sR.visibility ?? 1) < VIS_THRESHOLD) return -1;
  return Math.hypot(sR.x - sL.x, (sR.z ?? 0) - (sL.z ?? 0));
}

function computeHeadEllipse(lm: NormalizedLandmark[]): EllipseMask {
  const nose = lm[0];
  const cx = nose ? nose.x : 0.5;
  const cy = nose ? nose.y : 0.15;

  const sL = lm[11], sR = lm[12];
  if (sL && sR && (sL.visibility ?? 1) >= 0.2 && (sR.visibility ?? 1) >= 0.2) {
    const sw = Math.abs(sR.x - sL.x);
    if (sw > 0.04) return { cx, cy, rx: sw * 0.35, ry: sw * 0.45 };
  }
  const eL = lm[7], eR = lm[8];
  if (eL && eR && (eL.visibility ?? 1) >= 0.2 && (eR.visibility ?? 1) >= 0.2) {
    const ew = Math.abs(eR.x - eL.x);
    if (ew > 0.01) return { cx, cy, rx: ew * 2.0, ry: ew * 2.5 };
  }
  return { cx, cy, rx: 0.08, ry: 0.10 };
}

/**
 * 2パスカスケード検出
 * Pass1: 通常検出
 * Pass2: 検出済み人物の「顔周辺のみ」を楕円グレーマスクで隠して再検出 → マージ
 *
 * 旧実装（胴体全体 fillRect）から変更:
 *   胴体・肩・下半身をマスクしないことで、手前を通過中の人物の骨格を
 *   Pass2 で検出できるようにする。
 *
 * @returns { landmarks, masks } — landmarks はマージ済み全人物、
 *          masks は Pass2 で使用した楕円（デバッグ描画用）
 */
function runTwoPassDetect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  landmarker: any,
  video: HTMLVideoElement,
  now: number,
  offCanvas: HTMLCanvasElement,
): { landmarks: NormalizedLandmark[][]; masks: EllipseMask[] } {
  const r1 = landmarker.detectForVideo(video, now);
  const p1 = r1.landmarks as NormalizedLandmark[][];
  if (p1.length >= 2) return { landmarks: p1, masks: [] };

  const vw = video.videoWidth, vh = video.videoHeight;
  if (vw <= 0 || vh <= 0 || !p1.length) return { landmarks: p1, masks: [] };

  if (offCanvas.width !== vw || offCanvas.height !== vh) {
    offCanvas.width = vw; offCanvas.height = vh;
  }
  const ctx2 = offCanvas.getContext('2d');
  if (!ctx2) return { landmarks: p1, masks: [] };

  ctx2.drawImage(video, 0, 0);
  ctx2.fillStyle = '#808080';
  const masks: EllipseMask[] = [];
  for (const lm of p1) {
    const m = computeHeadEllipse(lm);
    masks.push(m);
    ctx2.beginPath();
    ctx2.ellipse(m.cx * vw, m.cy * vh, m.rx * vw, m.ry * vh, 0, 0, Math.PI * 2);
    ctx2.fill();
  }

  const r2 = landmarker.detectForVideo(offCanvas, now + 1);
  const p2 = r2.landmarks as NormalizedLandmark[][];

  const merged = [...p1];
  for (const lm2 of p2) {
    const h2 = computeMidHip(lm2);
    if (!h2) continue;
    const dup = p1.some(lm1 => {
      const h1 = computeMidHip(lm1);
      return h1 && Math.hypot(h1.x - h2.x, h1.y - h2.y) < 0.2;
    });
    if (!dup) merged.push(lm2);
  }
  return { landmarks: merged, masks };
}

/** analysisCache から video.currentTime に最も近い結果を返す */
function findCachedResult(cache: CachedResult[], time: number): NormalizedLandmark[][] | null {
  let best: CachedResult | null = null;
  let bestDiff = CACHE_TIME_TOL;
  for (const c of cache) {
    const diff = Math.abs(c.time - time);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best ? best.landmarks : null;
}

// ── 物理ステートマシン ヘルパー ───────────────────────────────────────────

/** 肩幅を返す（-1 = 不明） */
function getShoulderWidth(lm: NormalizedLandmark[]): number {
  const sL = lm[11], sR = lm[12];
  if (!sL || !sR || (sL.visibility ?? 1) < VIS_THRESHOLD || (sR.visibility ?? 1) < VIS_THRESHOLD) return -1;
  return Math.abs(sR.x - sL.x);
}

/** 足首 Y 座標の平均を返す（-1 = 不明）*/
function getFootY(lm: NormalizedLandmark[]): number {
  const aL = lm[27], aR = lm[28];
  const lv = aL ? (aL.visibility ?? 1) >= VIS_THRESHOLD : false;
  const rv = aR ? (aR.visibility ?? 1) >= VIS_THRESHOLD : false;
  if (lv && rv) return (aL!.y + aR!.y) / 2;
  if (lv) return aL!.y;
  if (rv) return aR!.y;
  return -1;
}

/**
 * 2人のうちカメラに近い方（手前）のインデックス（0 or 1）を返す。
 * 優先順位: 肩幅（広い=近い）> 足首Y（大きい=画面下=近い）> Z座標（小さい=近い）
 */
function getZOrderFront(lm0: NormalizedLandmark[], lm1: NormalizedLandmark[]): 0 | 1 {
  const sw0 = getShoulderWidth(lm0), sw1 = getShoulderWidth(lm1);
  if (sw0 > 0 && sw1 > 0 && Math.abs(sw0 - sw1) > 0.03) return sw0 > sw1 ? 0 : 1;
  const fy0 = getFootY(lm0), fy1 = getFootY(lm1);
  if (fy0 > 0 && fy1 > 0 && Math.abs(fy0 - fy1) > 0.05) return fy0 > fy1 ? 0 : 1;
  const hz0 = ((lm0[23]?.z ?? 0) + (lm0[24]?.z ?? 0)) / 2;
  const hz1 = ((lm1[23]?.z ?? 0) + (lm1[24]?.z ?? 0)) / 2;
  return hz0 < hz1 ? 0 : 1;
}

/**
 * X座標履歴からターン角速度（rad/frame）を推定する。
 * ピーク〜バレー間のフレーム数（halfPeriod）から ω = π / halfPeriod。
 * 有効な極値が見つからない場合は 0 を返す。
 */
function estimateOmegaFromHistory(xHist: number[]): number {
  const n = xHist.length;
  if (n < 8) return 0;
  // 窓幅3 で簡易スムージング
  const smoothed: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(n - 1, i + 2);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += xHist[j];
    smoothed.push(sum / (hi - lo + 1));
  }
  // ピーク・バレーのインデックスを収集
  const extrema: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if ((smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) ||
        (smoothed[i] < smoothed[i - 1] && smoothed[i] < smoothed[i + 1])) {
      extrema.push(i);
    }
  }
  if (extrema.length < 2) return 0;
  // 隣接極値間の平均インターバル = halfPeriod
  let total = 0;
  for (let i = 0; i < extrema.length - 1; i++) total += extrema[i + 1] - extrema[i];
  const halfPeriod = total / (extrema.length - 1);
  return halfPeriod > 1 ? Math.PI / halfPeriod : 0;
}

/**
 * オクルージョン中の予測座標を返す（速度外挿 + サイン波ブレンド）。
 * ω が大きいほどサイン波成分を重視する。
 */
function buildPhantomPos(slot: RoleSlot, framesOccluded: number): Centroid | null {
  if (!slot.hip) return null;
  const velPredX = slot.hip.x + slot.velX * framesOccluded;
  const velPredY = slot.hip.y + slot.velY * framesOccluded;
  if (slot.omega > 0.05 && slot.angAmplitude > 0.05) {
    const predictedPhase = slot.angPhase + slot.omega * framesOccluded;
    const sinePredX = slot.angCenter + slot.angAmplitude * Math.sin(predictedPhase);
    // ω が大きいほどサイン波を優先（最大 0.85）
    const sineWeight = Math.min(0.85, slot.omega * 4);
    return { x: sinePredX * sineWeight + velPredX * (1 - sineWeight), y: velPredY };
  }
  return { x: velPredX, y: velPredY };
}

// ── ダンス動力学スコア更新 ────────────────────────────────────────────────
/**
 * 3つの物理的特徴を解析しリード動力学スコアを更新する。
 *   1. Inception Detection — 先行動作: 手首の動き出しが早い方を Leader と判定
 *   2. Centripetal Logic  — 向心力: ターン中に回転中心に近い（振幅小）方を Leader と判定
 *   3. Space Management   — スロット理論: 接近直前に横移動でスペースを作った方を Leader と判定
 *
 * スコアは毎フレーム DYNAMICS_DECAY で減衰するため、直近の行動が強く影響する。
 */
function updateDynamicsScores(
  slots: [RoleSlot, RoleSlot],
  all: NormalizedLandmark[][],
  si0: number,
  si1: number,
  prevSlotDist: number,
  frameIdx: number,
): void {
  // スコア減衰（全フレーム）
  slots[0].dynamicsScore *= DYNAMICS_DECAY;
  slots[1].dynamicsScore *= DYNAMICS_DECAY;

  // ── 手首速度 & 動き出し検知（各スロットを独立に更新）─────────────────
  for (let s = 0; s < 2; s++) {
    const si = s === 0 ? si0 : si1;
    if (si < 0) { slots[s].wasMoving = false; continue; }
    const lm = all[si];
    const lw = lm[15], rw = lm[16];
    if (!lw || !rw || (lw.visibility ?? 1) < VIS_THRESHOLD || (rw.visibility ?? 1) < VIS_THRESHOLD) continue;
    const mx = (lw.x + rw.x) / 2, my = (lw.y + rw.y) / 2;
    if (slots[s].wristPrev) {
      const speed = Math.hypot(mx - slots[s].wristPrev!.mx, my - slots[s].wristPrev!.my);
      slots[s].wristVel = speed;
      const isMovingNow = speed > INCEPTION_VEL_THRESHOLD;
      // 静止→運動 の遷移で「動き出し」とみなす
      if (isMovingNow && !slots[s].wasMoving) slots[s].motionOnsetFrame = frameIdx;
      slots[s].wasMoving = isMovingNow;
    }
    slots[s].wristPrev = { mx, my };
  }

  if (si0 < 0 || si1 < 0) return; // 以下は2人同時検出時のみ

  // ── 1. Inception Detection ────────────────────────────────────────────────
  // 手首の動き出しタイミングを比較: 50-130ms 先行した方に Lead スコアを加算
  const f0 = slots[0].motionOnsetFrame;
  const f1 = slots[1].motionOnsetFrame;
  if (f0 >= 0 && f1 >= 0) {
    const frameDiff = f1 - f0; // 正 = slot0 が先に動いた
    const stale0 = frameIdx - f0 > INCEPTION_FRAME_WINDOW * 3;
    const stale1 = frameIdx - f1 > INCEPTION_FRAME_WINDOW * 3;
    if (!stale0 && !stale1 && frameDiff !== 0 && Math.abs(frameDiff) <= INCEPTION_FRAME_WINDOW) {
      if (frameDiff > 0) slots[0].dynamicsScore += INCEPTION_SCORE;
      else               slots[1].dynamicsScore += INCEPTION_SCORE;
    }
  }

  // ── 2. Centripetal Logic ──────────────────────────────────────────────────
  // ターン中: X振幅が小さい方（回転の中心軌道）= Leader
  // X振幅が大きい方（大きな円弧を描く）= Follower
  if (slots[0].omega > 0.05 && slots[1].omega > 0.05
      && slots[0].angAmplitude > 0.02 && slots[1].angAmplitude > 0.02) {
    const amp0 = slots[0].angAmplitude, amp1 = slots[1].angAmplitude;
    if (amp0 < amp1 * 0.75)      slots[0].dynamicsScore += CENTRIPETAL_SCORE;
    else if (amp1 < amp0 * 0.75) slots[1].dynamicsScore += CENTRIPETAL_SCORE;
  }

  // ── 3. Space Management ───────────────────────────────────────────────────
  // 接近中に相手の進行方向から軸をずらした（横移動率が高い）方 = Leader（道を作る）
  if (slots[0].hip && slots[1].hip) {
    const curDist = Math.hypot(slots[0].hip.x - slots[1].hip.x, slots[0].hip.y - slots[1].hip.y);
    if (curDist < OCCLUSION_DIST * 2.5 && prevSlotDist > curDist + 0.005) {
      const dx = slots[1].hip.x - slots[0].hip.x;
      const dy = slots[1].hip.y - slots[0].hip.y;
      const dlen = Math.hypot(dx, dy);
      if (dlen > 0.01) {
        const nx = dx / dlen, ny = dy / dlen; // slot0→slot1 方向の単位ベクトル
        const spd0 = Math.hypot(slots[0].velX, slots[0].velY);
        const spd1 = Math.hypot(slots[1].velX, slots[1].velY);
        if (spd0 > MOVEMENT_TH && spd1 > MOVEMENT_TH) {
          // 接近線に対して垂直な速度成分の比率（1 = 純粋な横移動）
          const perp0 = Math.abs(slots[0].velX * (-ny) + slots[0].velY * nx) / spd0;
          const perp1 = Math.abs(slots[1].velX * (-ny) + slots[1].velY * nx) / spd1;
          if (perp0 > 0.65 && perp0 > perp1 * 1.3)      slots[0].dynamicsScore += SPACE_SCORE;
          else if (perp1 > 0.65 && perp1 > perp0 * 1.3) slots[1].dynamicsScore += SPACE_SCORE;
        }
      }
    }
  }
}

// ── フック本体 ────────────────────────────────────────────────────────────

export function usePoseEstimation(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  mode: VizMode,
  bpm = 0,
  isMirrored = false,
  salsaStyle: SalsaStyle = 'on1',
  heightLeaderHint = false,   // true = 背が高い方をリーダーとして重み付け
  onRawPoses?: (poses: Array<{ landmarks: NormalizedLandmark[] }>, videoTime: number) => void,
): UsePoseEstimationResult {
  const modeRef      = useRef<VizMode>(mode);
  modeRef.current    = mode;
  const bpmRef       = useRef(bpm);
  bpmRef.current     = bpm;
  const mirroredRef  = useRef(isMirrored);
  mirroredRef.current = isMirrored;
  const styleRef     = useRef<SalsaStyle>(salsaStyle);
  styleRef.current   = salsaStyle;

  const enabled = mode !== 'off';

  const activeRef     = useRef(false);
  const rafRef        = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landmarkerRef = useRef<any>(null);

  // ── ロックオン状態
  const lockedRef = useRef<Centroid | null>(null);
  const [isLocked, setIsLocked] = useState(false);

  // ── デバッグ用タップ座標（CSS transform 逆変換済み）
  const debugTapCanvasRef = useRef<{ x: number; y: number } | null>(null);

  // ── 速度予測追跡
  const velocityRef      = useRef<VelocityVec>({ vx: 0, vy: 0 });
  const occlusionCountRef = useRef(0);
  const prevHipRef        = useRef<Centroid | null>(null);

  // ── 足首軌跡バッファ（全モード共通で蓄積）
  const ankleHistoryRef = useRef<AnkleFrame[]>([]);

  // ── 適応型サンプリング
  const detectIntervalRef = useRef(50);

  // ── パターン検出状態
  const patternStateRef = useRef<PatternDetectionState>(makeInitialPatternState());
  // ターン検出後の位相チェック抑制用（ターン中は同方向移動が正常なため）
  const lastTurnTimeRef = useRef<number>(-Infinity);

  // ── イベントID
  const eventIdRef = useRef(0);

  // ── シーケンス
  const [sequence, setSequence] = useState<SequenceEvent[]>([]);

  // ── ロール判定（On1/On2）
  const makeRoleSlot = (): RoleSlot => ({
    hip: null, hipZ: 0, role: null, xHistory: [], staleness: 0,
    nose: null, velX: 0, velY: 0, profile: makeProfile(),
    zFront: false, omegaHist: [], omega: 0,
    angPhase: 0, angCenter: 0.5, angAmplitude: 0, phantomPos: null,
    dynamicsScore: 0, wristPrev: null, wristVel: 0, wasMoving: false, motionOnsetFrame: -1,
    coldFrameCount: 0, prevAnkleMid: null, detectedIdx: -1, lockSource: null,
  });
  const roleSlots          = useRef<[RoleSlot, RoleSlot]>([makeRoleSlot(), makeRoleSlot()]);
  const roleDetectedRef    = useRef(false);
  const prevBeatNumRef     = useRef<number | undefined>(undefined);
  const [syncError, setSyncError]     = useState(false);
  const syncErrorRef       = useRef(false);
  const [roleDetected, setRoleDetected]       = useState(false);
  const [roleConfidenceLow, setRoleConfidenceLow] = useState(false); // Safety Guard: 初期判定の確信度が低い
  const [debugInfo, setDebugInfo]             = useState<PoseDebugInfo | null>(null);
  // 性別判定ハードロック（ps確定後）— 全自動ロール変更をブロック
  const genderLockedRef                = useRef(false); // true = ps性別判定完了済み
  // 手動 Swap 後の永続ハードロック（Swap is Truth）— psリアクティブチェックもブロック
  const manualRoleLockedRef            = useRef(false); // true = ユーザーの判断を最優先
  // face-api.js 顔性別判定ロック（SHRより優先度高、Swapより低）
  const faceLockedRef                  = useRef(false);
  const faceModelsLoadedRef            = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const faceapiRef                     = useRef<any>(null);  // face-api.js モジュール（動的ロード）
  const faceScanResultsRef             = useRef<FaceScanResult[]>([]);
  const faceVisualizationRef           = useRef<FaceVisualization[]>([]);  // 全検出（可視化用）
  const faceScanningRef                = useRef(false);
  const lastFaceScanRef                = useRef(0);
  const slotFaceLastMatchTimeRef       = useRef<[number, number]>([-1, -1]);  // スロットごとの最終顔マッチ時刻（performance.now）
  const slotFaceLastConfRef            = useRef<[number, number]>([-1, -1]);  // スロットごとの最終信頼度
  const slotFaceGenderRef              = useRef<['male'|'female'|null, 'male'|'female'|null]>([null, null]); // face-api 確定性別
  const faceRoiCanvasRef               = useRef<HTMLCanvasElement | null>(null); // ROIスキャン用キャンバス（再利用）
  const faceRoiPreviewsRef             = useRef<[HTMLCanvasElement | null, HTMLCanvasElement | null]>([null, null]); // ROIデバッグプレビュー（スロットごと）
  const onRawPosesRef                  = useRef(onRawPoses);
  onRawPosesRef.current                = onRawPoses; // レンダーごとに最新を保持（再 effect 不要）
  const profileCompleteTimeRef         = useRef(0);  // profileComplete が最初に true になった時刻
  const initTimeRef                    = useRef(0);  // init() 開始時刻（face サスペンド起点）
  const lockedShoulderWidthRef         = useRef<[number, number]>([-1, -1]); // ロック時の肩幅定数（常時クロス照合用）

  // ── ハイブリッドアーキテクチャ用 Ref ────────────────────────────────────
  const offscreenCanvasRef  = useRef<HTMLCanvasElement | null>(null);     // 2パスカスケード用
  const analysisCacheRef    = useRef<CachedResult[]>([]);                 // iOS キャッシュ
  const ellipseMasksRef     = useRef<EllipseMask[]>([]);                  // Pass2 楕円マスク（デバッグ描画用）

  // 体格プロファイル & オクルージョン管理
  const profileCompleteRef  = useRef(false);
  const isOccludedRef       = useRef(false);
  const heightLeaderHintRef = useRef(heightLeaderHint);
  heightLeaderHintRef.current = heightLeaderHint;

  // ── フレームバッファ & アノテーション
  const frameBufferRef      = useRef<FrameSnapshot[]>([]);
  const frameIndexRef       = useRef(0);
  const annotationsRef      = useRef<AnnotationEntry[]>([]);
  const pendingAnnotationRef = useRef<AnnotationEntry | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationEntry[]>([]);

  // ── シーケンスクリア
  const clearSequence = useCallback(() => {
    setSequence([]);
    patternStateRef.current = makeInitialPatternState();
  }, []);

  // ── ロール判定リセット
  const clearRoles = useCallback(() => {
    roleSlots.current           = [makeRoleSlot(), makeRoleSlot()];
    roleDetectedRef.current     = false;
    profileCompleteRef.current  = false;
    isOccludedRef.current       = false;
    genderLockedRef.current     = false;
    manualRoleLockedRef.current = false;
    faceLockedRef.current        = false;
    faceScanResultsRef.current   = [];
    faceVisualizationRef.current = [];
    profileCompleteTimeRef.current = 0;
    analysisCacheRef.current         = [];
    ellipseMasksRef.current          = [];
    lockedShoulderWidthRef.current   = [-1, -1];
    slotFaceLastMatchTimeRef.current = [-1, -1];
    slotFaceLastConfRef.current      = [-1, -1];
    slotFaceGenderRef.current        = [null, null];
    prevBeatNumRef.current           = undefined;
    syncErrorRef.current     = false;
    setSyncError(false);
    setRoleDetected(false);
    setRoleConfidenceLow(false);
    annotationsRef.current   = [];
    setAnnotations([]);
    pendingAnnotationRef.current = null;
    setDebugInfo(null);
  }, []);

  // ── Swap Roles（ロール反転 + アノテーション記録）
  const swapRoles = useCallback(() => {
    const slots = roleSlots.current;
    const r0 = slots[0].role;
    const r1 = slots[1].role;
    slots[0].role = r1;
    slots[1].role = r0;
    // 手動Swap後は永続ハードロック — 人間の判断を絶対的な正解として固定
    manualRoleLockedRef.current = true;

    const entry: AnnotationEntry = {
      errorFrameIndex: frameIndexRef.current,
      videoTime: videoRef.current?.currentTime ?? 0,
      preSceneData: frameBufferRef.current.slice(-POST_SCENE_FRAMES).map(f => ({ ...f, persons: f.persons.map(p => ({ ...p })) })),
      postSceneData: [],
      resolvedBy: 'manual_swap',
      salsaStyle: styleRef.current,
      swapDetail: { slot0RoleBefore: r0, slot1RoleBefore: r1, slot0RoleAfter: r1, slot1RoleAfter: r0 },
    };
    pendingAnnotationRef.current = entry;
  }, [videoRef]);

  // ── デバッグ JSON エクスポート
  const exportDebugLog = useCallback((videoName?: string) => {
    const style = styleRef.current;
    const log = {
      meta: {
        exportTime: new Date().toISOString(),
        videoName: videoName ?? 'unknown',
        salsaStyle: style,
        totalFramesProcessed: frameIndexRef.current,
        totalAnnotations: annotationsRef.current.length,
        analysisNote: [
          `Claude Code解析用 — ${style === 'on1' ? 'On1 (LA Style, break on beat 1)' : 'On2 (NY Style, break on beat 2)'}`,
          'annotations[].preSceneData / postSceneData を比較し、IDスイッチが発生した物理的要因を特定してください。',
          '着目ポイント: distanceBetweenPersons の急減（オクルージョン開始）、shoulderWidth の急変、velX の符号逆転。',
        ].join(' '),
      },
      annotations: annotationsRef.current,
      recentFrameBuffer: frameBufferRef.current.slice(-60),
    };
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `salsa_debug_log_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // ── ロックオン（CSS transform 逆変換済みのキャンバス座標を受け取る）
  const lockAt = useCallback((canvasX: number, canvasY: number) => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas) return;

    const container = canvas.parentElement;
    const cw = container?.clientWidth  ?? canvas.offsetWidth;
    const ch = container?.clientHeight ?? canvas.offsetHeight;
    const lb = computeLetterbox(cw, ch, video.videoWidth, video.videoHeight);

    debugTapCanvasRef.current = { x: canvasX, y: canvasY };
    lockedRef.current = {
      x: Math.max(0, Math.min(1, (canvasX - lb.offsetX) / lb.renderW)),
      y: Math.max(0, Math.min(1, (canvasY - lb.offsetY) / lb.renderH)),
    };

    // 追跡状態をリセット
    velocityRef.current      = { vx: 0, vy: 0 };
    occlusionCountRef.current = 0;
    ankleHistoryRef.current   = [];
    patternStateRef.current   = makeInitialPatternState();
    setIsLocked(true);
  }, [videoRef, canvasRef]);

  // ── ロック解除
  const unlock = useCallback(() => {
    lockedRef.current         = null;
    debugTapCanvasRef.current = null;
    velocityRef.current       = { vx: 0, vy: 0 };
    occlusionCountRef.current  = 0;
    ankleHistoryRef.current    = [];
    patternStateRef.current    = makeInitialPatternState();
    setIsLocked(false);
  }, []);

  // ── PoseLandmarker のライフサイクル
  useEffect(() => {
    if (!enabled) {
      activeRef.current = false;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let cancelled = false;
    activeRef.current = true;

    // 2パスカスケード用オフスクリーンキャンバスを全デバイスで初期化
    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }

    async function init() {
      const connections: Connection[] = POSE_CONNECTIONS;
      let lastDetect = 0;

      // ── face-api.js CDN ロード（MediaPipe と並行起動 — iOS CDN遅延対策）
      initTimeRef.current = performance.now();
      if (!faceModelsLoadedRef.current) {
        void (async () => {
          try {
            const fa = await loadFaceApiFromCDN();
            await fa.nets.tinyFaceDetector.loadFromUri('/models');
            await fa.nets.ageGenderNet.loadFromUri('/models');
            faceapiRef.current = fa;
            faceModelsLoadedRef.current = true;
            console.log('[FACE] models loaded');
          } catch (e: unknown) {
            console.warn('[FACE] model load failed', e);
          }
        })();
      }

      // ── 全デバイス共通: メインスレッドで MediaPipe を初期化 ─────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision' as any) as any;
      if (cancelled) return;

      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      if (cancelled) return;

      const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: NUM_POSES,
        minPoseDetectionConfidence: DETECT_CONFIDENCE,
        minPosePresenceConfidence: PRESENCE_CONFIDENCE,
        minTrackingConfidence: TRACKING_CONFIDENCE,
      });

      if (cancelled) { landmarker.close(); return; }
      landmarkerRef.current = landmarker;

      function loop() {
        if (!activeRef.current || cancelled) return;

        const currentMode = modeRef.current;
        const mirrored    = mirroredRef.current;
        const video  = videoRef.current;
        const canvas = canvasRef.current;

        if (!video || !canvas) { rafRef.current = requestAnimationFrame(loop); return; }

        if (currentMode === 'off') {
          canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        if (!video.paused && video.readyState >= 2) {
          const container = canvas.parentElement;
          const rw = container?.clientWidth  ?? Math.round(canvas.getBoundingClientRect().width);
          const rh = container?.clientHeight ?? Math.round(canvas.getBoundingClientRect().height);
          if (rw > 0 && rh > 0 && (canvas.width !== rw || canvas.height !== rh)) {
            canvas.width = rw; canvas.height = rh;
          }

          const now = performance.now();
          if (now - lastDetect >= detectIntervalRef.current) {
            lastDetect = now;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              try {
                // ── 検出（2パスカスケード + キャッシュ） ────────────────
                const lm = landmarkerRef.current;
                if (!lm) throw new Error('landmarker not ready');

                let all: NormalizedLandmark[][];
                const rate = video.playbackRate;

                if (IS_IOS && rate > SLOW_RATE_THRESHOLD) {
                  // iOS 通常速度: キャッシュ優先、ミスなら単一パス
                  const cached = findCachedResult(analysisCacheRef.current, video.currentTime);
                  if (cached !== null) {
                    all = cached;
                  } else {
                    const r = lm.detectForVideo(video, now);
                    all = (r.landmarks as NormalizedLandmark[][]).filter(lm2 => isPoseCoherent(lm2, genderLockedRef.current));
                  }
                } else {
                  // PC（常時）/ iOS スロー再生時: 2パスカスケード（楕円マスク）
                  const { landmarks: rawLm, masks: rawMasks } = runTwoPassDetect(lm, video, now, offscreenCanvasRef.current!);
                  all = rawLm.filter(lm2 => isPoseCoherent(lm2, genderLockedRef.current));
                  ellipseMasksRef.current = rawMasks;  // デバッグ描画用に保存
                  // iOS スロー時はキャッシュに保存（通常速度で再生する際に再利用）
                  if (IS_IOS) {
                    analysisCacheRef.current.push({ time: video.currentTime, landmarks: all });
                    if (analysisCacheRef.current.length > CACHE_MAX_FRAMES) analysisCacheRef.current.shift();
                  }
                }

                // ── ロガーへ生ランドマークを渡す（計算処理なし・生座標のみ）
                if (onRawPosesRef.current && all.length > 0) {
                  onRawPosesRef.current(
                    all.map(lm => ({ landmarks: lm })),
                    video.currentTime,
                  );
                }

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (all.length > 0) {
                  const lb  = computeLetterbox(canvas.width, canvas.height, video.videoWidth, video.videoHeight);
                  const cw  = canvas.width;
                  const ch  = canvas.height;

                  // ── 追跡対象のインデックス決定
                  let targetIdx: number;
                  let currentHip: Centroid | null = null;
                  let trackDist = 0;

                  if (lockedRef.current !== null) {
                    // ── ロックオンモード（速度予測付き）
                    const tr = findNearestToTarget(
                      all,
                      lockedRef.current,
                      velocityRef.current,
                      occlusionCountRef.current,
                    );
                    targetIdx   = tr.idx;
                    trackDist   = tr.dist;
                    currentHip  = tr.hip;

                    if (currentHip) {
                      // 速度を更新（前回のhipとの差分）
                      if (prevHipRef.current) {
                        velocityRef.current = {
                          vx: currentHip.x - prevHipRef.current.x,
                          vy: currentHip.y - prevHipRef.current.y,
                        };
                      }
                      prevHipRef.current    = currentHip;
                      lockedRef.current     = currentHip;
                      occlusionCountRef.current = 0;

                      // 適応型サンプリング
                      const moveLen = Math.hypot(velocityRef.current.vx, velocityRef.current.vy);
                      detectIntervalRef.current = moveLen > MOVEMENT_TH ? DETECT_FAST : DETECT_SLOW;
                    } else {
                      // オクルージョン：カウントアップ、OCCLUSION_MAX 超えたらロック解除
                      occlusionCountRef.current++;
                      if (occlusionCountRef.current > OCCLUSION_MAX) {
                        lockedRef.current = null;
                        setIsLocked(false);
                      }
                    }
                  } else {
                    // ── 通常モード（画面中央に近い人をメインとして選択）
                    targetIdx  = findMainPersonIndex(all);
                    currentHip = computeMidHip(all[targetIdx]);

                    // 適応型サンプリング
                    if (currentHip && prevHipRef.current) {
                      const moveLen = Math.hypot(currentHip.x - prevHipRef.current.x, currentHip.y - prevHipRef.current.y);
                      detectIntervalRef.current = moveLen > MOVEMENT_TH ? DETECT_FAST : DETECT_SLOW;
                    }
                    prevHipRef.current = currentHip;
                  }

                  // ── 足首軌跡バッファを更新（全モード共通）
                  const aL = all[targetIdx][27], aR = all[targetIdx][28];
                  const aLv = aL && (aL.visibility ?? 1) >= VIS_THRESHOLD;
                  const aRv = aR && (aR.visibility ?? 1) >= VIS_THRESHOLD;
                  if (aLv || aRv) {
                    ankleHistoryRef.current.push({
                      lx: aLv ? aL.x : -1, ly: aLv ? aL.y : -1,
                      rx: aRv ? aR.x : -1, ry: aRv ? aR.y : -1,
                    });
                    if (ankleHistoryRef.current.length > TRAIL_LENGTH) ankleHistoryRef.current.shift();
                  }

                  // ── パターン検出（再生中のみ）
                  runPatternDetection(
                    all[targetIdx],
                    video.currentTime,
                    bpmRef.current,
                    patternStateRef.current,
                    (action, quality, beatNum) => {
                      // ターン検出時刻を記録 → 位相チェックを一時抑制
                      if (action === 'Turn') {
                        lastTurnTimeRef.current = video.currentTime;
                      }
                      const evt: SequenceEvent = {
                        id: eventIdRef.current++,
                        time: video.currentTime,
                        action,
                        quality,
                        beatNum,
                      };
                      setSequence(prev => [...prev, evt].slice(-300));
                    },
                  );

                  // ── ロールスロット更新 & 役割判定 ────────────────────────
                  const slots   = roleSlots.current;

                  // ── [Frame Top] ps リアクティブ整合チェック（第0原則の先頭守護）──────
                  // per-personループより先に実行することで、ループ内の personRoles.set が
                  // 必ず ps確定済みの正しいロールを読む。genderLocked確定後は毎フレーム最優先。
                  if (genderLockedRef.current && !manualRoleLockedRef.current && !faceLockedRef.current) {
                    const ps0t = profileLeaderScore(slots[0].profile, 1);
                    const ps1t = profileLeaderScore(slots[1].profile, 1);
                    if (ps0t > 0 && ps1t > 0) {
                      const exp0t: PersonRole = ps0t >= ps1t ? 'leader' : 'follower';
                      const exp1t: PersonRole = ps0t >= ps1t ? 'follower' : 'leader';
                      if (slots[0].role !== exp0t || slots[1].role !== exp1t) {
                        slots[0].role = exp0t;
                        slots[1].role = exp1t;
                      }
                    }
                  }

                  // オクルージョン判定（マッチング前に前フレームのスロット距離で判定）
                  const prevSlotDist = (slots[0].hip && slots[1].hip)
                    ? Math.hypot(slots[0].hip.x - slots[1].hip.x, slots[0].hip.y - slots[1].hip.y)
                    : Infinity;
                  const wasOccluded = isOccludedRef.current;
                  if (prevSlotDist < OCCLUSION_DIST) {
                    isOccludedRef.current = true;
                  } else if (wasOccluded && prevSlotDist > OCCLUSION_DIST * 1.6) {
                    // 十分離れたらオクルージョン解除
                    isOccludedRef.current = false;
                  }
                  const justSeparated = wasOccluded && !isOccludedRef.current;

                  // 顔が独立して検出されているか（密着中でない場合のみ有効）
                  const detectedNoses = all.map(lm => {
                    const n = lm[0];
                    return (n && (n.visibility ?? 1) >= VIS_THRESHOLD) ? { x: n.x, y: n.y } : null;
                  });
                  const noseSep = (all.length >= 2 && detectedNoses[0] && detectedNoses[1])
                    ? Math.hypot(detectedNoses[0].x - detectedNoses[1].x, detectedNoses[0].y - detectedNoses[1].y)
                    : 0;
                  const facePriority = justSeparated || noseSep >= NOSE_SEP_MIN;

                  // eslint-disable-next-line prefer-const
                  let [si0, si1] = matchRoleSlots(all, slots, facePriority, justSeparated);

                  // ── CBL後 解剖学的自己修復（肩幅クロス照合 → nose フォールバック）────
                  // justSeparated 直後: matchRoleSlots の距離ベースマッチングが CBL方向転換で
                  // si0/si1 を逆に割り当てるケースを解剖学的証拠（肩幅）で検出・修正する。
                  // genderLocked 確定済みのプロファイル肩幅（期待値）と現フレームの実測3D肩幅を
                  // クロス照合し、direct割り当てより swapped割り当ての誤差合計が 20%以上小さければ
                  // 強制 Swap。肩幅が取れない場合のみ旧 nose アンカー法にフォールバック。
                  if (justSeparated && genderLockedRef.current && !manualRoleLockedRef.current
                      && si0 >= 0 && si1 >= 0) {
                    const sw0 = compute3DSW(all[si0]);   // si0 人物の現3D肩幅
                    const sw1 = compute3DSW(all[si1]);   // si1 人物の現3D肩幅
                    // プロファイル平均3D肩幅（genderLocked後は蓄積停止済みの確定値）
                    const psw0 = slots[0].profile.shoulderSamples > 0
                      ? slots[0].profile.totalShoulderWidth / slots[0].profile.shoulderSamples : -1;
                    const psw1 = slots[1].profile.shoulderSamples > 0
                      ? slots[1].profile.totalShoulderWidth / slots[1].profile.shoulderSamples : -1;

                    if (sw0 > 0.04 && sw1 > 0.04 && psw0 > 0 && psw1 > 0) {
                      // ── 一次判定: 肩幅クロス照合 ─────────────────────────────────────
                      // direct  = si0→slot0 の誤差 + si1→slot1 の誤差
                      // swapped = si0→slot1 の誤差 + si1→slot0 の誤差
                      const errDirect  = Math.abs(sw0 - psw0) + Math.abs(sw1 - psw1);
                      const errSwapped = Math.abs(sw0 - psw1) + Math.abs(sw1 - psw0);
                      if (errSwapped < errDirect * 0.80) {
                        [si0, si1] = [si1, si0];
                        console.log(`[CBL_FIX_SW] shoulder swap: errDirect=${errDirect.toFixed(3)} errSwapped=${errSwapped.toFixed(3)} ratio=${(errSwapped/errDirect).toFixed(3)} sw0=${sw0.toFixed(3)} sw1=${sw1.toFixed(3)} psw0=${psw0.toFixed(3)} psw1=${psw1.toFixed(3)}`);
                      } else {
                        console.log(`[CBL_FIX_SW_SKIP] ratio=${(errSwapped/errDirect).toFixed(3)} sw0=${sw0.toFixed(3)} sw1=${sw1.toFixed(3)} psw0=${psw0.toFixed(3)} psw1=${psw1.toFixed(3)}`);
                      }
                    } else {
                      // ── フォールバック: nose アンカーベース（肩幅が取れない場合）─────
                      const n0Old = slots[0].nose;
                      const n1Old = slots[1].nose;
                      const n0New = all[si0][0];
                      const n1New = all[si1][0];
                      if (n0Old && n1Old
                          && n0New && (n0New.visibility ?? 1) >= VIS_THRESHOLD
                          && n1New && (n1New.visibility ?? 1) >= VIS_THRESHOLD) {
                        const distDirect  = Math.hypot(n0New.x - n0Old.x, n0New.y - n0Old.y)
                                          + Math.hypot(n1New.x - n1Old.x, n1New.y - n1Old.y);
                        const distSwapped = Math.hypot(n0New.x - n1Old.x, n0New.y - n1Old.y)
                                          + Math.hypot(n1New.x - n0Old.x, n1New.y - n0Old.y);
                        if (distSwapped < distDirect * 0.80) {
                          [si0, si1] = [si1, si0];
                          console.log(`[CBL_FIX_NOSE] nose-anchor fallback swap: direct=${distDirect.toFixed(3)} swapped=${distSwapped.toFixed(3)}`);
                        } else {
                          console.log(`[CBL_FIX_NOSE_SKIP] ratio=${(distSwapped/distDirect).toFixed(3)} sw0=${sw0.toFixed(3)} sw1=${sw1.toFixed(3)} psw0=${psw0.toFixed(3)} psw1=${psw1.toFixed(3)}`);
                        }
                      } else {
                        console.log(`[CBL_FIX_SKIP] no shoulder (sw0=${sw0.toFixed(3)} sw1=${sw1.toFixed(3)}) and missing nose: n0Old=${!!slots[0].nose} n1Old=${!!slots[1].nose} n0New=${!!(all[si0]?.[0])} n1New=${!!(all[si1]?.[0])}`);
                      }
                    }
                  }

                  // ── 常時クロス照合（SW_HEAL）— genderLocked 後・毎フレーム ─────────────
                  // justSeparated を待たず、ロック時の肩幅定数と現フレームの xspan を比較。
                  // 「じわじわ逆転」「分離後しばらく経ってからの入れ替わり」に即応する。
                  if (genderLockedRef.current && !manualRoleLockedRef.current
                      && si0 >= 0 && si1 >= 0
                      && lockedShoulderWidthRef.current[0] > 0 && lockedShoulderWidthRef.current[1] > 0) {
                    const healSW0 = compute3DSW(all[si0]);
                    const healSW1 = compute3DSW(all[si1]);
                    const lsw0 = lockedShoulderWidthRef.current[0];
                    const lsw1 = lockedShoulderWidthRef.current[1];
                    const minLocked = Math.min(lsw0, lsw1);
                    // 横向きガード: 両者とも最小ロック幅の 60% 以上のときのみ判定
                    if (healSW0 >= minLocked * 0.60 && healSW1 >= minLocked * 0.60) {
                      const errDirect  = Math.abs(healSW0 - lsw0) + Math.abs(healSW1 - lsw1);
                      const errSwapped = Math.abs(healSW0 - lsw1) + Math.abs(healSW1 - lsw0);
                      if (errSwapped < errDirect * 0.80) {
                        [si0, si1] = [si1, si0];
                        console.log(`[SW_HEAL] continuous swap: direct=${errDirect.toFixed(3)} swapped=${errSwapped.toFixed(3)} ratio=${(errSwapped/errDirect).toFixed(3)} sw0=${healSW0.toFixed(3)} sw1=${healSW1.toFixed(3)} lsw=[${lsw0.toFixed(3)},${lsw1.toFixed(3)}]`);
                      }
                    }
                  }

                  // スロット自身に「今フレームで誰を指しているか」を記憶させる
                  slots[0].detectedIdx = si0;
                  slots[1].detectedIdx = si1;
                  const personRoles = new Map<number, PersonRole>();

                  // ── 顔性別判定スキャン（非同期 fire-and-forget、500msごと）────────────
                  if (faceModelsLoadedRef.current
                      && faceapiRef.current
                      && !faceLockedRef.current
                      && !faceScanningRef.current
                      && now - lastFaceScanRef.current >= FACE_SCAN_INTERVAL_MS
                      && all.length >= 2) {
                    faceScanningRef.current = true;
                    lastFaceScanRef.current = now;
                    const vw = video.videoWidth  || 1;
                    const vh = video.videoHeight || 1;
                    const fa = faceapiRef.current;
                    void (async () => {
                      try {
                        // ── ROI スキャン（スロットごとに nose 周辺をクロップして detectSingleFace）
                        const roiOpts = new fa.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.3 });
                        const fullOpts = new fa.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 });
                        const roiCanvas = faceRoiCanvasRef.current ?? document.createElement('canvas');
                        faceRoiCanvasRef.current = roiCanvas;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const roiDets: any[] = [];
                        let roiSlotIdx = 0;
                        for (const slot of slots) {
                          const curRoiIdx = roiSlotIdx++;
                          if (!slot.nose) continue;
                          const slotLm = slot.detectedIdx >= 0 ? all[slot.detectedIdx] : null;
                          const roi = computeFaceROI(slot.nose, slotLm, vw, vh, FACE_ROI_EAR_MULT);
                          if (!roi) continue;
                          roiCanvas.width  = roi.sw;
                          roiCanvas.height = roi.sh;
                          const rc = roiCanvas.getContext('2d');
                          if (!rc) continue;
                          rc.drawImage(video, roi.sx, roi.sy, roi.sw, roi.sh, 0, 0, roi.sw, roi.sh);
                          // ROIプレビュー用キャンバスにコピー（RAFループで左下に描画）
                          let pv = faceRoiPreviewsRef.current[curRoiIdx as 0|1];
                          if (!pv) { pv = document.createElement('canvas'); faceRoiPreviewsRef.current[curRoiIdx as 0|1] = pv; }
                          pv.width = roi.sw; pv.height = roi.sh;
                          pv.getContext('2d')?.drawImage(roiCanvas, 0, 0);
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          const det = await (fa.detectSingleFace(roiCanvas, roiOpts) as any).withAgeAndGender();
                          if (det) {
                            // ROI 相対座標 → 全体フレーム絶対座標に変換
                            roiDets.push({
                              detection: { box: {
                                x: roi.sx + det.detection.box.x, y: roi.sy + det.detection.box.y,
                                width: det.detection.box.width,  height: det.detection.box.height,
                              }},
                              gender: det.gender,
                              genderProbability: det.genderProbability,
                            });
                          }
                        }
                        // ROI で全スロット分取れなかった場合 → 全体スキャンにフォールバック
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        let dets: any[];
                        if (roiDets.length >= all.length) {
                          dets = roiDets;
                          console.log(`[FACE_SCAN] ROI hit ${roiDets.length}/${all.length}`);
                        } else {
                          dets = await fa.detectAllFaces(video, fullOpts).withAgeAndGender();
                          console.log(`[FACE_SCAN] ROI miss(${roiDets.length}/${all.length}) → full scan: ${(dets as any[]).length} faces`);
                        }
                        // 全検出を可視化用 ref に保存（信頼度問わず）
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        faceVisualizationRef.current = (dets as any[]).map((d: any) => ({
                          normX: d.detection.box.x / vw,
                          normY: d.detection.box.y / vh,
                          normW: d.detection.box.width  / vw,
                          normH: d.detection.box.height / vh,
                          gender: d.gender,
                          prob: d.genderProbability,
                        }));
                        // 高信頼度のみロール判定用に保存
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        faceScanResultsRef.current = (dets as any[])
                          .filter((d: any) => d.genderProbability >= FACE_GENDER_CONFIDENCE)
                          .map((d: any) => ({
                            normX: (d.detection.box.x + d.detection.box.width  * 0.5) / vw,
                            normY: (d.detection.box.y + d.detection.box.height * 0.5) / vh,
                            gender: d.gender as 'male' | 'female',
                            genderProb: d.genderProbability,
                          }));
                        console.log(`[FACE_SCAN] ${(dets as any[]).length} faces detected, ${faceScanResultsRef.current.length} high-conf`);
                        // 全検出をスロットに照合してタイムスタンプ・信頼度を記録（ロック前後・信頼度問わず）
                        const scanNow = performance.now();
                        (dets as any[]).forEach((d: any) => {
                          const fcx = (d.detection.box.x + d.detection.box.width  * 0.5) / vw;
                          const fcy = (d.detection.box.y + d.detection.box.height * 0.5) / vh;
                          let bestSlot = -1, bestDist = 0.35;
                          slots.forEach((sl, si) => {
                            if (!sl.nose) return;
                            const dist = Math.hypot(fcx - sl.nose.x, fcy - sl.nose.y);
                            if (dist < bestDist) { bestDist = dist; bestSlot = si; }
                          });
                          if (bestSlot >= 0) {
                            slotFaceLastMatchTimeRef.current[bestSlot] = scanNow;
                            if (d.genderProbability > (slotFaceLastConfRef.current[bestSlot] ?? 0)) {
                              slotFaceLastConfRef.current[bestSlot] = d.genderProbability;
                            }
                            slotFaceGenderRef.current[bestSlot as 0|1] = d.gender as 'male'|'female';
                          }
                        });
                      } finally {
                        faceScanningRef.current = false;
                      }
                    })();
                  }

                  // ── face-api 結果をスロットに適用してロール確定 ──────────────────────
                  if (!faceLockedRef.current && !manualRoleLockedRef.current
                      && faceScanResultsRef.current.length >= 2) {
                    const males   = faceScanResultsRef.current.filter(r => r.gender === 'male');
                    const females = faceScanResultsRef.current.filter(r => r.gender === 'female');
                    if (males.length > 0 && females.length > 0) {
                      const male   = males.reduce((b, r) => r.genderProb > b.genderProb ? r : b);
                      const female = females.reduce((b, r) => r.genderProb > b.genderProb ? r : b);
                      // 鼻ランドマーク距離でどちらのスロットに対応するか決定
                      const distMS0 = slots[0].nose ? Math.hypot(male.normX   - slots[0].nose.x, male.normY   - slots[0].nose.y) : Infinity;
                      const distMS1 = slots[1].nose ? Math.hypot(male.normX   - slots[1].nose.x, male.normY   - slots[1].nose.y) : Infinity;
                      const distFS0 = slots[0].nose ? Math.hypot(female.normX - slots[0].nose.x, female.normY - slots[0].nose.y) : Infinity;
                      const distFS1 = slots[1].nose ? Math.hypot(female.normX - slots[1].nose.x, female.normY - slots[1].nose.y) : Infinity;
                      const maleSlot:   0 | 1 = distMS0 <= distMS1 ? 0 : 1;
                      const femaleSlot: 0 | 1 = distFS0 <= distFS1 ? 0 : 1;
                      if (maleSlot !== femaleSlot) {
                        slots[maleSlot].role   = 'leader';
                        slots[femaleSlot].role = 'follower';
                        slots[maleSlot].lockSource   = 'face';
                        slots[femaleSlot].lockSource = 'face';
                        faceLockedRef.current   = true;
                        genderLockedRef.current = true;
                        roleDetectedRef.current = true;
                        setRoleDetected(true);
                        setRoleConfidenceLow(false);
                        // ロック時の肩幅を定数として保存（常時クロス照合の基準値）
                        lockedShoulderWidthRef.current = [
                          slots[0].profile.shoulderSamples > 0 ? slots[0].profile.totalShoulderWidth / slots[0].profile.shoulderSamples : -1,
                          slots[1].profile.shoulderSamples > 0 ? slots[1].profile.totalShoulderWidth / slots[1].profile.shoulderSamples : -1,
                        ];
                        console.log(`[FACE_LOCK] male→slot${maleSlot}(leader) female→slot${femaleSlot}(follower) lsw=[${lockedShoulderWidthRef.current.map(v=>v.toFixed(3)).join(',')}]`);
                        slots.forEach(slot => {
                          if (slot.detectedIdx >= 0 && slot.role) personRoles.set(slot.detectedIdx, slot.role);
                        });
                      }
                    }
                  }

                  // ビート番号（役割判定に使用）
                  const currentBeatNum = bpmRef.current > 0
                    ? Math.floor((video.currentTime * bpmRef.current / 60) % 8) + 1
                    : undefined;


                  for (let s = 0; s < 2; s++) {
                    const si = s === 0 ? si0 : si1;
                    if (si < 0) {
                      // トラッキング途切れ: 速度外挿 + サイン波ブレンドで位置を予測
                      if (isOccludedRef.current && slots[s].hip) {
                        const phantom = buildPhantomPos(slots[s], slots[s].staleness + 1);
                        slots[s].phantomPos = phantom;
                        if (phantom) slots[s].hip = phantom;
                      }
                      slots[s].xHistory = [];
                      slots[s].staleness++;
                      if (slots[s].staleness >= SLOT_STALE_FRAMES) { slots[s].hip = null; slots[s].phantomPos = null; }
                      continue;
                    }
                    slots[s].staleness = 0;
                    const hip = computeMidHip(all[si]);
                    if (!hip) continue;
                    const newZ = ((all[si][23]?.z ?? 0) + (all[si][24]?.z ?? 0)) / 2;

                    // 速度を記録
                    if (slots[s].hip) {
                      slots[s].velX = hip.x - slots[s].hip!.x;
                      slots[s].velY = hip.y - slots[s].hip!.y;
                    }

                    // 顔アンカーを更新
                    const n = all[si][0];
                    if (n && (n.visibility ?? 1) >= VIS_THRESHOLD) {
                      slots[s].nose = { x: n.x, y: n.y };
                    }

                    // X方向履歴（位相モニタリング用）
                    if (slots[s].hip) {
                      const dx = hip.x - slots[s].hip!.x;
                      if (Math.abs(dx) > 0.004) {
                        slots[s].xHistory.push(Math.sign(dx));
                        if (slots[s].xHistory.length > PHASE_WINDOW + 2) slots[s].xHistory.shift();
                      }
                    }
                    slots[s].hip  = hip;
                    slots[s].hipZ = newZ;

                    // ── 物理ステートマシン: 角速度・位相更新 ──────────────
                    slots[s].omegaHist.push(hip.x);
                    if (slots[s].omegaHist.length > OMEGA_HIST_LEN) slots[s].omegaHist.shift();
                    const oHist = slots[s].omegaHist;
                    if (oHist.length >= 8) {
                      slots[s].omega = estimateOmegaFromHistory(oHist);
                      const xMin = Math.min(...oHist), xMax = Math.max(...oHist);
                      slots[s].angCenter    = (xMin + xMax) / 2;
                      slots[s].angAmplitude = (xMax - xMin) / 2;
                      if (slots[s].angAmplitude > 0.02) {
                        const sinVal   = Math.max(-1, Math.min(1, (hip.x - slots[s].angCenter) / slots[s].angAmplitude));
                        const rawPhase = Math.asin(sinVal);
                        // velX の符号でどの象限かを判定（cos の符号）
                        slots[s].angPhase = slots[s].velX >= 0 ? rawPhase : Math.PI - rawPhase;
                      }
                    }
                    slots[s].phantomPos = null; // 検出済みなのでリセット

                    // ── 体格プロファイル蓄積（プロファイリング期間中・2人同時検出時）
                    // genderLocked 後は蓄積停止 — ロール確定後に別人のデータが混入するのを防ぐ
                    if (si0 >= 0 && si1 >= 0 && !genderLockedRef.current) {
                      const lm = all[si];
                      const nose = lm[0], sL = lm[11], sR = lm[12], hL = lm[23], hR = lm[24], aL = lm[27], aR = lm[28];
                      if (nose && aL && aR && (nose.visibility ?? 1) >= VIS_THRESHOLD) {
                        slots[s].profile.totalHeight    += Math.abs(nose.y - (aL.y + aR.y) / 2);
                        const nh = getNormalizedHeight(lm);
                        if (nh > 0) slots[s].profile.totalNormHeight += nh;
                        slots[s].profile.sampleCount++;
                      }
                      const hbr = getHeadBodyRatio(lm);
                      if (hbr > 0) {
                        slots[s].profile.totalHeadBodyRatio += hbr;
                        slots[s].profile.ratioSamples++;
                      }
                      if (sL && sR && (sL.visibility ?? 1) >= VIS_THRESHOLD && (sR.visibility ?? 1) >= VIS_THRESHOLD) {
                        // 3D XZ平面距離 — 横向き時も肩幅をゼロにしない
                        const sw3d = Math.hypot(sR.x - sL.x, (sR.z ?? 0) - (sL.z ?? 0));
                        slots[s].profile.totalShoulderWidth += sw3d;
                        slots[s].profile.shoulderSamples++;
                        // 最大2D X肩幅（Zノイズなし — 正面時のベスト値を自動取得）
                        const sw2d = Math.abs(sR.x - sL.x);
                        if (sw2d > slots[s].profile.maxShoulderX) slots[s].profile.maxShoulderX = sw2d;
                      }
                      if (hL && hR && (hL.visibility ?? 1) >= VIS_THRESHOLD && (hR.visibility ?? 1) >= VIS_THRESHOLD) {
                        // 3D XZ平面距離
                        const hw3d = Math.hypot(hR.x - hL.x, (hR.z ?? 0) - (hL.z ?? 0));
                        slots[s].profile.totalHipWidth += hw3d;
                        slots[s].profile.hipSamples++;
                        // 最大2D X腰幅（Zノイズなし）
                        const hw2d = Math.abs(hR.x - hL.x);
                        if (hw2d > slots[s].profile.maxHipX) slots[s].profile.maxHipX = hw2d;
                      }
                      // 耳幅（landmark 7=左耳, 8=右耳）: 顔幅の代理指標
                      const eL = lm[7], eR = lm[8];
                      if (eL && eR && (eL.visibility ?? 1) >= VIS_THRESHOLD && (eR.visibility ?? 1) >= VIS_THRESHOLD) {
                        slots[s].profile.totalEarWidth += Math.abs(eR.x - eL.x);
                      }

                      // ── 鼻-左耳-右耳 三角形面積（Hair & Head Volume）
                      const noseL = lm[0];
                      if (noseL && eL && eR
                          && (noseL.visibility ?? 1) >= VIS_THRESHOLD
                          && (eL.visibility ?? 1) >= VIS_THRESHOLD
                          && (eR.visibility ?? 1) >= VIS_THRESHOLD) {
                        const triArea = 0.5 * Math.abs(
                          (eL.x - noseL.x) * (eR.y - noseL.y) - (eR.x - noseL.x) * (eL.y - noseL.y),
                        );
                        slots[s].profile.totalHeadTriangleArea += triArea;
                      }

                      // ── 正面向きフレームのみ蓄積（遠近法不変の SHR 計算用）
                      if (isFrontalPose(lm)) {
                        const fSW = sL && sR
                          && (sL.visibility ?? 1) >= VIS_THRESHOLD
                          && (sR.visibility ?? 1) >= VIS_THRESHOLD
                          ? Math.abs(sR.x - sL.x) : 0;  // 正面なので 2D Xで十分
                        const fHW = hL && hR
                          && (hL.visibility ?? 1) >= VIS_THRESHOLD
                          && (hR.visibility ?? 1) >= VIS_THRESHOLD
                          ? Math.abs(hR.x - hL.x) : 0;
                        const fNose = lm[0], fAnkL = lm[27], fAnkR = lm[28];
                        const fBH = fNose && fAnkL && fAnkR
                          && (fNose.visibility ?? 1) >= VIS_THRESHOLD
                          ? Math.abs(fNose.y - (fAnkL.y + fAnkR.y) / 2) : 0;
                        // 肩幅・腰幅・身長が全て取れたフレームのみ蓄積（揃ったデータで SHR を計算）
                        if (fSW > 0 && fHW > 0 && fBH > 0) {
                          slots[s].profile.frontalShoulderWidth += fSW;
                          slots[s].profile.frontalHipWidth      += fHW;
                          slots[s].profile.frontalBodyHeight    += fBH;
                          slots[s].profile.frontalSampleCount++;
                        }
                      }

                      // ── 準備動作検出（フレーム 5 〜 PROFILE_FRAMES）
                      slots[s].coldFrameCount++;
                      const cf = slots[s].coldFrameCount;
                      if (cf >= 5 && cf <= PROFILE_FRAMES) {
                        const ankleL2 = lm[27], ankleR2 = lm[28];
                        const hasAnkle = ankleL2 && ankleR2
                          && (ankleL2.visibility ?? 1) >= VIS_THRESHOLD
                          && (ankleR2.visibility ?? 1) >= VIS_THRESHOLD;
                        const ankleMid = hasAnkle
                          ? { x: (ankleL2!.x + ankleR2!.x) / 2, y: (ankleL2!.y + ankleR2!.y) / 2 }
                          : null;
                        const hipMovY = Math.abs(slots[s].velY); // 腰のY速度
                        if (ankleMid && slots[s].prevAnkleMid) {
                          const ankleMov = Math.hypot(
                            ankleMid.x - slots[s].prevAnkleMid!.x,
                            ankleMid.y - slots[s].prevAnkleMid!.y,
                          );
                          // 足首静止 + 腰先行 → Leader
                          if (ankleMov < ANKLE_STILL_THRESH && hipMovY > HIP_MOVE_THRESH) {
                            slots[s].profile.coldPrepLeader++;
                          }
                          // 垂直ヒップ振動大 → Follower
                          if (hipMovY > HIP_MOVE_THRESH * 1.5) {
                            slots[s].profile.coldPrepFollower++;
                          }
                        }
                        if (ankleMid) slots[s].prevAnkleMid = ankleMid;
                      }
                    }

                    if (slots[s].role) personRoles.set(si, slots[s].role);
                  }

                  // ── Z-order 更新（両者同時検出フレームで手前/奥を判定）
                  if (si0 >= 0 && si1 >= 0) {
                    const frontIdx = getZOrderFront(all[si0], all[si1]);
                    slots[0].zFront = (frontIdx === 0);
                    slots[1].zFront = (frontIdx === 1);
                  }

                  // ── ダンス動力学スコア更新（Inception / Centripetal / Space Management）
                  updateDynamicsScores(slots, all, si0, si1, prevSlotDist, frameIndexRef.current);

                  // ── ロール変更パスは3つのみ ─────────────────────────────────────────
                  // ① ps確定（Cold Start: n≥8フレームで即時発火）
                  // ② psリアクティブチェック（毎フレーム: genderLocked中の矛盾を自動修正）
                  // ③ 手動Swap（manualRoleLocked: ユーザーの判断が最優先）

                  // ── プロファイリング完了フラグ（ロール確定は reactive check に一本化）────
                  // 早まった確信（逆転0.5秒バグ）を防ぐため、ここでは断言しない。
                  // データが十分に溜まり確信度が閾値を超えた瞬間に reactive check がロックする。
                  if (!profileCompleteRef.current
                      && slots[0].profile.shoulderSamples >= PROFILE_FRAMES
                      && slots[1].profile.shoulderSamples >= PROFILE_FRAMES
                      && slots[0].profile.hipSamples >= PROFILE_FRAMES
                      && slots[1].profile.hipSamples >= PROFILE_FRAMES) {
                    profileCompleteRef.current = true;
                    profileCompleteTimeRef.current = now;
                    const remainMs = Math.max(0, FACE_SCAN_SUSPEND_MS - (now - initTimeRef.current));
                    console.log(`[PROFILE_COMPLETE] face suspend remaining=${remainMs.toFixed(0)}ms (initAge=${(now-initTimeRef.current).toFixed(0)}ms)`);
                  }

                  // ── ロール割り当ては ps（3D SHR）完了時のみ。BPM暫定・逆ロール伝播は廃止 ──
                  // 第0原則: ロールを変更できる唯一のパスは assignRolesByProfile（ps値比較）。
                  prevBeatNumRef.current = currentBeatNum;

                  // ── 位相モニタリング（同方向移動 = 解析エラー）
                  // ターン中・直後（2秒間）は抑制 — ターン時は両者が同方向に動くのが正常
                  // 両者が同時にトラッキングされているフレームのみ実行（stale履歴による誤検知防止）
                  const TURN_SUPPRESS_SEC = 2.0;
                  const sinceLastTurn = video.currentTime - lastTurnTimeRef.current;
                  if (roleDetectedRef.current && sinceLastTurn > TURN_SUPPRESS_SEC && si0 >= 0 && si1 >= 0) {
                    const ls = slots.find(s => s.role === 'leader');
                    const fs = slots.find(s => s.role === 'follower');
                    if (ls && fs && ls.xHistory.length >= PHASE_WINDOW && fs.xHistory.length >= PHASE_WINDOW) {
                      const lr = ls.xHistory.slice(-PHASE_WINDOW);
                      const fr = fs.xHistory.slice(-PHASE_WINDOW);
                      const allSame = lr.every((d, i) => d !== 0 && d === fr[i]);
                      if (allSame !== syncErrorRef.current) {
                        syncErrorRef.current = allSame;
                        setSyncError(allSame);
                      }
                    }
                  } else if (syncErrorRef.current && (sinceLastTurn <= TURN_SUPPRESS_SEC || si0 < 0 || si1 < 0)) {
                    // ターン中 or 片方がトラッキング不能な場合はエラーを自動クリア（stale状態での誤表示防止）
                    syncErrorRef.current = false;
                    setSyncError(false);
                  }

                  // ── ps 統一判定チェック（profileComplete後・毎フレーム実行）────────────
                  // genderLocked 前: 確信度閾値を超えた瞬間に初回ロール確定（グレー→色）
                  // genderLocked 後: 逆転があれば即時修正（整合維持）
                  // manualLocked 中: ユーザー判断を最優先（変更しない）
                  // SHR サスペンド: profileComplete 後 FACE_SCAN_SUSPEND_MS 以内は face 優先
                  // face モデルが未ロードの間はタイムアウトまで待機（CDN 遅延・失敗対応）
                  // face が確定するまで（またはタイムアウトまで）SHR を凍結
                  // 旧: モデル未ロード時のみ待機 → 新: face未確定かつ15s以内は常に凍結
                  const faceSuspending = !faceLockedRef.current
                    && initTimeRef.current > 0
                    && now - initTimeRef.current < FACE_SCAN_SUSPEND_MS;
                  if (profileCompleteRef.current && !manualRoleLockedRef.current && !faceLockedRef.current && !faceSuspending) {
                    const ps0 = profileLeaderScore(slots[0].profile, 1);
                    const ps1 = profileLeaderScore(slots[1].profile, 1);
                    if (ps0 > 0 && ps1 > 0) {
                      const exp0: PersonRole = ps0 >= ps1 ? 'leader' : 'follower';
                      const exp1: PersonRole = ps0 >= ps1 ? 'follower' : 'leader';
                      if (!genderLockedRef.current) {
                        // 初回判定: 以下の3条件を全て満たしたらロック確定
                        // 1. SHR差が確信度閾値以上（ノイズと区別できる差）
                        // 2. 両者の肩幅が最小値以上（正面を向いているフレームが含まれている証拠）
                        // 3. 正面サンプルが1以上（または maxShoulderX が最小値以上）
                        const hasReliableData =
                          slots[0].profile.maxShoulderX >= MIN_FRONTAL_SHOULDER_WIDTH &&
                          slots[1].profile.maxShoulderX >= MIN_FRONTAL_SHOULDER_WIDTH;
                        if (Math.abs(ps0 - ps1) >= CONFIDENCE_THRESHOLD && hasReliableData) {
                          slots[0].role = exp0;
                          slots[1].role = exp1;
                          slots[0].lockSource = 'shr';
                          slots[1].lockSource = 'shr';
                          genderLockedRef.current  = true;
                          roleDetectedRef.current  = true;
                          setRoleDetected(true);
                          setRoleConfidenceLow(false);
                          // ロック時の肩幅を定数として保存（常時クロス照合の基準値）
                          lockedShoulderWidthRef.current = [
                            slots[0].profile.shoulderSamples > 0 ? slots[0].profile.totalShoulderWidth / slots[0].profile.shoulderSamples : -1,
                            slots[1].profile.shoulderSamples > 0 ? slots[1].profile.totalShoulderWidth / slots[1].profile.shoulderSamples : -1,
                          ];
                          console.log(`[SHR_LOCK] ps0=${ps0.toFixed(3)} ps1=${ps1.toFixed(3)} → slot0=${exp0} slot1=${exp1} lsw=[${lockedShoulderWidthRef.current.map(v=>v.toFixed(3)).join(',')}]`);
                          slots.forEach(slot => {
                            if (slot.detectedIdx >= 0 && slot.role) {
                              personRoles.set(slot.detectedIdx, slot.role);
                            }
                          });
                        }
                      } else {
                        // 整合維持: 逆転していれば即時修正
                        if (slots[0].role !== exp0 || slots[1].role !== exp1) {
                          slots[0].role = exp0;
                          slots[1].role = exp1;
                          slots.forEach(slot => {
                            if (slot.detectedIdx >= 0 && slot.role) {
                              personRoles.set(slot.detectedIdx, slot.role);
                            }
                          });
                        }
                      }
                    }
                  }

                  // ── フレームスナップショットをバッファに追加
                  {
                    const zOrderFront = slots[0].zFront ? 0 : slots[1].zFront ? 1 : -1;
                    const snapshot: FrameSnapshot = {
                      frameIndex: frameIndexRef.current,
                      videoTime: video.currentTime,
                      distanceBetweenPersons: slots[0].hip && slots[1].hip
                        ? Math.hypot(slots[0].hip.x - slots[1].hip.x, slots[0].hip.y - slots[1].hip.y)
                        : -1,
                      isOccluded: isOccludedRef.current,
                      zOrderFront,
                      persons: [],
                    };
                    for (let s = 0; s < 2; s++) {
                      const si = s === 0 ? si0 : si1;
                      const slot = slots[s];
                      const isDetected     = si >= 0;
                      const isOccludedSlot = si < 0 && !!slot.hip && isOccludedRef.current;
                      if (!isDetected && !isOccludedSlot) continue;

                      if (isDetected) {
                        const lm   = all[si];
                        const nose = lm[0], sL = lm[11], sR = lm[12], aL = lm[27], aR = lm[28];
                        const sw = sL && sR && (sL.visibility ?? 1) >= VIS_THRESHOLD && (sR.visibility ?? 1) >= VIS_THRESHOLD
                          ? Math.hypot(sR.x - sL.x, (sR.z ?? 0) - (sL.z ?? 0)) : -1;
                        const bh = nose && (nose.visibility ?? 1) >= VIS_THRESHOLD && (aL || aR)
                          ? Math.abs(nose.y - (((aL?.y ?? aR?.y ?? 0) + (aR?.y ?? aL?.y ?? 0)) / 2)) : -1;
                        snapshot.persons.push({
                          slotIdx: s as 0 | 1,
                          role: slot.role,
                          hipX: slot.hip!.x, hipY: slot.hip!.y, hipZ: slot.hipZ,
                          velX: slot.velX, velY: slot.velY,
                          shoulderWidth: sw, bodyHeight: bh,
                          noseX: nose && (nose.visibility ?? 1) >= VIS_THRESHOLD ? nose.x : -1,
                          noseY: nose && (nose.visibility ?? 1) >= VIS_THRESHOLD ? nose.y : -1,
                          predictedX: -1, predictedY: -1,
                          omega: slot.omega,
                          dynamicsScore: slot.dynamicsScore,
                        });
                      } else {
                        // 遮蔽中（未検出）: 予測座標のみ記録
                        snapshot.persons.push({
                          slotIdx: s as 0 | 1,
                          role: slot.role,
                          hipX: slot.hip!.x, hipY: slot.hip!.y, hipZ: slot.hipZ,
                          velX: slot.velX, velY: slot.velY,
                          shoulderWidth: -1, bodyHeight: -1,
                          noseX: -1, noseY: -1,
                          predictedX: slot.phantomPos?.x ?? -1,
                          predictedY: slot.phantomPos?.y ?? -1,
                          omega: slot.omega,
                          dynamicsScore: slot.dynamicsScore,
                        });
                      }
                    }
                    frameBufferRef.current.push(snapshot);
                    if (frameBufferRef.current.length > FRAME_BUFFER_SIZE) frameBufferRef.current.shift();
                    frameIndexRef.current++;

                    // post-scene 収集（Swap直後）
                    if (pendingAnnotationRef.current !== null) {
                      pendingAnnotationRef.current.postSceneData.push(snapshot);
                      if (pendingAnnotationRef.current.postSceneData.length >= POST_SCENE_FRAMES) {
                        const completed = pendingAnnotationRef.current;
                        pendingAnnotationRef.current = null;
                        annotationsRef.current = [...annotationsRef.current, completed];
                        setAnnotations([...annotationsRef.current]);
                      }
                    }

                    // ── デバッグパネル更新（毎フレーム — psとRole表示のズレをゼロに）
                    {
                      const zOF = slots[0].zFront ? 0 : slots[1].zFront ? 1 : -1;
                      // 各スロットの Cold Start スコアデバッグ値を計算
                      const makeDebugSlot = (s: 0 | 1): PoseDebugSlot => {
                        const si  = s === 0 ? si0 : si1;
                        const slot = slots[s];
                        const p   = slot.profile;
                        // 現フレームの SW/H（instantaneous）
                        let swh = 0, frontalNow = false;
                        if (si >= 0) {
                          const lm2 = all[si];
                          const sL2 = lm2[11], sR2 = lm2[12], n2 = lm2[0], a2L = lm2[27], a2R = lm2[28];
                          if (sL2 && sR2 && n2 && a2L && a2R
                              && (sL2.visibility ?? 1) >= VIS_THRESHOLD
                              && (sR2.visibility ?? 1) >= VIS_THRESHOLD
                              && (n2.visibility ?? 1) >= VIS_THRESHOLD) {
                            const sw2 = Math.hypot(sR2.x - sL2.x, (sR2.z ?? 0) - (sL2.z ?? 0));
                            const bh2 = Math.abs(n2.y - (a2L.y + a2R.y) / 2);
                            swh = bh2 > 0 ? sw2 / bh2 : 0;
                          }
                          frontalNow = isFrontalPose(lm2);
                        }
                        // プロファイル平均: 正しい sample count で正規化
                        const aSW = p.shoulderSamples > 0 ? p.totalShoulderWidth / p.shoulderSamples : 0;
                        const aH  = p.sampleCount    > 0
                          ? (p.totalNormHeight > 0 ? p.totalNormHeight : p.totalHeight) / p.sampleCount : 0;
                        // aHW は旧3D平均腰幅。現在は maxHipX を使用するため参照なし
                        // const aHW = p.hipSamples > 0 ? p.totalHipWidth / p.hipSamples : 0;
                        // プロファイル平均 SW/H
                        let swhAvg = 0;
                        if (p.frontalSampleCount >= MIN_FRONTAL_SAMPLES) {
                          const fSW = p.frontalShoulderWidth / p.frontalSampleCount;
                          const fBH = p.frontalBodyHeight    / p.frontalSampleCount;
                          swhAvg = fBH > 0 ? fSW / fBH : 0;
                        } else {
                          swhAvg = aH > 0 && aSW > 0 ? aSW / aH : 0;
                        }
                        // SHR — 実際のps値に使われる最大2D SHR
                        const shr = p.maxHipX > 0 ? p.maxShoulderX / p.maxHipX : 0;
                        return {
                          slotIdx: s,
                          role: slot.role,
                          lockSource: slot.lockSource,
                          dynamicsScore: slot.dynamicsScore,
                          omega: slot.omega,
                          zFront: slot.zFront,
                          isDetected: si >= 0,
                          swh,
                          swhAvg,
                          avgSW: aSW,
                          avgBH: aH,
                          shr,
                          frontalN: p.frontalSampleCount,
                          profileScore: profileLeaderScore(p, 1),  // 純粋な3D SHR値
                          profileSamples: p.shoulderSamples,  // 肩幅サンプル数を表示
                          shoulderSamples: p.shoulderSamples,
                          isFrontal: frontalNow,
                        };
                      };
                      const faceSuspNow = !faceModelsLoadedRef.current
                        && profileCompleteTimeRef.current > 0
                        && now - profileCompleteTimeRef.current < FACE_SCAN_SUSPEND_MS;
                      setDebugInfo({
                        slots: [makeDebugSlot(0), makeDebugSlot(1)],
                        isOccluded: isOccludedRef.current,
                        zOrderFront: zOF,
                        profileComplete: profileCompleteRef.current,
                        genderLocked: genderLockedRef.current,
                        manualLocked: manualRoleLockedRef.current,
                        faceLocked: faceLockedRef.current,
                        faceReady: faceModelsLoadedRef.current,
                        faceSuspending: faceSuspNow,
                      });
                    }
                  }

                  // ── 描画
                  const isLockMode = lockedRef.current !== null;

                  if (currentMode === 'trail') {
                    // 全員の骨格をゴースト（ロール色）で描画
                    for (let i = 0; i < all.length; i++) {
                      drawFullPerson(ctx, all[i], connections, lb, getRoleColors(personRoles.get(i) ?? null, false));
                    }
                    drawStepTrail(ctx, ankleHistoryRef.current, lb, true);
                    for (let i = 0; i < all.length; i++) {
                      drawRoleBadge(ctx, all[i], lb, personRoles.get(i) ?? null, cw, mirrored);
                      { const _si = slots.findIndex(sl => sl.detectedIdx === i);
                        drawFaceStatusBadge(ctx, all[i], lb, cw, mirrored,
                          !faceModelsLoadedRef.current ? 'loading' : faceLockedRef.current ? 'locked' : 'scanning',
                          _si >= 0 ? slotFaceLastConfRef.current[_si] : -1,
                          _si >= 0 && slotFaceLastMatchTimeRef.current[_si] >= 0 ? now - slotFaceLastMatchTimeRef.current[_si] : -1,
                          _si < 0 || !slotFaceGenderRef.current[_si] ? null
                            : (slotFaceGenderRef.current[_si] === 'male') === (personRoles.get(i) === 'leader'),
                        ); }
                    }

                  } else if (currentMode === 'full') {
                    if (isLockMode) {
                      drawFullPerson(ctx, all[targetIdx], connections, lb, getRoleColors(personRoles.get(targetIdx) ?? null, true));
                    } else {
                      for (let i = 0; i < all.length; i++) {
                        drawFullPerson(ctx, all[i], connections, lb, getRoleColors(personRoles.get(i) ?? null, i === targetIdx));
                      }
                    }
                    for (let i = 0; i < all.length; i++) {
                      drawRoleBadge(ctx, all[i], lb, personRoles.get(i) ?? null, cw, mirrored);
                      { const _si = slots.findIndex(sl => sl.detectedIdx === i);
                        drawFaceStatusBadge(ctx, all[i], lb, cw, mirrored,
                          !faceModelsLoadedRef.current ? 'loading' : faceLockedRef.current ? 'locked' : 'scanning',
                          _si >= 0 ? slotFaceLastConfRef.current[_si] : -1,
                          _si >= 0 && slotFaceLastMatchTimeRef.current[_si] >= 0 ? now - slotFaceLastMatchTimeRef.current[_si] : -1,
                          _si < 0 || !slotFaceGenderRef.current[_si] ? null
                            : (slotFaceGenderRef.current[_si] === 'male') === (personRoles.get(i) === 'leader'),
                        ); }
                    }

                  } else {
                    // salsa モード
                    if (isLockMode) {
                      drawSalsaPerson(ctx, all[targetIdx], lb, true, cw, mirrored);
                    } else {
                      for (let i = 0; i < all.length; i++) {
                        drawSalsaPerson(ctx, all[i], lb, i === targetIdx, cw, mirrored);
                      }
                    }
                    for (let i = 0; i < all.length; i++) {
                      drawRoleBadge(ctx, all[i], lb, personRoles.get(i) ?? null, cw, mirrored);
                      { const _si = slots.findIndex(sl => sl.detectedIdx === i);
                        drawFaceStatusBadge(ctx, all[i], lb, cw, mirrored,
                          !faceModelsLoadedRef.current ? 'loading' : faceLockedRef.current ? 'locked' : 'scanning',
                          _si >= 0 ? slotFaceLastConfRef.current[_si] : -1,
                          _si >= 0 && slotFaceLastMatchTimeRef.current[_si] >= 0 ? now - slotFaceLastMatchTimeRef.current[_si] : -1,
                          _si < 0 || !slotFaceGenderRef.current[_si] ? null
                            : (slotFaceGenderRef.current[_si] === 'male') === (personRoles.get(i) === 'leader'),
                        ); }
                    }
                  }

                  // ターゲットインジケーター（ロック中）
                  if (isLockMode) {
                    drawTargetIndicator(ctx, all[targetIdx], lb);
                    drawDebugOverlay(
                      ctx,
                      debugTapCanvasRef.current,
                      currentHip,
                      trackDist,
                      occlusionCountRef.current,
                      all.length,
                      lb, cw, mirrored,
                    );
                  }

                  // ── Pass2 楕円マスク境界線（デバッグ可視化）────────────────────────
                  // 骨格 ON 中のみ表示。ゴールド破線で「Pass1 で隠した顔エリア」を示す。
                  if (modeRef.current !== 'off' && ellipseMasksRef.current.length > 0) {
                    ctx.save();
                    ctx.strokeStyle = 'rgba(255, 210, 0, 0.80)';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([5, 3]);
                    for (const m of ellipseMasksRef.current) {
                      const ex  = lb.offsetX + m.cx * lb.renderW;
                      const ey  = lb.offsetY + m.cy * lb.renderH;
                      const erx = m.rx * lb.renderW;
                      const ery = m.ry * lb.renderH;
                      ctx.beginPath();
                      ctx.ellipse(ex, ey, erx, ery, 0, 0, Math.PI * 2);
                      ctx.stroke();
                    }
                    ctx.setLineDash([]);
                    ctx.restore();
                  }

                  // ── 顔認識 bbox 描画（face-api.js 可視化）──────────────────────────
                  if (faceVisualizationRef.current.length > 0) {
                    ctx.save();
                    for (const fv of faceVisualizationRef.current) {
                      const nx = mirrored ? 1 - fv.normX - fv.normW : fv.normX;
                      const bx = lb.offsetX + nx * lb.renderW;
                      const by = lb.offsetY + fv.normY * lb.renderH;
                      const bw = fv.normW * lb.renderW;
                      const bh = fv.normH * lb.renderH;
                      const isMale = fv.gender === 'male';
                      const col = isMale ? '#00aaff' : '#ff44cc';
                      const hiConf = fv.prob >= FACE_GENDER_CONFIDENCE;
                      ctx.strokeStyle = col;
                      ctx.lineWidth   = hiConf ? 3 : 1.5;
                      ctx.globalAlpha = hiConf ? 0.95 : 0.55;
                      ctx.setLineDash(hiConf ? [] : [4, 4]);
                      ctx.strokeRect(bx, by, bw, bh);
                      ctx.setLineDash([]);
                      ctx.globalAlpha = 1;
                      ctx.fillStyle = col;
                      ctx.font = 'bold 13px monospace';
                      const label = `${isMale ? 'M' : 'F'} ${(fv.prob * 100).toFixed(0)}%`;
                      const lx = mirrored ? bx + bw : bx;
                      ctx.fillText(label, lx, by > 16 ? by - 4 : by + bh + 14);
                    }
                    ctx.restore();
                  }

                  // ── スロット状態オーバーレイ（右下コーナー）──────────────────────
                  {
                    ctx.save();
                    ctx.font = 'bold 11px monospace';
                    const lines = [
                      `face: ${faceModelsLoadedRef.current ? 'READY' : 'loading...'}`,
                      `faceLock: ${faceLockedRef.current ? 'YES' : 'no'}`,
                      ...slots.map((sl, i) => {
                        const r = sl.role ?? 'gray';
                        const src = sl.lockSource ?? '-';
                        return `S${i}: ${r} [${src}]`;
                      }),
                    ];
                    const lineH = 15;
                    const boxW  = 150;
                    const boxH  = lines.length * lineH + 8;
                    const bx2   = cw - boxW - 8;
                    const by2   = ch - boxH - 8;
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillRect(bx2, by2, boxW, boxH);
                    lines.forEach((ln, idx) => {
                      const isSlot = idx >= 2;
                      if (isSlot) {
                        const sl = slots[idx - 2];
                        ctx.fillStyle = sl.role === 'leader' ? '#66aaff'
                          : sl.role === 'follower' ? '#ff66ee' : '#aaa';
                      } else {
                        ctx.fillStyle = '#fff';
                      }
                      ctx.fillText(ln, bx2 + 6, by2 + 6 + (idx + 1) * lineH);
                    });
                    ctx.restore();
                  }

                  // ── face-api ROIプレビュー（デバッグ: 左下に小さく表示）────────────────
                  if (faceModelsLoadedRef.current && !faceLockedRef.current) {
                    const PW = 90; // プレビュー幅 (px)
                    const PAD = 4;
                    ctx.save();
                    let previewY = ch - PAD;
                    for (let s = 1; s >= 0; s--) {
                      const pv = faceRoiPreviewsRef.current[s];
                      if (!pv || pv.width === 0 || pv.height === 0) continue;
                      const ph = Math.round(pv.height * PW / pv.width);
                      previewY -= ph;
                      ctx.drawImage(pv, PAD, previewY, PW, ph);
                      ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 1.5;
                      ctx.strokeRect(PAD, previewY, PW, ph);
                      ctx.fillStyle = '#ffcc00'; ctx.font = 'bold 9px monospace';
                      ctx.fillText(`ROI S${s}`, PAD + 2, previewY + ph - 3);
                      previewY -= PAD;
                    }
                    ctx.restore();
                  }

                  // ビートフェーズインジケーター（BPM設定時）
                  if (bpmRef.current > 0) {
                    drawBeatIndicator(ctx, cw, ch, bpmRef.current, video.currentTime, mirrored);
                  }
                }
              } catch {
                // 初期化中などの一時的エラーは無視
              }
            }
          }
        }

        rafRef.current = requestAnimationFrame(loop);
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    init().catch(console.error);

    return () => {
      cancelled = true;
      activeRef.current = false;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      landmarkerRef.current?.close?.();
      landmarkerRef.current = null;
    };
  }, [enabled, videoRef, canvasRef]);

  return { lockAt, unlock, isLocked, sequence, clearSequence, syncError, clearRoles, roleDetected, swapRoles, annotations, exportDebugLog, debugInfo, roleConfidenceLow };
}
