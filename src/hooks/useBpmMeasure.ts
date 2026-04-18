import { useState, useRef, useCallback, useEffect } from 'react';

const BPM_MIN = 20;
const BPM_MAX = 300;
const MIN_ELAPSED_MS = 400; // guard against accidental taps

export type MeasureMode = 'longpress' | 'twotap';

export interface BpmMeasureResult {
  mode: MeasureMode;
  switchMode: (m: MeasureMode) => void;
  isPressing: boolean;
  elapsedMs: number;
  /** Estimated beat 1–8 while measuring (0 = idle) */
  estimatedBeat: number;
  /** Two-tap mode: first tap has been recorded */
  firstTapSet: boolean;
  handlePressStart: () => void;
  handlePressEnd: () => void;
  handleTap: () => void;
}

/**
 * Measures BPM from an 8-beat interval.
 *
 * Long-press: hold from beat 1 → release on beat 1 of next bar.
 * Two-tap:    tap on beat 1, tap again on beat 1 of next bar.
 *
 * Elapsed time / 8 = time per beat → BPM = 60000 / beat_time
 */
export function useBpmMeasure(
  onBpmChange: (bpm: number) => void,
  /** Used to animate the beat counter while measuring */
  referenceBpm: number,
): BpmMeasureResult {
  const [mode, setMode] = useState<MeasureMode>('twotap');
  const [isPressing, setIsPressing] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [firstTapTime, setFirstTapTime] = useState<number | null>(null);

  const pressStartRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const applyBpm = useCallback((elapsed: number) => {
    if (elapsed < MIN_ELAPSED_MS) return;
    const bpm = Math.round(60000 / (elapsed / 8));
    onBpmChange(Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)));
  }, [onBpmChange]);

  const startTimer = useCallback((startTime: number) => {
    setElapsedMs(0);
    clearTimer();
    timerRef.current = setInterval(() => {
      setElapsedMs(performance.now() - startTime);
    }, 50);
  }, [clearTimer]);

  const stopTimer = useCallback(() => {
    clearTimer();
    setIsPressing(false);
    setElapsedMs(0);
    pressStartRef.current = null;
  }, [clearTimer]);

  /* ── Long-press ── */
  const handlePressStart = useCallback(() => {
    if (mode !== 'longpress') return;
    const now = performance.now();
    pressStartRef.current = now;
    setIsPressing(true);
    startTimer(now);
  }, [mode, startTimer]);

  const handlePressEnd = useCallback(() => {
    if (mode !== 'longpress' || !pressStartRef.current) return;
    const elapsed = performance.now() - pressStartRef.current;
    stopTimer();
    applyBpm(elapsed);
  }, [mode, stopTimer, applyBpm]);

  /* ── Two-tap ── */
  const handleTap = useCallback(() => {
    if (mode !== 'twotap') return;
    if (firstTapTime === null) {
      const now = performance.now();
      setFirstTapTime(now);
      pressStartRef.current = now;
      setIsPressing(true);
      startTimer(now);
    } else {
      const elapsed = performance.now() - firstTapTime;
      stopTimer();
      setFirstTapTime(null);
      applyBpm(elapsed);
    }
  }, [mode, firstTapTime, startTimer, stopTimer, applyBpm]);

  /* ── Mode switch resets all state ── */
  const switchMode = useCallback((m: MeasureMode) => {
    clearTimer();
    setIsPressing(false);
    setElapsedMs(0);
    setFirstTapTime(null);
    pressStartRef.current = null;
    setMode(m);
  }, [clearTimer]);

  const beatDurationMs = 60000 / Math.max(1, referenceBpm);
  const estimatedBeat = isPressing
    ? Math.min(8, Math.floor(elapsedMs / beatDurationMs) + 1)
    : 0;

  return {
    mode, switchMode,
    isPressing, elapsedMs, estimatedBeat,
    firstTapSet: firstTapTime !== null,
    handlePressStart, handlePressEnd, handleTap,
  };
}
