import { useRef, useCallback, useState } from 'react';

const MAX_TAPS = 8;
const RESET_GAP_MS = 2000;
const MIN_TAPS_TO_APPLY = 4;
const BPM_MIN = 20;
const BPM_MAX = 300;

export function useTapTempo(onBpmChange: (bpm: number) => void) {
  const tapsRef = useRef<number[]>([]);
  const [tapCount, setTapCount] = useState(0);

  const tap = useCallback(() => {
    const now = performance.now();
    const taps = tapsRef.current;

    // Reset if gap is too large
    if (taps.length > 0 && now - taps[taps.length - 1] > RESET_GAP_MS) {
      tapsRef.current = [];
      setTapCount(0);
    }

    tapsRef.current.push(now);
    if (tapsRef.current.length > MAX_TAPS) {
      tapsRef.current.shift();
    }

    const count = tapsRef.current.length;
    setTapCount(count);

    if (count >= MIN_TAPS_TO_APPLY) {
      const intervals: number[] = [];
      for (let i = 1; i < tapsRef.current.length; i++) {
        intervals.push(tapsRef.current[i] - tapsRef.current[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avgInterval);
      const clamped = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
      onBpmChange(clamped);
    }
  }, [onBpmChange]);

  const reset = useCallback(() => {
    tapsRef.current = [];
    setTapCount(0);
  }, []);

  return { tap, tapCount, reset };
}
