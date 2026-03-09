import styles from './StepGrid.module.css';

type Props = {
  totalSteps: number;
  activeStep: number;       // -1 = 停止中
  checkedSteps: Set<number>;
  onToggleStep: (step: number) => void;
};

/**
 * 16ステップモード: 各ビートを「表拍」と「裏拍(&)」に分割して表示
 *   index 0  → beat 1 (表拍)
 *   index 1  → beat 1 & (裏拍)
 *   index 2  → beat 2 (表拍)  ...
 */
function getLabel(index: number, totalSteps: number): string {
  if (totalSteps === 16) {
    return index % 2 === 0 ? String(index / 2 + 1) : '&';
  }
  return String(index + 1);
}

function isAndBeat(index: number, totalSteps: number): boolean {
  return totalSteps === 16 && index % 2 === 1;
}

export function StepGrid({ totalSteps, activeStep, checkedSteps, onToggleStep }: Props) {
  const cols = Math.min(totalSteps, 8);

  return (
    <div
      className={styles.grid}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const isActive  = i === activeStep;
        const isChecked = checkedSteps.has(i);
        const isAccent  = i === 0 || i === 8; // beat 1 / beat 5
        const isAnd     = isAndBeat(i, totalSteps);

        return (
          <button
            key={i}
            className={[
              styles.step,
              isAnd ? styles.andStep : '',
              isChecked ? styles.checked : styles.unchecked,
              isActive ? (isAccent ? styles.activeAccent : styles.active) : '',
              isAccent ? styles.accent : '',
            ].join(' ')}
            onClick={() => onToggleStep(i)}
            aria-label={`Step ${getLabel(i, totalSteps)} ${isChecked ? 'on' : 'off'}`}
            aria-pressed={isChecked}
          >
            <span className={styles.stepNumber}>{getLabel(i, totalSteps)}</span>
          </button>
        );
      })}
    </div>
  );
}
