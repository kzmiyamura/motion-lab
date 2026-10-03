import type { ChoreoSheetData, SheetRow } from '../engine/choreoSheet';
import styles from './ChoreoSheet.module.css';

type Props = {
  sheet: ChoreoSheetData;
  /** 行 index → 連続コマ画像の URL（解決済み） */
  frames: Map<number, string>;
  /** 元動画が見られるとき: カードを押すとその技の区間をスローで流す */
  onPlay?: (row: SheetRow) => void;
  /** 再生中の行 index */
  playingIndex?: number | null;
};

/**
 * 振付シート: 1行 = 1技。上から順に読むだけでルーティンを頭から踊れるよう、
 * 技名を大きく、その下にカウントごとの男女の動き（1-2-3 男:… 女:…）、手・回転・通る側は普通の言葉で小さく、
 * 最後に技の区間の連続コマ写真。元動画があればカードを押すとその技だけ 0.5 倍で繰り返し流す
 */
export function ChoreoSheet({ sheet, frames, onPlay, playingIndex }: Props) {
  return (
    <section className={styles.sheet} aria-label="振付シート">
      {sheet.header.length > 0 && (
        <p className={styles.header}>{sheet.header.join(' · ')}</p>
      )}
      {onPlay && <p className={styles.tip}>カードを押すと、その技を 0.5 倍で繰り返し再生</p>}
      <ol className={styles.rows}>
        {sheet.rows.map(row => {
          const img = frames.get(row.index);
          const playable = !!onPlay && row.start !== null;
          const playing = playingIndex === row.index;
          return (
            <li
              key={row.index}
              className={`${styles.row} ${playable ? styles.playable : ''} ${playing ? styles.playing : ''}`}
              data-testid="choreo-row"
              onClick={playable ? () => onPlay!(row) : undefined}
              role={playable ? 'button' : undefined}
              tabIndex={playable ? 0 : undefined}
              aria-label={playable ? `#${row.no} ${row.name} を再生` : undefined}
              onKeyDown={playable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay!(row); } } : undefined}
            >
              <div className={styles.head}>
                <span className={styles.no}>#{row.no}</span>
                {row.time && <span className={styles.time}>{row.time}</span>}
                <span className={styles.counts}>{row.counts}</span>
                {playable && <span className={styles.playMark} aria-hidden="true">{playing ? '■' : '▶'}</span>}
              </div>
              <p className={styles.name}>
                {row.name}
                {row.uncertain && (
                  <span className={styles.q} title="推定を含む（自信が低い）" aria-label="推定">?</span>
                )}
              </p>
              {row.steps.length > 0 && (
                <ul className={styles.steps}>
                  {row.steps.map((s, i) => (
                    <li key={i} className={styles.step}>
                      <span className={styles.stepCount}>{s.count}</span>
                      {s.leader && <span className={styles.lead}><b>男</b>{s.leader}</span>}
                      {s.follower && <span className={styles.follow}><b>女</b>{s.follower}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {(row.hold || row.turn || row.pass) && (
                <p className={styles.facts}>
                  {[row.hold, row.turn, row.pass].filter(Boolean).join(' ／ ')}
                </p>
              )}
              {img && (
                playable
                  ? <span className={styles.strip}><img src={img} alt={`#${row.no} ${row.name} の連続コマ`} loading="lazy" /></span>
                  : (
                    <a href={img} target="_blank" rel="noreferrer" className={styles.strip}>
                      <img src={img} alt={`#${row.no} ${row.name} の連続コマ`} loading="lazy" />
                    </a>
                  )
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
