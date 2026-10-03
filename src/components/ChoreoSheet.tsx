import type { ChoreoSheetData } from '../engine/choreoSheet';
import styles from './ChoreoSheet.module.css';

type Props = {
  sheet: ChoreoSheetData;
  /** 行 index → 連続コマ画像の URL（解決済み） */
  frames: Map<number, string>;
};

/**
 * 振付シート: 1行 = 1技。上から順に見るだけでルーティンを頭から踊れるよう、
 * 技名を大きく、手・回転・通る側は短い記号のチップ、説明は写真（技の区間の連続コマ）で見せる
 */
export function ChoreoSheet({ sheet, frames }: Props) {
  return (
    <section className={styles.sheet} aria-label="振付シート">
      {sheet.header.length > 0 && (
        <p className={styles.header}>{sheet.header.join(' · ')}</p>
      )}
      <ol className={styles.rows}>
        {sheet.rows.map(row => {
          const img = frames.get(row.index);
          return (
            <li key={row.index} className={styles.row} data-testid="choreo-row">
              <div className={styles.head}>
                <span className={styles.no}>#{row.no}</span>
                {row.time && <span className={styles.time}>{row.time}</span>}
                <span className={styles.counts}>{row.counts}</span>
              </div>
              <p className={styles.name}>
                {row.name}
                {row.uncertain && (
                  <span className={styles.q} title="推定を含む（自信が低い）" aria-label="推定">?</span>
                )}
              </p>
              {(row.hold || row.turn || row.pass) && (
                <div className={styles.chips}>
                  {row.hold && <span className={styles.chip}><b>手</b>{row.hold}</span>}
                  {row.turn && <span className={styles.chip}><b>回転</b>{row.turn}</span>}
                  {row.pass && <span className={styles.chip}><b>通過</b>{row.pass}</span>}
                </div>
              )}
              {img && (
                <a href={img} target="_blank" rel="noreferrer" className={styles.strip}>
                  <img src={img} alt={`#${row.no} ${row.name} の連続コマ`} loading="lazy" />
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
