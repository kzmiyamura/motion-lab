import { CLAVE_PATTERNS, type ClavePattern } from '../engine/salsaPatterns';
import styles from './ClavePatternSelector.module.css';

type Props = {
  selectedId: string;
  onSelect: (pattern: ClavePattern) => void;
};

export function ClavePatternSelector({ selectedId, onSelect }: Props) {
  return (
    <div className={styles.grid}>
      {CLAVE_PATTERNS.map(pattern => (
        <button
          key={pattern.id}
          className={[
            styles.card,
            selectedId === pattern.id ? styles.selected : '',
          ].join(' ')}
          onClick={() => onSelect(pattern)}
          aria-pressed={selectedId === pattern.id}
        >
          <div className={styles.cardHeader}>
            <span className={styles.name}>{pattern.name}</span>
            <span className={styles.tag}>{pattern.tag}</span>
          </div>
          <p className={styles.description}>{pattern.description}</p>
        </button>
      ))}
    </div>
  );
}
