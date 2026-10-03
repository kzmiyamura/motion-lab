import type { ReactNode } from 'react';
import type { ChoreoSheetData, MoveFrameSet, SheetRow } from '../engine/choreoSheet';
import styles from './ChoreoSheet.module.css';

type Props = {
  sheet: ChoreoSheetData;
  /** 行 index → 連続コマ写真（URL は解決済み） */
  frames: Map<number, MoveFrameSet>;
  /** 元動画が見られるとき: カードを押すとその技の区間をスローで流す */
  onPlay?: (row: SheetRow) => void;
  /** 再生中の行 index */
  playingIndex?: number | null;
};

/**
 * 技の連続コマ。v2（1コマずつ）はカード幅の半分強で横スクロール（スナップ）、
 * v1（古いジョブの帯）は高さを決めて横スクロール。
 * カードが押せない（元動画が無い）ときは、コマを押すと原寸の画像を開く
 */
function MovePhotos({ set, row, linkOut }: { set: MoveFrameSet; row: SheetRow; linkOut: boolean }) {
  const wrap = (url: string, cls: string, img: ReactNode, extra?: ReactNode) => (linkOut
    ? <a key={url} href={url} target="_blank" rel="noreferrer" className={cls}>{img}{extra}</a>
    : <span key={url} className={cls}>{img}{extra}</span>);
  if (set.frames.length > 0) {
    const n = set.frames.length;
    return (
      <div className={styles.shots} data-testid="choreo-shots">
        {set.frames.map((f, i) => wrap(
          f.url,
          styles.shot,
          <img src={f.url} alt={`#${row.no} ${row.name} ${i + 1}/${n}コマ目`} width={480} height={720} loading="lazy" />,
          <span className={styles.shotNo} aria-hidden="true">{i + 1}/{n}</span>,
        ))}
      </div>
    );
  }
  if (!set.strip) return null;
  return (
    <div className={styles.stripScroll}>
      {wrap(set.strip, '', <img src={set.strip} alt={`#${row.no} ${row.name} の連続コマ`} loading="lazy" />)}
    </div>
  );
}

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
          const photos = frames.get(row.index);
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
              {photos && <MovePhotos set={photos} row={row} linkOut={!playable} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
