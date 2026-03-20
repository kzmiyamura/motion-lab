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
  persons: Array<{
    slotIdx: 0 | 1;
    role: PersonRole;
    hipX: number; hipY: number; hipZ: number;
    velX: number; velY: number;      // 正規化座標/フレーム
    shoulderWidth: number;           // 正規化座標。-1 = 不明
    bodyHeight: number;              // 鼻〜足首中点（正規化）。-1 = 不明
    noseX: number; noseY: number;    // -1 = 不明
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
  totalHeight: number;         // 鼻〜足首中点の2D累積（生値）
  totalNormHeight: number;     // パース補正済み身長の累積
  totalHeadBodyRatio: number;  // (鼻〜足首) / (耳幅) の累積 — パース不変量
  totalShoulderWidth: number;  // 肩幅の累積
  totalHipWidth: number;       // 腰幅の累積
  sampleCount: number;         // 有効サンプル数
  ratioSamples: number;        // headBodyRatio の有効サンプル数
}
const makeProfile = (): PersonProfile => ({
  totalHeight: 0, totalNormHeight: 0, totalHeadBodyRatio: 0,
  totalShoulderWidth: 0, totalHipWidth: 0, sampleCount: 0, ratioSamples: 0,
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
const PROFILE_FRAMES    = 30;    // 体格プロファイリング期間（フレーム数）
const OCCLUSION_DIST    = 0.18;  // オクルージョン判定距離（正規化座標）
// 合成人体フィルタ定数（同色衣装で2人が1体として誤検出されるケースを除去）
const MAX_BODY_HEIGHT   = 0.72;  // 正規化座標での最大有効体長（これ以上は合成人体）
const MIN_UL_RATIO      = 0.22;  // 上半身/下半身比の最小値
const MAX_UL_RATIO      = 4.5;   // 上半身/下半身比の最大値
const FRAME_BUFFER_SIZE = 90;    // フレームバッファサイズ（~3秒分）
const POST_SCENE_FRAMES = 5;     // Swap後に収集するフレーム数

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

// ── 体格スコア（リーダーらしさ） ─────────────────────────────────────────
function profileLeaderScore(p: PersonProfile, heightWeight: number): number {
  if (p.sampleCount === 0) return 0;
  // パース補正済み身長を優先、なければ生身長
  const avgH  = p.sampleCount > 0
    ? (p.totalNormHeight > 0 ? p.totalNormHeight : p.totalHeight) / p.sampleCount
    : 0;
  const avgSW = p.totalShoulderWidth / p.sampleCount;
  const avgHW = p.totalHipWidth      / p.sampleCount;
  const ratio = avgHW > 0 ? avgSW / avgHW : 1; // 逆三角形指数
  return avgH * heightWeight + ratio;
}

function assignRolesByProfile(slots: [RoleSlot, RoleSlot], useHeight: boolean): void {
  const w = useHeight ? 3 : 1;
  const s0 = profileLeaderScore(slots[0].profile, w);
  const s1 = profileLeaderScore(slots[1].profile, w);
  if (s0 >= s1) { slots[0].role = 'leader'; slots[1].role = 'follower'; }
  else          { slots[0].role = 'follower'; slots[1].role = 'leader'; }
}

// ── ロールスロットマッチング（顔アンカー優先 + Nearest Neighbor） ─────────

function matchRoleSlots(
  all: NormalizedLandmark[][],
  slots: [RoleSlot, RoleSlot],
  useNosePrimary: boolean,   // オクルージョン離脱直後や顔分離確認時に true
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

  // ─ 通常: 腰ベース Nearest Neighbor
  for (let s = 0; s < 2; s++) {
    if (!slots[s].hip) {
      for (let i = 0; i < all.length; i++) {
        if (!used.has(i) && hips[i]) { result[s] = i; used.add(i); break; }
      }
      continue;
    }
    let minDist = ROLE_MATCH_DIST, best = -1;
    for (let i = 0; i < all.length; i++) {
      if (used.has(i)) continue;
      const h = hips[i]; if (!h) continue;
      const d = Math.hypot(h.x - slots[s].hip!.x, h.y - slots[s].hip!.y);
      if (d < minDist) { minDist = d; best = i; }
    }
    if (best >= 0) { result[s] = best; used.add(best); }
  }
  return result;
}

// ── 2パスカスケード用ヘルパー ─────────────────────────────────────────────

/** ランドマーク群のバウンディングボックスを返す（正規化座標） */
function getBoundingBox(
  lm: NormalizedLandmark[], padding = 0.08,
): { x: number; y: number; w: number; h: number } {
  const vis = lm.filter(l => (l.visibility ?? 1) >= 0.2);
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
  });
  const roleSlots          = useRef<[RoleSlot, RoleSlot]>([makeRoleSlot(), makeRoleSlot()]);
  const roleDetectedRef    = useRef(false);
  const prevBeatNumRef     = useRef<number | undefined>(undefined);
  const [syncError, setSyncError]     = useState(false);
  const syncErrorRef       = useRef(false);
  const [roleDetected, setRoleDetected] = useState(false);

  // ── ハイブリッドアーキテクチャ用 Ref ────────────────────────────────────
  const offscreenCanvasRef  = useRef<HTMLCanvasElement | null>(null);     // iOS 2パス用
  const analysisCacheRef    = useRef<CachedResult[]>([]);                 // iOS キャッシュ
  const workerRef           = useRef<Worker | null>(null);                // PC Worker
  const workerReadyRef      = useRef(false);
  const workerFailedRef     = useRef(false);
  const latestLandmarksRef  = useRef<NormalizedLandmark[][]>([]);         // Worker最新結果
  const lastCaptureRef      = useRef(0);                                  // Worker送信間隔

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
    roleSlots.current        = [makeRoleSlot(), makeRoleSlot()];
    roleDetectedRef.current  = false;
    profileCompleteRef.current = false;
    isOccludedRef.current    = false;
    analysisCacheRef.current = [];
    prevBeatNumRef.current   = undefined;
    syncErrorRef.current     = false;
    setSyncError(false);
    setRoleDetected(false);
    annotationsRef.current   = [];
    setAnnotations([]);
    pendingAnnotationRef.current = null;
  }, []);

  // ── Swap Roles（ロール反転 + アノテーション記録）
  const swapRoles = useCallback(() => {
    const slots = roleSlots.current;
    const r0 = slots[0].role;
    const r1 = slots[1].role;
    slots[0].role = r1;
    slots[1].role = r0;

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

    // iOS: オフスクリーンキャンバス初期化（2パス用）
    if (IS_IOS && !offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }

    async function init() {
      const connections: Connection[] = POSE_CONNECTIONS;
      let lastDetect = 0;

      if (IS_IOS) {
        // ── iOS: メインスレッドで MediaPipe を初期化 ──────────────────────
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
      } else {
        // ── PC: Web Worker で MediaPipe を非同期実行 ─────────────────────
        const worker = new Worker(
          new URL('../workers/salsaAnalyzer.worker.ts', import.meta.url),
          { type: 'module' },
        );
        workerRef.current = worker;
        worker.addEventListener('message', (ev: MessageEvent) => {
          if (cancelled) return;
          if (ev.data.type === 'ready') workerReadyRef.current = true;
          if (ev.data.type === 'result') latestLandmarksRef.current = ev.data.landmarks ?? [];
        });
        worker.addEventListener('error', () => { workerFailedRef.current = true; });
      }

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
          const shouldDetect = now - lastDetect >= detectIntervalRef.current;

          // PC: 毎フレーム描画（Worker 結果を常時反映）
          // iOS: 検出インターバル時のみ描画（バッテリー節約）
          if (!IS_IOS || shouldDetect) {
            if (shouldDetect) lastDetect = now;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              try {
                // ── 検出（デバイスに応じて分岐） ────────────────────────
                let all: NormalizedLandmark[][];

                if (IS_IOS) {
                  const lm = landmarkerRef.current;
                  if (!lm) throw new Error('landmarker not ready');
                  const rate = video.playbackRate;
                  if (rate <= SLOW_RATE_THRESHOLD) {
                    // 2パスカスケード + キャッシュ保存
                    const raw = runTwoPassDetect(lm, video, now, offscreenCanvasRef.current!);
                    all = raw.filter(isPoseCoherent);
                    analysisCacheRef.current.push({ time: video.currentTime, landmarks: all });
                    if (analysisCacheRef.current.length > CACHE_MAX_FRAMES) analysisCacheRef.current.shift();
                  } else {
                    // 通常速度: キャッシュ優先、キャッシュミス時は単一パス検出
                    const cached = findCachedResult(analysisCacheRef.current, video.currentTime);
                    if (cached !== null) {
                      all = cached;
                    } else {
                      const r = lm.detectForVideo(video, now);
                      all = (r.landmarks as NormalizedLandmark[][]).filter(isPoseCoherent);
                    }
                  }
                } else {
                  // PC: Worker にフレームを送信（interval 制御）、最新結果を使用
                  if (shouldDetect && workerReadyRef.current && !workerFailedRef.current) {
                    lastCaptureRef.current = now;
                    createImageBitmap(video).then(bitmap => {
                      workerRef.current?.postMessage({ type: 'detect', bitmap, timestamp: now }, [bitmap]);
                    }).catch(() => {});
                  }
                  all = latestLandmarksRef.current.filter(isPoseCoherent);
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

                  const [si0, si1] = matchRoleSlots(all, slots, facePriority);
                  const personRoles = new Map<number, PersonRole>();

                  // ビート番号（役割判定に使用）
                  const currentBeatNum = bpmRef.current > 0
                    ? Math.floor((video.currentTime * bpmRef.current / 60) % 8) + 1
                    : undefined;

                  // 速度計算用: 更新前の位置を保存
                  const prevSlotHips: (Centroid | null)[] = [slots[0].hip, slots[1].hip];
                  const prevZ = [slots[0].hipZ, slots[1].hipZ];

                  for (let s = 0; s < 2; s++) {
                    const si = s === 0 ? si0 : si1;
                    if (si < 0) {
                      // トラッキング途切れ: 速度で位置を予測（オクルージョン中の Re-ID 精度向上）
                      if (isOccludedRef.current && slots[s].hip) {
                        slots[s].hip = { x: slots[s].hip!.x + slots[s].velX, y: slots[s].hip!.y + slots[s].velY };
                      }
                      slots[s].xHistory = [];
                      slots[s].staleness++;
                      if (slots[s].staleness >= SLOT_STALE_FRAMES) slots[s].hip = null;
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
                        slots[s].profile.totalShoulderWidth += Math.abs(sR.x - sL.x);
                      }
                      if (hL && hR) {
                        slots[s].profile.totalHipWidth += Math.abs(hR.x - hL.x);
                      }
                    }

                    if (slots[s].role) personRoles.set(si, slots[s].role);
                  }

                  // ── プロファイル完成 → 体格ベースでロール初期割り当て
                  if (!profileCompleteRef.current && !roleDetectedRef.current
                      && slots[0].profile.sampleCount >= PROFILE_FRAMES
                      && slots[1].profile.sampleCount >= PROFILE_FRAMES) {
                    profileCompleteRef.current = true;
                    assignRolesByProfile(slots, heightLeaderHintRef.current);
                    roleDetectedRef.current = true;
                    setRoleDetected(true);
                    if (si0 >= 0) personRoles.set(si0, slots[0].role);
                    if (si1 >= 0) personRoles.set(si1, slots[1].role);
                  }

                  // ── プロファイル未完の場合: BPMがあれば暫定ロール割り当て（1人のみ検出でも可）
                  if (!roleDetectedRef.current && (si0 >= 0 || si1 >= 0) && currentBeatNum !== undefined) {
                    const breakBeat = styleRef.current === 'on1' ? 1 : 2;
                    if (currentBeatNum === breakBeat && prevBeatNumRef.current !== breakBeat) {
                      if (si0 >= 0 && si1 >= 0) {
                        // 2人同時検出かつプロファイル未完: Z軸差分で暫定判定
                        const dz0 = slots[0].hipZ - prevZ[0];
                        const dz1 = slots[1].hipZ - prevZ[1];
                        if (dz0 < dz1) { slots[0].role = 'leader'; slots[1].role = 'follower'; }
                        else           { slots[0].role = 'follower'; slots[1].role = 'leader'; }
                      } else {
                        // 1人のみ: 暫定リーダー
                        const s = si0 >= 0 ? 0 : 1;
                        slots[s].role = 'leader';
                      }
                      roleDetectedRef.current = true;
                      setRoleDetected(true);
                      if (si0 >= 0) personRoles.set(si0, slots[0].role);
                      if (si1 >= 0) personRoles.set(si1, slots[1].role);
                    }
                  }

                  // ── 2人目が初めて検出されたとき、逆ロールを自動割り当て
                  if (roleDetectedRef.current) {
                    for (let s = 0; s < 2; s++) {
                      const si = s === 0 ? si0 : si1;
                      if (si >= 0 && slots[s].role === null) {
                        const otherRole = slots[1 - s].role;
                        slots[s].role = otherRole === 'leader' ? 'follower'
                          : otherRole === 'follower' ? 'leader' : null;
                        if (slots[s].role) personRoles.set(si, slots[s].role);
                      }
                    }
                  }
                  prevBeatNumRef.current = currentBeatNum;

                  // ── オクルージョン離脱直後: 頭身比率でロール正当性を検証
                  if (justSeparated && si0 >= 0 && si1 >= 0 && profileCompleteRef.current) {
                    const p0 = slots[0].profile, p1 = slots[1].profile;
                    if (p0.ratioSamples > 0 && p1.ratioSamples > 0) {
                      const profRatio0 = p0.totalHeadBodyRatio / p0.ratioSamples;
                      const profRatio1 = p1.totalHeadBodyRatio / p1.ratioSamples;
                      const curRatio0  = getHeadBodyRatio(all[si0]);
                      const curRatio1  = getHeadBodyRatio(all[si1]);
                      if (curRatio0 > 0 && curRatio1 > 0) {
                        // 現在割り当て vs スワップ後 のどちらがプロファイルに近いか
                        const matchScore = Math.abs(curRatio0 - profRatio0) + Math.abs(curRatio1 - profRatio1);
                        const swapScore  = Math.abs(curRatio0 - profRatio1) + Math.abs(curRatio1 - profRatio0);
                        if (swapScore < matchScore * 0.80) {
                          // スワップの方がプロファイルに 20% 以上近い → ロールを自動修正
                          const r0 = slots[0].role, r1 = slots[1].role;
                          slots[0].role = r1; slots[1].role = r0;
                          if (si0 >= 0) personRoles.set(si0, slots[0].role);
                          if (si1 >= 0) personRoles.set(si1, slots[1].role);
                        }
                      }
                    }
                  }

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

                  // ── フレームスナップショットをバッファに追加
                  {
                    const snapshot: FrameSnapshot = {
                      frameIndex: frameIndexRef.current,
                      videoTime: video.currentTime,
                      distanceBetweenPersons: slots[0].hip && slots[1].hip
                        ? Math.hypot(slots[0].hip.x - slots[1].hip.x, slots[0].hip.y - slots[1].hip.y)
                        : -1,
                      persons: [],
                    };
                    for (let s = 0; s < 2; s++) {
                      const si = s === 0 ? si0 : si1;
                      if (si < 0 || !slots[s].hip) continue;
                      const lm    = all[si];
                      const prev  = prevSlotHips[s];
                      const nose  = lm[0], sL = lm[11], sR = lm[12], aL = lm[27], aR = lm[28];
                      const sw = sL && sR && (sL.visibility ?? 1) >= VIS_THRESHOLD && (sR.visibility ?? 1) >= VIS_THRESHOLD
                        ? Math.abs(sR.x - sL.x) : -1;
                      const bh = nose && (nose.visibility ?? 1) >= VIS_THRESHOLD && (aL || aR)
                        ? Math.abs(nose.y - (((aL?.y ?? aR?.y ?? 0) + (aR?.y ?? aL?.y ?? 0)) / 2)) : -1;
                      snapshot.persons.push({
                        slotIdx: s as 0 | 1,
                        role: slots[s].role,
                        hipX: slots[s].hip!.x, hipY: slots[s].hip!.y, hipZ: slots[s].hipZ,
                        velX: prev ? slots[s].hip!.x - prev.x : 0,
                        velY: prev ? slots[s].hip!.y - prev.y : 0,
                        shoulderWidth: sw, bodyHeight: bh,
                        noseX: nose && (nose.visibility ?? 1) >= VIS_THRESHOLD ? nose.x : -1,
                        noseY: nose && (nose.visibility ?? 1) >= VIS_THRESHOLD ? nose.y : -1,
                      });
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
      // iOS: MediaPipe メインスレッドリソース解放
      landmarkerRef.current?.close?.();
      landmarkerRef.current = null;
      // PC: Worker 終了
      if (!IS_IOS) {
        workerRef.current?.terminate();
        workerRef.current = null;
        workerReadyRef.current = false;
        workerFailedRef.current = false;
        latestLandmarksRef.current = [];
      }
    };
  }, [enabled, videoRef, canvasRef]);

  return { lockAt, unlock, isLocked, sequence, clearSequence, syncError, clearRoles, roleDetected, swapRoles, annotations, exportDebugLog };
}
