/**
 * Salsa Analyzer Web Worker — PC 専用
 *
 * MediaPipe PoseLandmarker を Worker 内で実行し、UI スレッドを完全に解放する。
 * iOS Safari は Worker 内 WebGL コンテキスト（GPU delegate）が利用不可のため、
 * isIOS() が true の端末では使用しない。
 *
 * プロトコル（Main → Worker）:
 *   { type: 'detect', bitmap: ImageBitmap, timestamp: number }
 *
 * プロトコル（Worker → Main）:
 *   { type: 'ready' }
 *   { type: 'result', landmarks: NormalizedLandmark[][] }
 *   { type: 'error', message: string }
 */

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

interface NormalizedLandmark { x: number; y: number; z: number; visibility?: number; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let landmarker: any = null;
let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

// ── バウンディングボックス（2パスカスケード用） ──────────────────────────────
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

// ── Mid-Hip 計算（重複チェック用） ─────────────────────────────────────────
function midHip(lm: NormalizedLandmark[]): { x: number; y: number } | null {
  const hL = lm[23], hR = lm[24];
  if (!hL && !hR) return null;
  if (hL && hR) return { x: (hL.x + hR.x) / 2, y: (hL.y + hR.y) / 2 };
  return hL ? { x: hL.x, y: hL.y } : { x: hR!.x, y: hR!.y };
}

// ── MediaPipe 初期化 ──────────────────────────────────────────────────────
async function initialize() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision' as any) as any;
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 5,
    minPoseDetectionConfidence: 0.2,
    minPosePresenceConfidence: 0.2,
    minTrackingConfidence: 0.2,
  });
  self.postMessage({ type: 'ready' });
}

initialize().catch(e => self.postMessage({ type: 'error', message: String(e) }));

// ── メッセージハンドラ ────────────────────────────────────────────────────
self.addEventListener('message', (e: MessageEvent) => {
  if (e.data.type !== 'detect' || !landmarker) return;

  const { bitmap, timestamp } = e.data as {
    bitmap: ImageBitmap;
    timestamp: number;
  };

  try {
    const w = bitmap.width, h = bitmap.height;

    // ─ Pass 1: オリジナルフレームで検出
    const r1 = landmarker.detectForVideo(bitmap, timestamp);
    const p1  = r1.landmarks as NormalizedLandmark[][];

    let allLandmarks = [...p1];

    // ─ Pass 2: 1人しか検出できていない場合、検出済みをマスクして再検出
    if (p1.length < 2 && p1.length > 0) {
      if (!offscreen || offscreen.width !== w || offscreen.height !== h) {
        offscreen = new OffscreenCanvas(w, h);
        offCtx    = offscreen.getContext('2d');
      }
      if (offCtx) {
        offCtx.drawImage(bitmap, 0, 0);
        offCtx.fillStyle = '#808080';
        for (const lm of p1) {
          const b = getBoundingBox(lm);
          offCtx.fillRect(b.x * w, b.y * h, b.w * w, b.h * h);
        }
        const r2 = landmarker.detectForVideo(offscreen, timestamp + 1);
        const p2  = r2.landmarks as NormalizedLandmark[][];

        // 重複しない新規の人物だけ追加
        for (const lm2 of p2) {
          const h2 = midHip(lm2);
          if (!h2) continue;
          const dup = p1.some(lm1 => {
            const h1 = midHip(lm1);
            return h1 && Math.hypot(h1.x - h2.x, h1.y - h2.y) < 0.2;
          });
          if (!dup) allLandmarks.push(lm2);
        }
      }
    }

    bitmap.close();
    self.postMessage({ type: 'result', landmarks: allLandmarks });
  } catch {
    bitmap.close();
    self.postMessage({ type: 'result', landmarks: [] });
  }
});
