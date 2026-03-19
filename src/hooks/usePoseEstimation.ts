import { useEffect, useRef, useState, useCallback } from 'react';

// @mediapipe/tasks-vision の exports 形式が非標準のため型を自前定義
interface NormalizedLandmark { x: number; y: number; z: number; visibility?: number; }

export type VizMode = 'off' | 'full' | 'salsa';

export interface UsePoseEstimationResult {
  /** コンテナ相対座標でタップされた人をロックオン */
  lockAt: (containerX: number, containerY: number) => void;
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

const NUM_POSES        = 5;
const VIS_THRESHOLD    = 0.5;
const DETECT_INTERVAL  = 50; // ms（最大 20fps で検知）

// ── 型 ───────────────────────────────────────────────────────────────────

type Connection = { start: number; end: number };
type Letterbox  = { offsetX: number; offsetY: number; renderW: number; renderH: number };
type Centroid   = { x: number; y: number };

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

// ── 人物の重心（正規化座標）を計算 ───────────────────────────────────────

function computeCentroid(landmarks: NormalizedLandmark[]): Centroid | null {
  const vis = landmarks.filter(lm => (lm.visibility ?? 1) >= VIS_THRESHOLD);
  if (vis.length === 0) return null;
  return {
    x: vis.reduce((s, l) => s + l.x, 0) / vis.length,
    y: vis.reduce((s, l) => s + l.y, 0) / vis.length,
  };
}

// ── 画面中央に最も近い人を返す ─────────────────────────────────────────

function findMainPersonIndex(landmarksArray: NormalizedLandmark[][]): number {
  let minDist = Infinity;
  let mainIdx = 0;
  for (let i = 0; i < landmarksArray.length; i++) {
    const c = computeCentroid(landmarksArray[i]);
    if (!c) continue;
    const dist = Math.hypot(c.x - 0.5, c.y - 0.5);
    if (dist < minDist) { minDist = dist; mainIdx = i; }
  }
  return mainIdx;
}

// ── ターゲットに最も近い人を返す ──────────────────────────────────────────

function findNearestToTarget(landmarksArray: NormalizedLandmark[][], target: Centroid): number {
  let minDist = Infinity;
  let nearest = 0;
  for (let i = 0; i < landmarksArray.length; i++) {
    const c = computeCentroid(landmarksArray[i]);
    if (!c) continue;
    const dist = Math.hypot(c.x - target.x, c.y - target.y);
    if (dist < minDist) { minDist = dist; nearest = i; }
  }
  return nearest;
}

// ── Full モード：全身33点描画 ──────────────────────────────────────────────

function drawFullPerson(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  connections: Connection[],
  lb: Letterbox,
  isMain: boolean,
) {
  const lineColor   = isMain ? 'rgba(255, 60,  60,  0.95)' : 'rgba(255, 255, 255, 0.50)';
  const jointColor  = isMain ? 'rgba(255, 210, 50,  0.95)' : 'rgba(200, 200, 200, 0.55)';
  const lineWidth   = isMain ? 3   : 1.5;
  const jointRadius = isMain ? 5   : 3;

  const toC = (lm: NormalizedLandmark) => ({
    x: lb.offsetX + lm.x * lb.renderW,
    y: lb.offsetY + lm.y * lb.renderH,
  });

  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = lineWidth;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  for (const { start, end } of connections) {
    const a = landmarks[start], b = landmarks[end];
    if (!a || !b) continue;
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    const pA = toC(a), pB = toC(b);
    ctx.beginPath();
    ctx.moveTo(pA.x, pA.y);
    ctx.lineTo(pB.x, pB.y);
    ctx.stroke();
  }

  ctx.fillStyle = jointColor;
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    const p = toC(lm);
    ctx.beginPath();
    ctx.arc(p.x, p.y, jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Salsa Focus モード：センター軸＋水平ライン ────────────────────────────

function drawSalsaPerson(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  lb: Letterbox,
  isMain: boolean,
) {
  const opacity    = isMain ? 1.0 : 0.35;
  const axisColor  = `rgba(255, 235,  0, ${opacity})`;
  const hLineColor = `rgba(  0, 220, 220, ${opacity})`;
  const dotColor   = `rgba(255, 235,  0, ${isMain ? 0.95 : 0.40})`;
  const axisWidth  = isMain ? 4.5 : 2;
  const hWidth     = isMain ? 3.5 : 1.5;
  const dotRadius  = isMain ? 6   : 3;

  const toC = (lm: NormalizedLandmark) => ({
    x: lb.offsetX + lm.x * lb.renderW,
    y: lb.offsetY + lm.y * lb.renderH,
  });
  const mid = (a: NormalizedLandmark, b: NormalizedLandmark): NormalizedLandmark => ({
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  });

  const nose = landmarks[0], shoulderL = landmarks[11], shoulderR = landmarks[12];
  const hipL = landmarks[23], hipR = landmarks[24];
  const ankleL = landmarks[27], ankleR = landmarks[28];
  if (!nose || !shoulderL || !shoulderR || !hipL || !hipR || !ankleL || !ankleR) return;

  const hipMid   = mid(hipL, hipR);
  const ankleMid = mid(ankleL, ankleR);

  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // 垂直中心軸（ネオンイエロー）
  ctx.strokeStyle = axisColor;
  ctx.lineWidth   = axisWidth;
  for (const [a, b] of [[nose, hipMid], [hipMid, ankleMid]] as [NormalizedLandmark, NormalizedLandmark][]) {
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    ctx.beginPath();
    ctx.moveTo(toC(a).x, toC(a).y);
    ctx.lineTo(toC(b).x, toC(b).y);
    ctx.stroke();
  }

  // 水平ライン（シアン）
  ctx.strokeStyle = hLineColor;
  ctx.lineWidth   = hWidth;
  for (const [a, b] of [[shoulderL, shoulderR], [hipL, hipR]] as [NormalizedLandmark, NormalizedLandmark][]) {
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    ctx.beginPath();
    ctx.moveTo(toC(a).x, toC(a).y);
    ctx.lineTo(toC(b).x, toC(b).y);
    ctx.stroke();
  }

  // キーポイントのドット
  ctx.fillStyle = dotColor;
  for (const lm of [nose, shoulderL, shoulderR, hipL, hipR, ankleL, ankleR, hipMid, ankleMid]) {
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    const p = toC(lm);
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── ターゲットインジケーター（足元の照準サークル） ─────────────────────────

function drawTargetIndicator(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  lb: Letterbox,
) {
  const ankleL = landmarks[27];
  const ankleR = landmarks[28];
  if (!ankleL && !ankleR) return;

  const leftVis  = ankleL && (ankleL.visibility ?? 1) >= VIS_THRESHOLD;
  const rightVis = ankleR && (ankleR.visibility ?? 1) >= VIS_THRESHOLD;
  let footX: number, footY: number;

  if (leftVis && rightVis) {
    footX = (ankleL.x + ankleR.x) / 2;
    footY = Math.max(ankleL.y, ankleR.y);
  } else if (leftVis)  { footX = ankleL.x; footY = ankleL.y; }
  else if (rightVis)   { footX = ankleR.x; footY = ankleR.y; }
  else return;

  const px = lb.offsetX + footX * lb.renderW;
  const py = lb.offsetY + footY * lb.renderH + 18; // 足首より少し下
  const r  = 14;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 120, 0, 0.95)';
  ctx.lineWidth   = 2.5;

  // 外円（半透明塗り）
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 120, 0, 0.18)';
  ctx.fill();
  ctx.stroke();

  // 中心点
  ctx.beginPath();
  ctx.arc(px, py, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 120, 0, 0.95)';
  ctx.fill();

  // 4 方向のティックマーク
  const tickOuter = r + 5;
  const tickInner = r + 1;
  for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]] as [number, number][]) {
    ctx.beginPath();
    ctx.moveTo(px + dx * tickInner, py + dy * tickInner);
    ctx.lineTo(px + dx * tickOuter, py + dy * tickOuter);
    ctx.stroke();
  }

  ctx.restore();
}

// ── フック本体 ────────────────────────────────────────────────────────────

export function usePoseEstimation(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  mode: VizMode,
): UsePoseEstimationResult {
  // modeRef: full↔salsa 切替は再初期化なしで即時反映
  const modeRef   = useRef<VizMode>(mode);
  modeRef.current = mode;

  const enabled = mode !== 'off';

  const activeRef     = useRef(false);
  const rafRef        = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landmarkerRef = useRef<any>(null);

  // ── ロックオン状態（ref: RAFループ用 / state: コンポーネント表示用）
  const lockedRef = useRef<Centroid | null>(null);
  const [isLocked, setIsLocked] = useState(false);

  // ── ロックオン：コンテナ相対座標 → 正規化座標に変換して保存
  const lockAt = useCallback((containerX: number, containerY: number) => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    // コンテナサイズ（ズーム CSS transform 前）で letterbox 計算
    const container = canvas.parentElement;
    const cw = container?.clientWidth  ?? canvas.offsetWidth;
    const ch = container?.clientHeight ?? canvas.offsetHeight;
    const lb = computeLetterbox(cw, ch, video.videoWidth, video.videoHeight);

    const nx = Math.max(0, Math.min(1, (containerX - lb.offsetX) / lb.renderW));
    const ny = Math.max(0, Math.min(1, (containerY - lb.offsetY) / lb.renderH));

    lockedRef.current = { x: nx, y: ny };
    setIsLocked(true);
  }, [videoRef, canvasRef]);

  // ── ロック解除
  const unlock = useCallback(() => {
    lockedRef.current = null;
    setIsLocked(false);
  }, []);

  // ── ランドマーカーのライフサイクル（enabled が変わったときのみ再初期化）
  useEffect(() => {
    if (!enabled) {
      activeRef.current = false;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      const canvas = canvasRef.current;
      if (canvas) { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); }
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
        const video  = videoRef.current;
        const canvas = canvasRef.current;

        if (!video || !canvas) { rafRef.current = requestAnimationFrame(loop); return; }

        // mode が off なら描画クリアして待機
        if (currentMode === 'off') {
          canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        if (!video.paused && video.readyState >= 2) {
          // Canvas をコンテナサイズに同期（getBoundingClientRect はズーム後のサイズなので parentElement を優先）
          const container = canvas.parentElement;
          const rw = container?.clientWidth  ?? Math.round(canvas.getBoundingClientRect().width);
          const rh = container?.clientHeight ?? Math.round(canvas.getBoundingClientRect().height);
          if (rw > 0 && rh > 0 && (canvas.width !== rw || canvas.height !== rh)) {
            canvas.width  = rw;
            canvas.height = rh;
          }

          const now = performance.now();
          if (now - lastDetect >= DETECT_INTERVAL) {
            lastDetect = now;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              try {
                const result = landmarker.detectForVideo(video, now);
                const all    = result.landmarks as NormalizedLandmark[][];

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (all.length > 0) {
                  const lb = computeLetterbox(canvas.width, canvas.height, video.videoWidth, video.videoHeight);

                  if (lockedRef.current !== null) {
                    // ── ロックオンモード：最近傍の人物のみ描画
                    const idx = findNearestToTarget(all, lockedRef.current);

                    // 重心を更新して追跡を継続
                    const newCentroid = computeCentroid(all[idx]);
                    if (newCentroid) lockedRef.current = newCentroid;

                    if (currentMode === 'full') {
                      drawFullPerson(ctx, all[idx], connections, lb, true);
                    } else {
                      drawSalsaPerson(ctx, all[idx], lb, true);
                    }
                    drawTargetIndicator(ctx, all[idx], lb);

                  } else {
                    // ── 通常モード：全員描画（メインを前面）
                    const mainIdx = findMainPersonIndex(all);

                    if (currentMode === 'full') {
                      for (let i = 0; i < all.length; i++) {
                        if (i !== mainIdx) drawFullPerson(ctx, all[i], connections, lb, false);
                      }
                      drawFullPerson(ctx, all[mainIdx], connections, lb, true);
                    } else {
                      for (let i = 0; i < all.length; i++) {
                        if (i !== mainIdx) drawSalsaPerson(ctx, all[i], lb, false);
                      }
                      drawSalsaPerson(ctx, all[mainIdx], lb, true);
                    }
                  }
                }
              } catch {
                // 初期化中などの一時的なエラーは無視
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
