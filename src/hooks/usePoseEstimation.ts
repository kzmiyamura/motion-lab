import { useEffect, useRef } from 'react';
import type { Results, NormalizedLandmark } from '@mediapipe/pose';

// 描画する骨格のコネクション (MediaPipe Pose landmark index)
const SKELETON_CONNECTIONS: [number, number][] = [
  // 顔
  [0, 11], [0, 12],
  // 肩
  [11, 12],
  // 左腕
  [11, 13], [13, 15],
  // 右腕
  [12, 14], [14, 16],
  // 胴体
  [11, 23], [12, 24], [23, 24],
  // 左脚
  [23, 25], [25, 27], [27, 29], [29, 31],
  // 右脚
  [24, 26], [26, 28], [28, 30], [30, 32],
];

/** object-fit: contain の letterbox オフセットを計算 */
function computeLetterbox(cw: number, ch: number, vw: number, vh: number) {
  if (vw <= 0 || vh <= 0) return { offsetX: 0, offsetY: 0, renderW: cw, renderH: ch };
  const containerAR = cw / ch;
  const videoAR = vw / vh;
  let renderW: number, renderH: number, offsetX: number, offsetY: number;
  if (videoAR > containerAR) {
    renderW = cw;
    renderH = cw / videoAR;
    offsetX = 0;
    offsetY = (ch - renderH) / 2;
  } else {
    renderW = ch * videoAR;
    renderH = ch;
    offsetX = (cw - renderW) / 2;
    offsetY = 0;
  }
  return { offsetX, offsetY, renderW, renderH };
}

function drawResults(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  cw: number, ch: number,
  vw: number, vh: number,
) {
  ctx.clearRect(0, 0, cw, ch);

  const lb = computeLetterbox(cw, ch, vw, vh);
  const toCanvas = (lm: NormalizedLandmark) => ({
    x: lb.offsetX + lm.x * lb.renderW,
    y: lb.offsetY + lm.y * lb.renderH,
  });

  // コネクション (骨格線)
  ctx.strokeStyle = 'rgba(0, 220, 100, 0.85)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [a, b] of SKELETON_CONNECTIONS) {
    const lmA = landmarks[a];
    const lmB = landmarks[b];
    if (!lmA || !lmB) continue;
    if ((lmA.visibility ?? 1) < 0.4 || (lmB.visibility ?? 1) < 0.4) continue;
    const pA = toCanvas(lmA);
    const pB = toCanvas(lmB);
    ctx.beginPath();
    ctx.moveTo(pA.x, pA.y);
    ctx.lineTo(pB.x, pB.y);
    ctx.stroke();
  }

  // 関節点
  ctx.fillStyle = 'rgba(255, 220, 50, 0.9)';
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < 0.4) continue;
    const p = toCanvas(lm);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function usePoseEstimation(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const activeRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const poseRef = useRef<any>(null);

  useEffect(() => {
    // 無効時はクリアして終了
    if (!enabled) {
      activeRef.current = false;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    let cancelled = false;
    activeRef.current = true;

    async function init() {
      const { Pose } = await import('@mediapipe/pose');
      if (cancelled) return;

      const pose = new Pose({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
      });

      pose.setOptions({
        modelComplexity: 0,       // 0=Lite (モバイル向け軽量)
        smoothLandmarks: true,
        enableSegmentation: false,
        smoothSegmentation: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      pose.onResults((results: Results) => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        if (!canvas || !video || !results.poseLandmarks) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        drawResults(
          ctx,
          results.poseLandmarks,
          canvas.width, canvas.height,
          video.videoWidth, video.videoHeight,
        );
      });

      poseRef.current = pose;

      // RAF ループ（1フレームずつ処理）
      let processing = false;
      async function loop() {
        if (!activeRef.current || cancelled) return;

        const video = videoRef.current;
        const canvas = canvasRef.current;

        if (video && canvas && !video.paused && video.readyState >= 2 && !processing) {
          // canvas のサイズをコンテナに合わせて更新
          const rect = canvas.getBoundingClientRect();
          const rw = Math.round(rect.width);
          const rh = Math.round(rect.height);
          if (rw > 0 && rh > 0 && (canvas.width !== rw || canvas.height !== rh)) {
            canvas.width = rw;
            canvas.height = rh;
          }

          processing = true;
          try {
            await pose.send({ image: video });
          } catch {
            // 無視
          } finally {
            processing = false;
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
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      poseRef.current?.close?.();
      poseRef.current = null;
    };
  }, [enabled, videoRef, canvasRef]);
}
