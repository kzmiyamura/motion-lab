import type { MoveFrameSet, SheetRow } from '../engine/choreoSheet';
import { flowThumbUrl } from '../engine/flowList';
import styles from './FlowList.module.css';

type Props = {
  rows: SheetRow[];
  frames: Map<number, MoveFrameSet>;
  /** いま見ている技（SheetRow.index）。無ければ null */
  currentIndex: number | null;
  /** 押した技（SheetRow.index）。めくりならその技のページへ飛ぶ */
  onPick: (rowIndex: number) => void;
  /** grid = 横に流れるカード（PC の一覧の冒頭）/ list = 縦の番号リスト（携帯・めくりの横の列） */
  layout: 'grid' | 'list';
  /** 見出し（例: 「流れ（全 17 技）」）を出すか */
  heading?: boolean;
  /** 本文の写真の url を絶対 URL にする */
  resolveUrl?: (u: string) => string;
};

/**
 * ルーティンの「流れ」: 1→2→3… と技の順に、代表コマ・技名・手のつなぎ方・カウントを並べる。
 * 「何番目に何の技が来るか」を一目で頭に入れるための一覧。押すとその技のめくりへ飛ぶ
 */
export function FlowList({ rows, frames, currentIndex, onPick, layout, heading = true, resolveUrl }: Props) {
  return (
    <section className={`${styles.flow} ${layout === 'grid' ? styles.grid : styles.list}`} aria-label="技の流れ" data-testid="flow-list">
      {heading && <h3 className={styles.heading}>流れ <span className={styles.total}>全 {rows.length} 技</span></h3>}
      <ol className={styles.items}>
        {rows.map(row => {
          const thumb = flowThumbUrl(frames.get(row.index));
          const src = thumb && resolveUrl ? resolveUrl(thumb) : thumb;
          const here = currentIndex === row.index;
          return (
            <li key={row.index} className={styles.li}>
              <button
                type="button"
                className={`${styles.item} ${here ? styles.here : ''}`}
                aria-current={here ? 'step' : undefined}
                aria-label={`${row.no}番目 ${row.name}。めくりで開く`}
                data-testid="flow-item"
                onClick={() => onPick(row.index)}
              >
                <span className={styles.no} aria-hidden="true">{row.no}</span>
                <span className={styles.thumb}>
                  {src ? <img src={src} alt="" loading="lazy" width={120} height={180} /> : <span className={styles.noThumb} aria-hidden="true" />}
                </span>
                <span className={styles.text}>
                  <span className={styles.name}>{row.name}{row.uncertain && <span className={styles.q} aria-label="推定">?</span>}</span>
                  <span className={styles.meta}>
                    {row.hold && <span className={styles.hold}>{row.hold}</span>}
                    <span className={styles.counts}>{row.counts}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
