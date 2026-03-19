import { useEffect, useRef } from 'react';

// @mediapipe/tasks-vision の exports 形式が非標準のため型を自前定義
interface NormalizedLandmark { x: number; y: number; z: number; visibility?: number; }

export type VizMode = 'off' | 'full' | 'salsa';

// ── 定数 ─────────────────────────────────────────────────────────────────

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const NUM_POSES = 5;
const VIS_THRESHOLD = 0.5;
const DETECT_INTERVAL_MS = 50; // 最大 20fps で検知

// ── ヘルパー型 ────────────────────────────────────────────────────────────

type Connection = { start: number; end: number };
type Letterbox  = { offsetX: number; offsetY: number; renderW: number; renderH: number };

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

// ── 画面中央に最も近い人のインデックスを返す ─────────────────────────────

function findMainPersonIndex(landmarksArray: NormalizedLandmark[][]): number {
  let minDist = Infinity;
  let mainIdx = 0;
  for (let i = 0; i < landmarksArray.length; i++) {
    const visible = landmarksArray[i].filter(lm => (lm.visibility ?? 1) >= VIS_THRESHOLD);
    if (visible.length === 0) continue;
    const cx = visible.reduce((s, l) => s + l.x, 0) / visible.length;
    const cy = visible.reduce((s, l) => s + l.y, 0) / visible.length;
    const dist = Math.hypot(cx - 0.5, cy - 0.5);
    if (dist < minDist) { minDist = dist; mainIdx = i; }
  }
  return mainIdx;
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
  const lineWidth   = isMain ? 3 : 1.5;
  const jointRadius = isMain ? 5 : 3;

  const toC = (lm: NormalizedLandmark) => ({
    x: lb.offsetX + lm.x * lb.renderW,
    y: lb.offsetY + lm.y * lb.renderH,
  });

  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = lineWidth;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';

  for (const { start, end } of connections) {
    const a = landmarks[start];
    const b = landmarks[end];
    if (!a || !b) continue;
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    const pA = toC(a);
    const pB = toC(b);
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

// ── Salsa Focus モード：センター軸＋水平ライン強調描画 ────────────────────

function drawSalsaPerson(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  lb: Letterbox,
  isMain: boolean,
) {
  const opacity    = isMain ? 1.0 : 0.35;
  const axisColor  = `rgba(255, 235,  0, ${opacity})`; // ネオンイエロー：垂直中心軸
  const hLineColor = `rgba(  0, 220, 220, ${opacity})`; // シアン：水平ライン
  const dotColor   = `rgba(255, 235,  0, ${isMain ? 0.95 : 0.40})`;
  const axisWidth  = isMain ? 4.5 : 2;
  const hWidth     = isMain ? 3.5 : 1.5;
  const dotRadius  = isMain ? 6   : 3;

  const toC = (lm: NormalizedLandmark) => ({
    x: lb.offsetX + lm.x * lb.renderW,
    y: lb.offsetY + lm.y * lb.renderH,
  });

  // 仮想中点ランドマークを作る（visibility は両者の低い方）
  const mid = (a: NormalizedLandmark, b: NormalizedLandmark): NormalizedLandmark => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  });

  const nose      = landmarks[0];
  const shoulderL = landmarks[11];
  const shoulderR = landmarks[12];
  const hipL      = landmarks[23];
  const hipR      = landmarks[24];
  const ankleL    = landmarks[27];
  const ankleR    = landmarks[28];
  if (!nose || !shoulderL || !shoulderR || !hipL || !hipR || !ankleL || !ankleR) return;

  const hipMid    = mid(hipL, hipR);
  const ankleMid  = mid(ankleL, ankleR);

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // ── 垂直中心軸（ネオンイエロー）：鼻 → 腰中点 → 足首中点
  ctx.strokeStyle = axisColor;
  ctx.lineWidth   = axisWidth;

  const axisSegs: [NormalizedLandmark, NormalizedLandmark][] = [
    [nose,   hipMid],
    [hipMid, ankleMid],
  ];
  for (const [a, b] of axisSegs) {
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    ctx.beginPath();
    ctx.moveTo(toC(a).x, toC(a).y);
    ctx.lineTo(toC(b).x, toC(b).y);
    ctx.stroke();
  }

  // ── 水平ライン（シアン）：肩 / 腰
  ctx.strokeStyle = hLineColor;
  ctx.lineWidth   = hWidth;

  const hLines: [NormalizedLandmark, NormalizedLandmark][] = [
    [shoulderL, shoulderR],
    [hipL,      hipR],
  ];
  for (const [a, b] of hLines) {
    if ((a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD) continue;
    ctx.beginPath();
    ctx.moveTo(toC(a).x, toC(a).y);
    ctx.lineTo(toC(b).x, toC(b).y);
    ctx.stroke();
  }

  // ── キーポイントのドット
  ctx.fillStyle = dotColor;
  const keyLms = [nose, shoulderL, shoulderR, hipL, hipR, ankleL, ankleR, hipMid, ankleMid];
  for (const lm of keyLms) {
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    const p = toC(lm);
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── フック本体 ────────────────────────────────────────────────────────────

export function usePoseEstimation(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  mode: VizMode,
) {
  // modeRef は描画ループ内でフレームごとに参照（再初期化なしで切り替え可能）
  const modeRef       = useRef<VizMode>(mode);
  modeRef.current     = mode;

  const enabled       = mode !== 'off';
  const activeRef     = useRef(false);
  const rafRef        = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landmarkerRef = useRef<any>(null);

  useEffect(() => {
    // OFF のとき：描画クリアして終了
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
      let lastDetectTime = 0;

      function loop() {
        if (!activeRef.current || cancelled) return;

        const currentMode = modeRef.current;
        const video  = videoRef.current;
        const canvas = canvasRef.current;

        if (!video || !canvas) { rafRef.current = requestAnimationFrame(loop); return; }

        // mode が off に切り替わっていたらクリアのみ
        if (currentMode === 'off') {
          canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        if (!video.paused && video.readyState >= 2) {
          // Canvas サイズをコンテナに同期
          const rect = canvas.getBoundingClientRect();
          const rw = Math.round(rect.width);
          const rh = Math.round(rect.height);
          if (rw > 0 && rh > 0 && (canvas.width !== rw || canvas.height !== rh)) {
            canvas.width  = rw;
            canvas.height = rh;
          }

          const now = performance.now();
          if (now - lastDetectTime >= DETECT_INTERVAL_MS) {
            lastDetectTime = now;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              try {
                const result = landmarker.detectForVideo(video, now);
                const all    = result.landmarks as NormalizedLandmark[][];

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (all.length > 0) {
                  const lb      = computeLetterbox(canvas.width, canvas.height, video.videoWidth, video.videoHeight);
                  const mainIdx = findMainPersonIndex(all);

                  if (currentMode === 'full') {
                    // サブ人物を先に描き、メインを最前面へ
                    for (let i = 0; i < all.length; i++) {
                      if (i !== mainIdx) drawFullPerson(ctx, all[i], connections, lb, false);
                    }
                    drawFullPerson(ctx, all[mainIdx], connections, lb, true);

                  } else { // salsa
                    for (let i = 0; i < all.length; i++) {
                      if (i !== mainIdx) drawSalsaPerson(ctx, all[i], lb, false);
                    }
                    drawSalsaPerson(ctx, all[mainIdx], lb, true);
                  }
                }
              } catch {
                // 初期化中など一時的なエラーは無視
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
  }, [enabled, videoRef, canvasRef]); // mode の full↔salsa 切替は modeRef 経由で追従
}
