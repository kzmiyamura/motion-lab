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
  frontalBodyHeight: number;     // 正面向き時の身長（鼻〜足首）累積
  frontalSampleCount: number;    // 正面向きフレーム数
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
  frontalShoulderWidth: 0, frontalBodyHeight: 0, frontalSampleCount: 0,
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

/** analysisCache: スロー再生中の検出結果を保存し通常速度で再生する */
type CachedResult = { time: number; landmarks: NormalizedLandmark[][] };

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
function isPoseCoherent(lm: NormalizedLandmark[]): boolean {
  const nose = lm[0];
  const lSh = lm[11], rSh = lm[12];
  const lHip = lm[23], rHip = lm[24];
  const lAnk = lm[27], rAnk = lm[28];

  if (!lSh || !rSh || !lHip || !rHip) return true; // 必須点なし → 判定スキップ

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
 * 第0原則: 最大2D X-diff SHR (肩幅 / 腰幅) のみで Leader スコアを算出。
 *
 * max(|sR.x - sL.x|) / max(|hR.x - hL.x|) を使用。
 * - Zノイズの影響ゼロ（2D X座標のみ）
 * - 最大値を取るので正面向き時のベストフレームが自動選択される
 * - 男性は肩幅 >> 腰幅 → SHR高い。女性は腰幅 ≈ 肩幅 → SHR低い。
 *
 * 典型値: 男性（Leader）SHR > 1.10, 女性（Follower）SHR < 1.05
 */
function profileLeaderScore(p: PersonProfile, _heightWeight: number): number {
  if (p.maxShoulderX === 0 || p.maxHipX === 0) return 0;
  return p.maxShoulderX / p.maxHipX; // 最大2D SHR: Zノイズなし
}

/**
 * 体格プロファイル + dynamicsScore でロールを初期割り当てする。
 * Safety Guard: スコア差が CONFIDENCE_THRESHOLD 未満の場合は低確信度フラグを返す。
 * 低確信度時は初期判定を行うが、後続の dynamicsScore 蓄積による上書きを優先する。
 */
const CONFIDENCE_THRESHOLD = 0.05; // SHR差がこれ未満 → 低確信度（5%以内は体型が近い）

function assignRolesByProfile(
  slots: [RoleSlot, RoleSlot],
  _useHeight: boolean,
): { confidenceLow: boolean } {
  // 第0原則: 純粋な3D SHR（肩幅/腰幅）のみで判定
  const s0 = profileLeaderScore(slots[0].profile, 1);
  const s1 = profileLeaderScore(slots[1].profile, 1);
  if (s0 >= s1) { slots[0].role = 'leader'; slots[1].role = 'follower'; }
  else          { slots[0].role = 'follower'; slots[1].role = 'leader'; }
  const confidenceLow = Math.abs(s0 - s1) < CONFIDENCE_THRESHOLD;
  return { confidenceLow };
}

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

/**
 * 頭部＋胴体のランドマークのみでバウンディングボックスを返す（正規化座標）。
 * 手足を含めないことで、密着時に隣の人物を誤ってマスクするのを防ぐ。
 * 使用インデックス: 0-12（鼻・目・耳・肩）+ 23-24（腰）
 */
function getBoundingBox(
  lm: NormalizedLandmark[], padding = 0.08,
): { x: number; y: number; w: number; h: number } {
  // 頭部(0-8)・肩(11-12)・腰(23-24) のみ使用。肘〜手首・膝〜足首は除外
  const TORSO_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 23, 24];
  const vis = TORSO_IDX.map(i => lm[i]).filter(l => l && (l.visibility ?? 1) >= 0.2) as NormalizedLandmark[];
  if (!vis.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = vis.map(l => l.x), ys = vis.map(l => l.y);
  const x  = Math.max(0, Math.min(...xs) - padding);
  const y  = Math.max(0, Math.min(...ys) - padding);
  const x2 = Math.min(1, Math.max(...xs) + padding);
  const y2 = Math.min(1, Math.max(...ys) + padding);
  return { x, y, w: x2 - x, h: y2 - y };
}

/**
 * 2パスカスケード検出（iOS メインスレッド専用）
 * Pass1: 通常検出 → Pass2: 検出済みをグレーマスクで隠して再検出 → マージ
 */
function runTwoPassDetect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  landmarker: any,
  video: HTMLVideoElement,
  now: number,
  offCanvas: HTMLCanvasElement,
): NormalizedLandmark[][] {
  const r1 = landmarker.detectForVideo(video, now);
  const p1 = r1.landmarks as NormalizedLandmark[][];
  if (p1.length >= 2) return p1;

  const vw = video.videoWidth, vh = video.videoHeight;
  if (vw <= 0 || vh <= 0 || !p1.length) return p1;

  if (offCanvas.width !== vw || offCanvas.height !== vh) {
    offCanvas.width = vw; offCanvas.height = vh;
  }
  const ctx2 = offCanvas.getContext('2d');
  if (!ctx2) return p1;

  ctx2.drawImage(video, 0, 0);
  ctx2.fillStyle = '#808080';
  for (const lm of p1) {
    const b = getBoundingBox(lm);
    ctx2.fillRect(b.x * vw, b.y * vh, b.w * vw, b.h * vh);
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
  return merged;
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
    coldFrameCount: 0, prevAnkleMid: null,
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

  // ── ハイブリッドアーキテクチャ用 Ref ────────────────────────────────────
  const offscreenCanvasRef  = useRef<HTMLCanvasElement | null>(null);     // 2パスカスケード用
  const analysisCacheRef    = useRef<CachedResult[]>([]);                 // iOS キャッシュ

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
    analysisCacheRef.current = [];
    prevBeatNumRef.current   = undefined;
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
                    all = (r.landmarks as NormalizedLandmark[][]).filter(isPoseCoherent);
                  }
                } else {
                  // PC（常時）/ iOS スロー再生時: 2パスカスケード
                  const raw = runTwoPassDetect(lm, video, now, offscreenCanvasRef.current!);
                  all = raw.filter(isPoseCoherent);
                  // iOS スロー時はキャッシュに保存（通常速度で再生する際に再利用）
                  if (IS_IOS) {
                    analysisCacheRef.current.push({ time: video.currentTime, landmarks: all });
                    if (analysisCacheRef.current.length > CACHE_MAX_FRAMES) analysisCacheRef.current.shift();
                  }
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
                  if (genderLockedRef.current && !manualRoleLockedRef.current) {
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

                  const [si0, si1] = matchRoleSlots(all, slots, facePriority, justSeparated);
                  const personRoles = new Map<number, PersonRole>();

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
                    if (!profileCompleteRef.current && si0 >= 0 && si1 >= 0) {
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

                      // ── 正面向きフレームのみ蓄積（遠近法不変の SW/H 比率用）
                      if (isFrontalPose(lm)) {
                        // 正面向き時は Z 差が小さいため 2D でも可だが 3D に統一
                        const fSW = sL && sR ? Math.hypot(sR.x - sL.x, (sR.z ?? 0) - (sL.z ?? 0)) : 0;
                        const fNose = lm[0], fAnkL = lm[27], fAnkR = lm[28];
                        const fBH = fNose && fAnkL && fAnkR
                          && (fNose.visibility ?? 1) >= VIS_THRESHOLD
                          ? Math.abs(fNose.y - (fAnkL.y + fAnkR.y) / 2) : 0;
                        if (fSW > 0 && fBH > 0) {
                          slots[s].profile.frontalShoulderWidth += fSW;
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

                  // ── Cold Start: 3D SHR（肩幅/腰幅）による性別判定 → 初期ロール確定
                  // 第0原則: 向き・遠近・BPM暫定判定を問わず、PROFILE_FRAMES 分の骨格が揃った
                  // 瞬間に即時発火してロールを確定。一切のブロック条件なし。
                  if (!profileCompleteRef.current
                      && slots[0].profile.shoulderSamples >= PROFILE_FRAMES
                      && slots[1].profile.shoulderSamples >= PROFILE_FRAMES
                      && slots[0].profile.hipSamples >= PROFILE_FRAMES
                      && slots[1].profile.hipSamples >= PROFILE_FRAMES) {
                    profileCompleteRef.current  = true;
                    const { confidenceLow } = assignRolesByProfile(slots, heightLeaderHintRef.current);
                    setRoleConfidenceLow(confidenceLow);
                    roleDetectedRef.current     = true;
                    // 性別ハードロック: justSeparated/Self-Healing/FirstTurnを全封鎖
                    genderLockedRef.current     = true;
                    setRoleDetected(true);
                    if (si0 >= 0) personRoles.set(si0, slots[0].role);
                    if (si1 >= 0) personRoles.set(si1, slots[1].role);
                    // ── profileComplete発火フレームでdebugInfoを即時強制更新（スロットル待ちなし）
                    // ps値とRole表示が同一フレームで確定することを保証する
                    setDebugInfo({
                      slots: [0, 1].map(s => {
                        const sl = slots[s as 0 | 1];
                        const p  = sl.profile;
                        return {
                          slotIdx: s as 0 | 1,
                          role: sl.role,
                          dynamicsScore: sl.dynamicsScore,
                          omega: sl.omega,
                          zFront: sl.zFront,
                          isDetected: (s === 0 ? si0 : si1) >= 0,
                          swh: 0, swhAvg: 0,
                          avgSW: p.shoulderSamples > 0 ? p.totalShoulderWidth / p.shoulderSamples : 0,
                          avgBH: 0,
                          shr: p.maxHipX > 0 ? p.maxShoulderX / p.maxHipX : 0,
                          frontalN: p.frontalSampleCount,
                          profileScore: profileLeaderScore(p, 1),
                          profileSamples: p.shoulderSamples,
                          shoulderSamples: p.shoulderSamples,
                          isFrontal: false,
                        } as PoseDebugSlot;
                      }) as [PoseDebugSlot, PoseDebugSlot],
                      isOccluded: isOccludedRef.current,
                      zOrderFront: slots[0].zFront ? 0 : slots[1].zFront ? 1 : -1,
                      profileComplete: true,
                      genderLocked: true,
                      manualLocked: manualRoleLockedRef.current,
                    });
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

                  // ── ps リアクティブ整合チェック（第0原則の最終守護）────────────────
                  // 性別判定確定後・手動Swap前の状態で毎フレーム実行。
                  // ロールがps大小関係と逆転していれば即座に修正する。
                  // これにより、いかなるコードパスがロールを汚染しても1フレームで自動復旧。
                  if (genderLockedRef.current && !manualRoleLockedRef.current) {
                    const ps0 = profileLeaderScore(slots[0].profile, 1);
                    const ps1 = profileLeaderScore(slots[1].profile, 1);
                    if (ps0 > 0 && ps1 > 0) {
                      const exp0: PersonRole = ps0 >= ps1 ? 'leader' : 'follower';
                      const exp1: PersonRole = ps0 >= ps1 ? 'follower' : 'leader';
                      if (slots[0].role !== exp0 || slots[1].role !== exp1) {
                        slots[0].role = exp0;
                        slots[1].role = exp1;
                        if (si0 >= 0) personRoles.set(si0, exp0);
                        if (si1 >= 0) personRoles.set(si1, exp1);
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
                      setDebugInfo({
                        slots: [makeDebugSlot(0), makeDebugSlot(1)],
                        isOccluded: isOccludedRef.current,
                        zOrderFront: zOF,
                        profileComplete: profileCompleteRef.current,
                        genderLocked: genderLockedRef.current,
                        manualLocked: manualRoleLockedRef.current,
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
