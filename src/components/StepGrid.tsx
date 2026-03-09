import styles from './StepGrid.module.css';

type Props = {
  totalSteps: number;
  activeStep: number;       // -1 = 停止中
  checkedSteps: Set<number>;
  onToggleStep: (step: number) => void;
};

export function StepGrid({ totalSteps, activeStep, checkedSteps, onToggleStep }: Props) {
  // 16ステップは 2行 × 8列、それ以外は 1行
  const cols = Math.min(totalSteps, 8);

  return (
    <div
      className={styles.grid}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const isActive = i === activeStep;
        const isChecked = checkedSteps.has(i);
        const isAccent = i === 0 || i === 8; // 各行の先頭

        return (
          <button
            key={i}
            className={[
              styles.step,
              isChecked ? styles.checked : styles.unchecked,
              isActive ? (isAccent ? styles.activeAccent : styles.active) : '',
              isAccent ? styles.accent : '',
            ].join(' ')}
            onClick={() => onToggleStep(i)}
            aria-label={`Step ${i + 1} ${isChecked ? 'on' : 'off'}`}
            aria-pressed={isChecked}
          >
            <span className={styles.stepNumber}>{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}
