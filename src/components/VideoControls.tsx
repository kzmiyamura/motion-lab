import { useRef, useCallback } from 'react';
import { SLOW_RATES, ZOOM_PRESETS } from '../hooks/useVideoTraining';
import type { SlowRate, ZoomPresetId } from '../hooks/useVideoTraining';
import styles from './VideoControls.module.css';

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

type Props = {
  ytPlaying: boolean;
  onTogglePlay: () => void;
  onStep: (dir: 1 | -1) => void;
  slowRate: SlowRate;
  onSlowRate: (r: SlowRate) => void;
  loopStart: number | null;
  loopEnd: number | null;
  isLooping: boolean;
  onMarkLoop: (p: 'start' | 'end') => void;
  onClearLoop: () => void;
  onToggleLoop: () => void;
  onPreset: (id: ZoomPresetId) => void;
  isMirrored?: boolean;
  onMirrorToggle?: () => void;
};

export function VideoControls({
  ytPlaying, onTogglePlay,
  onStep, slowRate, onSlowRate,
  loopStart, loopEnd, isLooping,
  onMarkLoop, onClearLoop, onToggleLoop,
  onPreset,
  isMirrored = false, onMirrorToggle,
}: Props) {
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startStep = useCallback((dir: 1 | -1) => {
    onStep(dir);
    stepIntervalRef.current = setInterval(() => onStep(dir), 120);
  }, [onStep]);

  const stopStep = useCallback(() => {
    if (stepIntervalRef.current) {
      clearInterval(stepIntervalRef.current);
      stepIntervalRef.current = null;
    }
  }, []);

  return (
    <div className={styles.wrapper}>

      {/* ── 再生 / コマ送り ── */}
      <div className={styles.row}>
        <button
          className={`${styles.playBtn} ${ytPlaying ? styles.playBtnPlaying : ''}`}
          onClick={onTogglePlay}
        >
          {ytPlaying ? '⏸' : '▶'}
        </button>

        <button
          className={styles.stepBtn}
          onPointerDown={() => startStep(-1)}
          onPointerUp={stopStep}
          onPointerLeave={stopStep}
          onPointerCancel={stopStep}
          title="コマ戻し（長押し）"
        >
          ⏮
        </button>
        <button
          className={styles.stepBtn}
          onPointerDown={() => startStep(1)}
          onPointerUp={stopStep}
          onPointerLeave={stopStep}
          onPointerCancel={stopStep}
          title="コマ送り（長押し）"
        >
          ⏭
        </button>

        {/* Mirror */}
        {onMirrorToggle && (
          <button
            className={`${styles.mirrorBtn} ${isMirrored ? styles.mirrorBtnActive : ''}`}
            onClick={onMirrorToggle}
            title={isMirrored ? 'ミラー解除' : 'ミラー反転'}
            aria-label="ミラー反転"
          >
            ↔
          </button>
        )}

        {/* Slow rate */}
        <div className={styles.rateGroup}>
          {SLOW_RATES.map(r => (
            <button
              key={r}
              className={`${styles.rateBtn} ${slowRate === r ? styles.rateBtnActive : ''}`}
              onClick={() => onSlowRate(r)}
            >
              {r === 1.0 ? '1×' : `${r}×`}
            </button>
          ))}
        </div>
      </div>

      {/* ── ループ ── */}
      <div className={styles.row}>
        <span className={styles.loopLabel}>Loop</span>
        <button className={styles.loopBtn} onClick={() => onMarkLoop('start')}>
          {loopStart !== null ? `A: ${fmtTime(loopStart)}` : 'A 点'}
        </button>
        <button className={styles.loopBtn} onClick={() => onMarkLoop('end')}>
          {loopEnd !== null ? `B: ${fmtTime(loopEnd)}` : 'B 点'}
        </button>
        {(loopStart !== null || loopEnd !== null) && (
          <button className={styles.loopClear} onClick={onClearLoop}>✕</button>
        )}
        <button
          className={`${styles.loopToggle} ${isLooping ? styles.loopToggleOn : ''}`}
          onClick={onToggleLoop}
          disabled={loopStart === null || loopEnd === null}
        >
          {isLooping ? '⟳ ON' : '⟳ OFF'}
        </button>
      </div>

      {/* ── ズームプリセット ── */}
      <div className={styles.row}>
        <span className={styles.loopLabel}>Zoom</span>
        {ZOOM_PRESETS.map(p => (
          <button
            key={p.id}
            className={styles.presetBtn}
            onClick={() => onPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
