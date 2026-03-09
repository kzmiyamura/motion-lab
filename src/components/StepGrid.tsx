import styles from './StepGrid.module.css';

type Props = {
  totalSteps: number;
  activeStep: number;       // -1 = 停止中
  checkedSteps: Set<number>;
  onToggleStep: (step: number) => void;
};

function getLabel(index: number, totalSteps: number): string {
  if (totalSteps === 16) {
    return index % 2 === 0 ? String(index / 2 + 1) : '&';
  }
  return String(index + 1);
}

function isAndBeat(index: number, totalSteps: number): boolean {
  return totalSteps === 16 && index % 2 === 1;
}

/** totalSteps に対応するグリッドクラス名を返す */
function gridClass(totalSteps: number): string {
  if (totalSteps <= 4)  return styles.cols4;
  if (totalSteps <= 8)  return styles.cols8;
  return styles.cols16;
}

export function StepGrid({ totalSteps, activeStep, checkedSteps, onToggleStep }: Props) {
  return (
    <div className={`${styles.grid} ${gridClass(totalSteps)}`}>
      {Array.from({ length: totalSteps }, (_, i) => {
        const isActive  = i === activeStep;
        const isChecked = checkedSteps.has(i);
        const isAccent  = i === 0 || i === 8;
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
