import { useEffect, useRef, useState, useCallback } from 'react';

// @mediapipe/tasks-vision の exports 形式が非標準のため型を自前定義
interface NormalizedLandmark { x: number; y: number; z: number; visibility?: number; }

export type VizMode = 'off' | 'full' | 'salsa' | 'trail';

export interface UsePoseEstimationResult {
  /** CSS transform 逆変換済みのキャンバス座標を受け取り、最近傍の人物をロックオン */
  lockAt: (canvasX: number, canvasY: number) => void;
  /** ロック解除 */
  unlock: () => void;
  /** 現在ロック中かどうか（ボタン表示用） */
  isLocked: boolean;
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

// ── 型 ───────────────────────────────────────────────────────────────────

type Connection = { start: number; end: number };
type Letterbox  = { offsetX: number; offsetY: number; renderW: number; renderH: number };
type Centroid   = { x: number; y: number };
type VelocityVec = { vx: number; vy: number };
type AnkleFrame  = { lx: number; ly: number; rx: number; ry: number };

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

// ── Draw: Full モード（全身33点） ─────────────────────────────────────────

function drawFullPerson(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  connections: Connection[],
  lb: Letterbox,
  isMain: boolean,
) {
  const lc = isMain ? 'rgba(255,60,60,0.95)' : 'rgba(255,255,255,0.50)';
  const jc = isMain ? 'rgba(255,210,50,0.95)' : 'rgba(200,200,200,0.55)';
  const lw = isMain ? 3 : 1.5;
  const jr = isMain ? 5 : 3;
  const toC = (lm: NormalizedLandmark) => ({ x: lb.offsetX + lm.x * lb.renderW, y: lb.offsetY + lm.y * lb.renderH });

  ctx.strokeStyle = lc; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const { start, end } of connections) {
    const a = landmarks[start], b = landmarks[end];
    if (!a || !b || (a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    const pA = toC(a), pB = toC(b);
    ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
  }
  ctx.fillStyle = jc;
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    const p = toC(lm);
    ctx.beginPath(); ctx.arc(p.x, p.y, jr, 0, Math.PI * 2); ctx.fill();
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

// ── フック本体 ────────────────────────────────────────────────────────────

export function usePoseEstimation(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  mode: VizMode,
  bpm = 0,
  isMirrored = false,
): UsePoseEstimationResult {
  const modeRef      = useRef<VizMode>(mode);
  modeRef.current    = mode;
  const bpmRef       = useRef(bpm);
  bpmRef.current     = bpm;
  const mirroredRef  = useRef(isMirrored);
  mirroredRef.current = isMirrored;

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
    setIsLocked(true);
  }, [videoRef, canvasRef]);

  // ── ロック解除
  const unlock = useCallback(() => {
    lockedRef.current         = null;
    debugTapCanvasRef.current = null;
    velocityRef.current       = { vx: 0, vy: 0 };
    occlusionCountRef.current  = 0;
    ankleHistoryRef.current    = [];
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

                  // ── 描画
                  const isLockMode = lockedRef.current !== null;

                  if (currentMode === 'trail') {
                    // 全員の骨格をゴーストで描画
                    for (let i = 0; i < all.length; i++) {
                      drawFullPerson(ctx, all[i], connections, lb, false);
                    }
                    // メイン/ロック対象の足首軌跡
                    drawStepTrail(ctx, ankleHistoryRef.current, lb, true);

                  } else if (currentMode === 'full') {
                    if (isLockMode) {
                      drawFullPerson(ctx, all[targetIdx], connections, lb, true);
                    } else {
                      for (let i = 0; i < all.length; i++) {
                        drawFullPerson(ctx, all[i], connections, lb, i === targetIdx);
                      }
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

  return { lockAt, unlock, isLocked };
}
