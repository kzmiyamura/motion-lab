import { useMemo } from 'react';
import { computeHits, type HitType } from '../engine/salsaPatterns';
import styles from './ClaveBeatGrid.module.css';

type Props = {
  beatPositions: number[];
};

const HIT_LABEL: Record<HitType, string> = {
  on:   '●',
  and:  '+',
  late: '~',
};

const HIT_CAPTION: Record<HitType, string> = {
  on:   'on',
  and:  'and',
  late: 'late',
};

export function ClaveBeatGrid({ beatPositions }: Props) {
  const hits = useMemo(() => computeHits(beatPositions), [beatPositions]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.grid}>
        {Array.from({ length: 8 }, (_, i) => {
          const beat = i + 1;          // 1-indexed
          const hitType = hits.get(beat) ?? null;
          const isDownbeat = beat === 1 || beat === 5;

          return (
            <div
              key={beat}
              className={[
                styles.tile,
                hitType ? styles[hitType] : styles.empty,
                isDownbeat ? styles.downbeat : '',
              ].join(' ')}
            >
              <span className={styles.beatNum}>{beat}</span>
              {hitType && (
                <span className={styles.hitMark}>
                  {HIT_LABEL[hitType]}
                </span>
              )}
              {hitType && (
                <span className={styles.hitCaption}>
                  {HIT_CAPTION[hitType]}
                </span>
              )}
              {isDownbeat && <span className={styles.downbeatDot} />}
            </div>
          );
        })}
      </div>

      {/* 凡例 */}
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.legendDot} ${styles.on}`} />ちょうど (On)
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendDot} ${styles.and}`} />裏拍 (+)
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendDot} ${styles.late}`} />遅れ (~)
        </span>
      </div>
    </div>
  );
}
