import { useEffect, useRef } from 'react';
import styles from './VisualMetronome.module.css';

type Props = {
  currentBeat: number;      // -1 = stopped, 0..N = beat index
  beatsPerBar?: number;
  isPlaying: boolean;
};

const BEATS_PER_BAR = 4;

/**
 * VisualMetronome renders beat indicators via requestAnimationFrame so that
 * the animation stays silky-smooth regardless of React re-render timing.
 */
export function VisualMetronome({
  currentBeat,
  beatsPerBar = BEATS_PER_BAR,
  isPlaying,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ currentBeat, beatsPerBar, isPlaying });
  const rafRef = useRef<number | null>(null);

  // Keep stateRef in sync without triggering re-renders or re-registering RAF
  useEffect(() => {
    stateRef.current = { currentBeat, beatsPerBar, isPlaying };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const { currentBeat, beatsPerBar, isPlaying } = stateRef.current;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      const r = Math.min(width, height) * 0.08;
      const gap = r * 0.6;
      const totalW = beatsPerBar * (r * 2) + (beatsPerBar - 1) * gap;
      const startX = (width - totalW) / 2;
      const cy = height / 2;

      for (let i = 0; i < beatsPerBar; i++) {
        const cx = startX + i * (r * 2 + gap) + r;
        const isActive = isPlaying && i === currentBeat;
        const isAccent = i === 0;

        // Glow effect for active beat
        if (isActive) {
          ctx.save();
          ctx.shadowColor = isAccent ? '#ff9f43' : '#7c6bff';
          ctx.shadowBlur = 24;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = isAccent ? '#ff9f43' : '#7c6bff';
          ctx.fill();
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = isAccent ? '#3a2a1a' : '#1e1e3a';
          ctx.fill();
          ctx.strokeStyle = isAccent ? '#5a3a1a' : '#3a3a6a';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []); // only mounts once; state is read from stateRef inside the loop

  return (
    <div className={styles.wrapper}>
      <canvas
        ref={canvasRef}
        width={480}
        height={120}
        className={styles.canvas}
      />
    </div>
  );
}
