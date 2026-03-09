import { useCallback } from 'react';
import { PRESETS, type PresetName, type TotalSteps } from '../engine/presets';
import styles from './PresetSelector.module.css';

type Props = {
  totalSteps: TotalSteps;
  preset: PresetName;
  onTotalStepsChange: (steps: TotalSteps) => void;
  onPresetChange: (name: PresetName) => void;
};

const STEP_OPTIONS: TotalSteps[] = [4, 8, 16];
const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function PresetSelector({ totalSteps, preset, onTotalStepsChange, onPresetChange }: Props) {
  const handlePreset = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onPresetChange(e.target.value as PresetName);
    },
    [onPresetChange]
  );

  return (
    <div className={styles.wrapper}>
      <div className={styles.row}>
        <span className={styles.label}>Steps</span>
        <div className={styles.stepButtons}>
          {STEP_OPTIONS.map(s => (
            <button
              key={s}
              className={`${styles.stepBtn} ${totalSteps === s ? styles.stepBtnActive : ''}`}
              onClick={() => onTotalStepsChange(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Preset</span>
        <select
          className={styles.select}
          value={preset}
          onChange={handlePreset}
        >
          {PRESET_NAMES.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
