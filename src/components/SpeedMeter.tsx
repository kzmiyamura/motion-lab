import { useState } from 'react';
import styles from './SpeedMeter.module.css';

type Props = {
  /** A-B ループの開始/終了時刻（秒）。両方揃うと速度計算が有効になる */
  loopStart: number | null;
  loopEnd: number | null;
};

export function SpeedMeter({ loopStart, loopEnd }: Props) {
  const [distanceInput, setDistanceInput] = useState('');

  const durationSec = loopStart !== null && loopEnd !== null ? loopEnd - loopStart : null;
  const distanceM = parseFloat(distanceInput);
  const speedKmh = durationSec !== null && durationSec > 0 && !isNaN(distanceM) && distanceM > 0
    ? (distanceM / durationSec) * 3.6
    : null;

  return (
    <div className={styles.row}>
      <span className={styles.label}>🏃 速度</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.1"
        placeholder="距離(m)"
        className={styles.distanceInput}
        value={distanceInput}
        onChange={e => setDistanceInput(e.target.value)}
      />
      {durationSec !== null && (
        <span className={styles.duration}>{durationSec.toFixed(3)}秒</span>
      )}
      {speedKmh !== null ? (
        <span className={styles.speedValue}>{speedKmh.toFixed(1)} km/h</span>
      ) : (
        <span className={styles.hint}>A/B点と距離を入力</span>
      )}
    </div>
  );
}
