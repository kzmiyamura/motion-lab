import styles from './FlipIndicator.module.css';
import type { ClavePattern } from '../engine/salsaPatterns';

type Props = {
  flipPending: boolean;
  flipTarget: ClavePattern | null;
};

export function FlipIndicator({ flipPending, flipTarget }: Props) {
  if (!flipPending || !flipTarget) return null;
  return (
    <div className={styles.bar}>
      <span className={styles.badge}>⚡ Flip Ready!</span>
      <span className={styles.next}>NEXT: {flipTarget.name}</span>
    </div>
  );
}
