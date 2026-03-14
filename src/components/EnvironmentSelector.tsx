import styles from './EnvironmentSelector.module.css';
import type { ReverbType } from '../engine/AudioEngine';

type EnvironmentOption = {
  id: ReverbType;
  label: string;
  sub: string;
  icon: string;
};

const OPTIONS: EnvironmentOption[] = [
  { id: 'none',   label: 'Dry',    sub: '空間なし',  icon: '○' },
  { id: 'studio', label: 'Studio', sub: 'スタジオ',  icon: '⬡' },
  { id: 'hall',   label: 'Hall',   sub: 'ホール',    icon: '🏛' },
  { id: 'club',   label: 'Club',   sub: 'クラブ',    icon: '◈' },
  { id: 'plaza',  label: 'Plaza',  sub: '野外広場',  icon: '◎' },
];

type Props = {
  reverbType: ReverbType;
  isReverbLoading: boolean;
  reverbWetLevel: number;
  onReverbChange: (type: ReverbType) => void;
  onWetLevelChange: (v: number) => void;
};

export function EnvironmentSelector({
  reverbType,
  isReverbLoading,
  reverbWetLevel,
  onReverbChange,
  onWetLevelChange,
}: Props) {
  const isActive = reverbType !== 'none';

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.label}>ENVIRONMENT</span>
        {isActive && <span className={styles.activeTag}>{OPTIONS.find(o => o.id === reverbType)?.sub}</span>}
      </div>

      <div className={styles.btnGroup}>
        {OPTIONS.map(opt => {
          const isSelected = reverbType === opt.id;
          const isLoading  = isSelected && isReverbLoading;
          return (
            <button
              key={opt.id}
              className={[
                styles.btn,
                isSelected   ? styles.btnActive   : '',
                isActive && isSelected ? styles.btnRipple : '',
                isLoading    ? styles.btnLoading   : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onReverbChange(opt.id)}
              aria-pressed={isSelected}
              title={opt.sub}
            >
              <span className={styles.icon}>
                {isLoading ? <span className={styles.spinner} /> : opt.icon}
              </span>
              <span className={styles.btnLabel}>{opt.label}</span>
            </button>
          );
        })}
      </div>

      {isActive && (
        <div className={styles.wetRow}>
          <span className={styles.wetLabel}>Wet</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(reverbWetLevel * 100)}
            onChange={e => onWetLevelChange(Number(e.target.value) / 100)}
            className={styles.wetSlider}
            aria-label="Reverb wet level"
          />
          <span className={styles.wetValue}>{Math.round(reverbWetLevel * 100)}%</span>
        </div>
      )}
    </div>
  );
}
