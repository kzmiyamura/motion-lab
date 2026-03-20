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
const VIS_THRESHOLD = 0.5;

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
type RoleSlot    = { hip: Centroid | null; hipZ: number; role: PersonRole; xHistory: number[]; staleness: number };

// ── ロール描画カラー ──────────────────────────────────────────────────────
const COLOR_LEADER:   DrawColors = { line: '#0066ff', joint: '#66aaff', lw: 3,   jr: 5 };
const COLOR_FOLLOWER: DrawColors = { line: '#ff00cc', joint: '#ff66ee', lw: 3,   jr: 5 };
const COLOR_MAIN:     DrawColors = { line: 'rgba(255,60,60,0.95)',   joint: 'rgba(255,210,50,0.95)', lw: 3,   jr: 5 };
const COLOR_OTHER:    DrawColors = { line: 'rgba(255,255,255,0.45)', joint: 'rgba(200,200,200,0.50)', lw: 1.5, jr: 3 };

// ── ロール検出定数 ────────────────────────────────────────────────────────
const ROLE_MATCH_DIST   = 0.35;  // スロットマッチング距離閾値
const PHASE_WINDOW      = 6;     // 位相モニタリングウィンドウ（サンプル数）
const SLOT_STALE_FRAMES = 20;   // この連続フレーム数トラッキングが途切れたらスロット位置をリセット
const FRAME_BUFFER_SIZE = 90;    // フレームバッファサイズ（~3秒分）
const POST_SCENE_FRAMES = 5;     // Swap後に収集するフレーム数

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

// ── ロールスロットマッチング（Nearest Neighbor） ─────────────────────────

function matchRoleSlots(
  all: NormalizedLandmark[][],
  slots: [RoleSlot, RoleSlot],
): [number, number] {
  if (all.length === 0) return [-1, -1];
  const hips = all.map(lm => computeMidHip(lm));

  // 両スロット未初期化時: 最初の2人を割り当て
  if (!slots[0].hip && !slots[1].hip) {
    return [0, all.length > 1 ? 1 : -1];
  }

  const result: [number, number] = [-1, -1];
  const used = new Set<number>();

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
      const h = hips[i];
      if (!h) continue;
      const d = Math.hypot(h.x - slots[s].hip!.x, h.y - slots[s].hip!.y);
      if (d < minDist) { minDist = d; best = i; }
    }
    if (best >= 0) { result[s] = best; used.add(best); }
  }
  return result;
}

// ── フック本体 ────────────────────────────────────────────────────────────

export function usePoseEstimation(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  mode: VizMode,
  bpm = 0,
  isMirrored = false,
  salsaStyle: SalsaStyle = 'on1',
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
  const makeRoleSlot = (): RoleSlot => ({ hip: null, hipZ: 0, role: null, xHistory: [], staleness: 0 });
  const roleSlots          = useRef<[RoleSlot, RoleSlot]>([makeRoleSlot(), makeRoleSlot()]);
  const roleDetectedRef    = useRef(false);
  const prevBeatNumRef     = useRef<number | undefined>(undefined);
  const [syncError, setSyncError]     = useState(false);
  const syncErrorRef       = useRef(false);
  const [roleDetected, setRoleDetected] = useState(false);

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

    async function init() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision' as any) as any;
      if (cancelled) return;

      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      if (cancelled) return;

      const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: NUM_POSES,
        minPoseDetectionConfidence: VIS_THRESHOLD,
        minPosePresenceConfidence: VIS_THRESHOLD,
        minTrackingConfidence: VIS_THRESHOLD,
      });

      if (cancelled) { landmarker.close(); return; }
      landmarkerRef.current = landmarker;

      const connections: Connection[] = PoseLandmarker.POSE_CONNECTIONS as Connection[];
      let lastDetect = 0;

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
                const result = landmarker.detectForVideo(video, now);
                const all    = result.landmarks as NormalizedLandmark[][];

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
                  const [si0, si1] = matchRoleSlots(all, slots);
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
                      // トラッキング途切れ: xHistory をクリアして古い方向履歴による誤検知を防ぐ
                      slots[s].xHistory = [];
                      slots[s].staleness++;
                      // N フレーム以上途切れたらスロット位置をリセット → 再検出時に正しく再割り当て
                      if (slots[s].staleness >= SLOT_STALE_FRAMES) {
                        slots[s].hip = null;
                      }
                      continue;
                    }
                    slots[s].staleness = 0;
                    const hip = computeMidHip(all[si]);
                    if (!hip) continue;
                    const newZ = ((all[si][23]?.z ?? 0) + (all[si][24]?.z ?? 0)) / 2;
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
                    if (slots[s].role) personRoles.set(si, slots[s].role);
                  }

                  // ── ブレイクステップでロール判定（初回のみ）
                  if (!roleDetectedRef.current && si0 >= 0 && si1 >= 0 && currentBeatNum !== undefined) {
                    const breakBeat = styleRef.current === 'on1' ? 1 : 2;
                    if (currentBeatNum === breakBeat && prevBeatNumRef.current !== breakBeat) {
                      const dz0 = slots[0].hipZ - prevZ[0];
                      const dz1 = slots[1].hipZ - prevZ[1];
                      // deltaZ < 0 = 前方（カメラに近づく）= LEADER
                      if (dz0 < dz1) {
                        slots[0].role = 'leader'; slots[1].role = 'follower';
                      } else {
                        slots[0].role = 'follower'; slots[1].role = 'leader';
                      }
                      roleDetectedRef.current = true;
                      setRoleDetected(true);
                      if (si0 >= 0) personRoles.set(si0, slots[0].role);
                      if (si1 >= 0) personRoles.set(si1, slots[1].role);
                    }
                  }
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
      landmarkerRef.current?.close?.();
      landmarkerRef.current = null;
    };
  }, [enabled, videoRef, canvasRef]);

  return { lockAt, unlock, isLocked, sequence, clearSequence, syncError, clearRoles, roleDetected, swapRoles, annotations, exportDebugLog };
}
