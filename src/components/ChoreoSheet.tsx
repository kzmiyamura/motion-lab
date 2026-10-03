import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { ChoreoSheetData, MoveFrameSet, SheetRow } from '../engine/choreoSheet';
import styles from './ChoreoSheet.module.css';
import { MoveDiagram } from './MoveDiagram';

type Props = {
  sheet: ChoreoSheetData;
  /** 行 index → 連続コマ写真（URL は解決済み） */
  frames: Map<number, MoveFrameSet>;
  /** 元動画が見られるとき: カードを押すとその技の区間をスローで流す */
  onPlay?: (row: SheetRow) => void;
  /** 再生中の行 index（練習中は今流れている技。変わったらそのカードへ画面を送る） */
  playingIndex?: number | null;
  /** シートの上に出す操作（練習モードの「通し練習」「範囲ループ」） */
  toolbar?: ReactNode;
  /** 範囲ループ中の行 index（両端を含む）。カードに印を付ける */
  range?: { from: number; to: number } | null;
  /** 範囲を選んでいる途中: カードを押すと onPick（再生しない）。anchorIndex は選んだ始めの行 */
  picking?: boolean;
  anchorIndex?: number | null;
  onPick?: (row: SheetRow) => void;
  /** カードの長押し（範囲ループの始め） */
  onLongPress?: (row: SheetRow) => void;
};

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP_PX = 10;

/** カードの長押し。指が動いた（スクロール）ら取り消す。長押しの後の click は捨てる */
function useLongPress(onLongPress?: (row: SheetRow) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => clear, []);
  if (!onLongPress) return null;
  return {
    fired,
    bind: (row: SheetRow) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.button !== undefined && e.button !== 0) return;
        clear();
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        timer.current = setTimeout(() => {
          timer.current = null;
          fired.current = true;
          try { navigator.vibrate?.(15); } catch { /* noop */ }
          onLongPress(row);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const o = origin.current;
        if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP_PX) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu: (e: ReactMouseEvent) => { e.preventDefault(); },
    }),
  };
}

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
          <img src={f.url} alt={`#${row.no} ${row.name} ${i + 1}/${n}コマ目${f.count ? ` ${f.count}拍目` : ''}${f.label ? ` ${f.label}` : ''}`}
            width={480} height={720} loading="lazy" />,
          <>
            <span className={styles.shotNo} aria-hidden="true">{i + 1}/{n}</span>
            {(f.count || f.label) && (
              <span className={styles.shotCap} data-testid="shot-caption">
                {f.count && <b>{f.count}</b>}
                {f.label}
              </span>
            )}
          </>,
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
export function ChoreoSheet({
  sheet, frames, onPlay, playingIndex, toolbar, range, picking, anchorIndex, onPick, onLongPress,
}: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const longPress = useLongPress(onLongPress);

  // 練習中: 今の技のカードを画面の真ん中へ送る
  useEffect(() => {
    if (playingIndex === null || playingIndex === undefined) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${playingIndex}"]`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [playingIndex]);

  return (
    <section className={styles.sheet} aria-label="振付シート">
      {sheet.header.length > 0 && (
        <p className={styles.header}>{sheet.header.join(' · ')}</p>
      )}
      {sheet.legend && <p className={styles.legend}>{sheet.legend}</p>}
      {toolbar}
      {onPlay && !toolbar && <p className={styles.tip}>カードを押すと、その技を 0.5 倍で繰り返し再生</p>}
      <ol className={styles.rows} ref={listRef}>
        {sheet.rows.map(row => {
          const photos = frames.get(row.index);
          const playable = !!onPlay && row.start !== null;
          const playing = playingIndex === row.index;
          const timed = row.start !== null;
          const inRange = !!range && row.index >= Math.min(range.from, range.to) && row.index <= Math.max(range.from, range.to);
          const pickable = !!picking && !!onPick && timed;
          const lp = longPress && timed ? longPress.bind(row) : null;
          return (
            <li
              key={row.index}
              data-index={row.index}
              className={[
                styles.row,
                playable || pickable ? styles.playable : '',
                playing ? styles.playing : '',
                inRange ? styles.inRange : '',
                anchorIndex === row.index ? styles.anchor : '',
                lp ? styles.pressable : '',
              ].filter(Boolean).join(' ')}
              data-testid="choreo-row"
              {...lp}
              onClickCapture={e => {
                // 長押しの直後の click・範囲選び中の click は再生（や写真のリンク）に渡さない
                if (longPress?.fired.current) {
                  longPress.fired.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                if (pickable) {
                  e.preventDefault();
                  e.stopPropagation();
                  onPick!(row);
                }
              }}
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
              {/* 回転・通る側は図の下の説明に出るので、図がある行は手だけ */}
              {(row.diagram ? row.hold : (row.hold || row.turn || row.pass)) && (
                <p className={styles.facts}>
                  {(row.diagram ? [row.hold] : [row.hold, row.turn, row.pass]).filter(Boolean).join(' ／ ')}
                </p>
              )}
              {row.diagram && <MoveDiagram data={row.diagram} />}
              {photos && <MovePhotos set={photos} row={row} linkOut={!playable} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
