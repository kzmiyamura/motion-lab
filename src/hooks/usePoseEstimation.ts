import { useEffect, useRef } from 'react';

// @mediapipe/tasks-vision の exports 形式が非標準のため型を自前定義
interface NormalizedLandmark { x: number; y: number; z: number; visibility?: number; }

// ── 定数 ─────────────────────────────────────────────────────────────────

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const NUM_POSES = 5;
const VIS_THRESHOLD = 0.5;
const DETECT_INTERVAL_MS = 50; // 最大 20fps で検知（RAF は 60fps で動作継続）

// ── ヘルパー：letterbox オフセット計算 ───────────────────────────────────

function computeLetterbox(cw: number, ch: number, vw: number, vh: number) {
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

// ── ヘルパー：「中央に最も近い人」のインデックスを返す ───────────────────

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

// ── ヘルパー：1 人分の骨格を描画 ────────────────────────────────────────

type Connection = { start: number; end: number };
type Letterbox = { offsetX: number; offsetY: number; renderW: number; renderH: number };

function drawPerson(
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

  // ── コネクション（骨格線）
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

  // ── 関節点
  ctx.fillStyle = jointColor;
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    const p = toC(lm);
    ctx.beginPath();
    ctx.arc(p.x, p.y, jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── フック本体 ────────────────────────────────────────────────────────────

export function usePoseEstimation(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const activeRef     = useRef(false);
  const rafRef        = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landmarkerRef = useRef<any>(null);

  useEffect(() => {
    // 無効時：描画クリアして終了
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

      // WASM + モデルを CDN からロード
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      if (cancelled) return;

      const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
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

        const video  = videoRef.current;
        const canvas = canvasRef.current;

        if (video && canvas && !video.paused && video.readyState >= 2) {
          // Canvas をコンテナサイズに合わせる
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
                const all = result.landmarks as NormalizedLandmark[][];

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (all.length > 0) {
                  const lb      = computeLetterbox(canvas.width, canvas.height, video.videoWidth, video.videoHeight);
                  const mainIdx = findMainPersonIndex(all);

                  // サブの人を先に描き、メインを最後（前面）に重ねる
                  for (let i = 0; i < all.length; i++) {
                    if (i !== mainIdx) drawPerson(ctx, all[i], connections, lb, false);
                  }
                  drawPerson(ctx, all[mainIdx], connections, lb, true);
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
  }, [enabled, videoRef, canvasRef]);
}
