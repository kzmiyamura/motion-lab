import type { TrackId } from '../engine/AudioEngine';
import styles from './TrackRow.module.css';

type Props = {
  id: TrackId;
  label: string;
  sublabel: string;
  pattern: Set<number>;        // active steps (0-15)
  currentBeat: number;         // -1 = stopped
  muted: boolean;
  onToggleMute: () => void;
};

const TOTAL_STEPS = 16;

const STEP_LABELS = [
  '1','','2','','3','','4','',
  '5','','6','','7','','8','',
];

export function TrackRow({ id, label, sublabel, pattern, currentBeat, muted, onToggleMute }: Props) {
  return (
    <div className={styles.row} data-track={id}>
      {/* Track header */}
      <div className={styles.header}>
        <div className={styles.nameBlock}>
          <span className={styles.name}>{label}</span>
          <span className={styles.sub}>{sublabel}</span>
        </div>
        <button
          className={`${styles.muteBtn} ${muted ? styles.mutedActive : ''}`}
          onClick={onToggleMute}
          aria-pressed={muted}
          aria-label={`${muted ? 'Unmute' : 'Mute'} ${label}`}
        >
          {muted ? 'OFF' : 'ON'}
        </button>
      </div>

      {/* 16-step beat grid */}
      <div className={styles.grid}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => {
          const isActive = pattern.has(i);
          const isCurrent = currentBeat === i;
          const isDownbeat = i % 2 === 0; // even steps = quarter note downbeats

          return (
            <div
              key={i}
              className={[
                styles.step,
                isActive ? styles.stepOn : styles.stepOff,
                isCurrent ? styles.stepCurrent : '',
                isDownbeat ? styles.stepDown : styles.stepAnd,
                muted ? styles.stepMuted : '',
              ].join(' ')}
              aria-label={`step ${i + 1}`}
            >
              <span className={styles.stepLabel}>{STEP_LABELS[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
