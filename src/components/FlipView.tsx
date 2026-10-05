import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { ChoreoSheetData, MoveFrameSet, SheetRow } from '../engine/choreoSheet';
import {
  FLIP_SPEEDS, clampPage, dragOffset, captionIndex, frameAt, frameCaption, frameCount, frameLabel, frameSpans, keyStep, loadFlipSpeed, loopTime,
  moveWindow, pageLabel, parseFlipIndex, preloadUrls, saveFlipSpeed, sourceFromFrameSet, splitStrip, swipeStep,
  type FlipFrame, type FlipSource, type FlipSpeed, type MoveWindow,
} from '../engine/flipView';
import { BeatScheduler, VirtualClock, buildTimeline, type Timeline } from '../engine/practice';
import { practiceAudio } from '../engine/practiceAudio';
import { MoveDiagram } from './MoveDiagram';
import sheetStyles from './ChoreoSheet.module.css';
import styles from './FlipView.module.css';

/**
 * 振付シートの「めくり」表示（ユーザーの提案: 上で切り抜き画像がパラパラ漫画のように動き、
 * 下の解説を指やマウスで左右にめくっていく）。
 *
 * - 上（約 55%）: 技のコマをカウントどおりの速さで繰り返し流す。タップで一時停止/再開、止めている間は
 *   スライダーと ◀ ▶ で 1 コマずつ。速度 0.25（既定） / 0.5 / 1 倍。🔊 で練習モードと同じカウントのクリックを重ねる
 * - 下: 1 技 1 ページの解説。指・マウスで横に払う / ← → キーで前後の技へ。上のコマも一緒に替わる
 * 画面いっぱいに重ねて出す（ReportModal の上）。純粋な計算は engine/flipView.ts
 */

type Props = {
  sheet: ChoreoSheetData;
  /** ReportModal が読んだ写真（行 index → コマ。URL は解決済み） */
  frames: Map<number, MoveFrameSet>;
  /** out/move_frames/index.json そのもの（flip[] を読むため）。無ければ frames だけで */
  framesIndex?: unknown;
  /** index.json の URL（サーバー相対）→ 絶対 URL */
  resolveUrl?: (url: string) => string;
  /** 開く技（routine.moves の位置 = SheetRow.index） */
  initialIndex?: number | null;
  /** ページが替わった（SheetRow.index） */
  onIndexChange?: (rowIndex: number) => void;
  /** 「一覧」へ戻る */
  onList?: () => void;
  /** レポートを閉じる */
  onClose?: () => void;
  title?: string;
};

const SNAP_MS = 260;

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const nowSec = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

// ─── パラパラ漫画 ─────────────────────────────────────────────────────────────

/** v1 の帯: 読み込んで幅が分かったらコマに分ける。分けられなければ null（帯をそのまま出す） */
function useStripFrames(source: FlipSource | null): { frames: FlipFrame[] | null; measured: boolean } {
  const [dims, setDims] = useState<{ url: string; w: number; h: number } | null>(null);
  const url = source?.kind === 'strip' ? source.strip : null;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) setDims({ url, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { if (!cancelled) setDims({ url, w: 0, h: 0 }); };
    img.src = url;
    return () => { cancelled = true; };
  }, [url]);
  if (!url) return { frames: null, measured: true };
  if (!dims || dims.url !== url) return { frames: null, measured: false };
  return { frames: splitStrip(url, dims.w, dims.h), measured: true };
}

function FrameImage({ frame, alt, visible }: { frame: FlipFrame; alt: string; visible: boolean }) {
  const cls = `${styles.frame} ${visible ? styles.frameOn : ''}`;
  if (frame.strip) {
    const { n, i, tileW, gap } = frame.strip;
    // 帯の i 番目のコマだけ見せる: 箱の縦横比 = コマ、帯を左へずらす（箱の幅 = コマの幅）
    return (
      <div className={cls} aria-hidden={!visible}>
        <div className={styles.stripBox} style={{ aspectRatio: `${tileW} / ${tileW * 1.5}` }}>
          <img src={frame.url} alt={visible ? alt : ''} draggable={false}
            style={{ left: `${(-i * (tileW + gap) * 100) / tileW}%`, width: `${((n * tileW + (n - 1) * gap) * 100) / tileW}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className={cls} aria-hidden={!visible}>
      <img src={frame.url} alt={visible ? alt : ''} draggable={false} decoding="async" />
    </div>
  );
}

type FlipbookProps = {
  row: SheetRow;
  source: FlipSource | null;
  beatSec: number | null;
  speed: FlipSpeed;
  onSpeed: (s: FlipSpeed) => void;
  clicks: boolean;
  onClicks: (on: boolean) => void;
  timeline: Timeline | null;
  playing: boolean;
  onPlaying: (p: boolean) => void;
};

function Flipbook({ row, source, beatSec, speed, onSpeed, clicks, onClicks, timeline, playing, onPlaying }: FlipbookProps) {
  const strip = useStripFrames(source);
  const frames: FlipFrame[] = useMemo(() => {
    if (!source) return [];
    if (source.kind === 'strip') return strip.frames ?? [];
    return source.frames;
  }, [source, strip.frames]);
  const win: MoveWindow = useMemo(() => moveWindow(row, beatSec), [row, beatSec]);
  const spans = useMemo(() => frameSpans(frames, win, beatSec), [frames, win, beatSec]);
  const [idx, setIdx] = useState(0);

  const [clock] = useState(() => new VirtualClock(nowSec));
  const clockRef = useRef(clock);
  const winRef = useRef(win);
  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  useLayoutEffect(() => {
    winRef.current = win;
    playingRef.current = playing;
    speedRef.current = speed;
  }, [win, playing, speed]);

  /** 時計を読む（区間の終わりを過ぎていたら頭へ戻す） */
  const mediaTime = useCallback(() => {
    const clock = clockRef.current!;
    const t = clock.time();
    const m = loopTime(t, winRef.current);
    if (m !== t) clock.seek(m);
    return m;
  }, []);

  // 技が替わった: 頭から（表示のコマは描画中に戻し、時計は effect で）
  const resetKey = useMemo(() => ({ start: win.start, end: win.end, frames }), [win.start, win.end, frames]);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setIdx(0);
  }
  useEffect(() => {
    clockRef.current!.seek(resetKey.start);
  }, [resetKey]);

  useEffect(() => { clockRef.current!.setRate(speed); }, [speed]);

  useEffect(() => {
    const clock = clockRef.current!;
    if (playing && spans.length > 1) clock.play();
    else clock.pause();
  }, [playing, spans.length]);

  useEffect(() => {
    if (!playing || spans.length < 2) return;
    let raf = 0;
    const step = () => {
      const i = frameAt(spans, mediaTime());
      setIdx(prev => (prev === i ? prev : i));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, spans, mediaTime]);

  // 🔊: 練習モードと同じスケジューラでカウントのクリックを鳴らす（同じ時計なのでコマとずれない）
  useEffect(() => {
    if (!clicks || !timeline) return;
    const sched = new BeatScheduler({
      timeline,
      clock: {
        mediaTime: () => (playingRef.current ? mediaTime() : null),
        rate: () => speedRef.current,
        end: () => winRef.current.end,
      },
      sink: {
        now: () => practiceAudio.now(),
        click: (at, accent) => practiceAudio.click(at, accent),
      },
      clicks: () => true,
      voice: () => false,
    });
    sched.start();
    return () => sched.stop();
  }, [clicks, timeline, mediaTime]);

  const seekFrame = (i: number) => {
    const k = Math.min(Math.max(i, 0), Math.max(spans.length - 1, 0));
    if (spans[k]) clockRef.current!.seek(spans[k].start);
    setIdx(k);
  };

  const toggle = () => {
    if (clicks) practiceAudio.unlock();
    onPlaying(!playing);
  };

  const cur = frames[Math.min(idx, frames.length - 1)];
  const curIdx = Math.min(idx, frames.length - 1);
  // 1/4 拍のコマは見出しを直前の拍のまま保つ
  const capIdx = cur ? captionIndex(frames, curIdx) : 0;
  const capFrame = cur ? frames[capIdx] : undefined;
  const caption = capFrame ? frameCaption(capFrame, capIdx, row.startPos) : '';
  const countWord = capFrame ? frameCount(capFrame) : '';
  const labelWord = capFrame ? frameLabel(capFrame, capIdx, row.startPos) : '';

  return (
    <div className={styles.flipbook}>
      <div
        className={styles.stage}
        role="button"
        tabIndex={0}
        aria-label={playing ? '一時停止' : '再生'}
        aria-pressed={!playing}
        data-testid="flipbook"
        onClick={toggle}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); toggle(); } }}
      >
        {frames.length > 0 && frames.map((f, i) => (
          <FrameImage key={`${f.url}#${i}`} frame={f} visible={i === idx}
            alt={`#${row.no} ${row.name} ${i + 1}/${frames.length}コマ目${caption && i === idx ? ` ${caption}` : ''}`} />
        ))}
        {frames.length === 0 && source?.kind === 'strip' && strip.measured && (
          // 帯を分けられなかった（古い形式）: 帯をそのまま
          <div className={`${styles.frame} ${styles.frameOn} ${styles.stripWhole}`}>
            <img src={source.strip} alt={`#${row.no} ${row.name} の連続コマ`} draggable={false} />
          </div>
        )}
        {frames.length === 0 && (!source || (source.kind === 'strip' && !strip.measured)) && (
          <p className={styles.noPhoto}>{source ? '読み込み中…' : 'この技の写真はまだありません'}</p>
        )}
        {cur && (countWord || labelWord) && (
          <div className={styles.caption} data-testid="flip-caption" aria-live="off">
            {countWord && <span className={styles.capCount}>{countWord}</span>}
            {labelWord && <span className={styles.capLabel}>{labelWord}</span>}
          </div>
        )}
        {frames.length > 1 && (
          <span className={styles.frameNo} aria-hidden="true">{idx + 1}/{frames.length}</span>
        )}
        {!playing && frames.length > 1 && <span className={styles.pauseMark} aria-hidden="true">❚❚</span>}
      </div>
      <div className={styles.controls} onClick={e => e.stopPropagation()}>
        {!playing && frames.length > 1 ? (
          <div className={styles.scrub}>
            <button type="button" className={styles.ctl} aria-label="前のコマ" onClick={() => seekFrame(idx - 1)} disabled={idx <= 0}>◀</button>
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              step={1}
              value={idx}
              aria-label="コマ"
              data-testid="flip-scrubber"
              onChange={e => seekFrame(Number(e.target.value))}
            />
            <button type="button" className={styles.ctl} aria-label="次のコマ" onClick={() => seekFrame(idx + 1)} disabled={idx >= frames.length - 1}>▶</button>
          </div>
        ) : <span className={styles.hint}>{frames.length > 1 ? 'タップで一時停止' : ''}</span>}
        <div className={styles.seg} role="group" aria-label="速さ">
          {FLIP_SPEEDS.map(s => (
            <button key={s} type="button" aria-pressed={speed === s}
              className={`${styles.segBtn} ${speed === s ? styles.segOn : ''}`} onClick={() => onSpeed(s)}>
              {s === 1 ? '1×' : `${s}×`}
            </button>
          ))}
        </div>
        {timeline && (
          <button type="button" aria-pressed={clicks} title="カウントのクリック"
            className={`${styles.ctl} ${clicks ? styles.ctlOn : ''}`}
            onClick={() => { practiceAudio.unlock(); onClicks(!clicks); }}>
            {clicks ? '🔊' : '🔈'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 解説のページ ─────────────────────────────────────────────────────────────

function MovePage({ row }: { row: SheetRow }) {
  const facts = (row.diagram ? [row.hold] : [row.hold, row.turn, row.pass]).filter(Boolean).join(' ／ ');
  return (
    <article className={styles.page} aria-label={`#${row.no} ${row.name}`}>
      <div className={styles.pageHead}>
        <span className={styles.no}>#{row.no}</span>
        {row.time && <span>{row.time}</span>}
        <span className={styles.counts}>{row.counts}</span>
      </div>
      <h2 className={styles.name}>
        {row.startPos && <span className={sheetStyles.pos} data-testid="start-pos">{row.startPos} →</span>}{row.startPos && " "}
        {row.name}
        {row.uncertain && <span className={sheetStyles.q} title="推定を含む（自信が低い）" aria-label="推定">?</span>}
      </h2>
      {row.steps.length > 0 && (
        <ul className={sheetStyles.steps}>
          {row.steps.map((s, i) => (
            <li key={i} className={sheetStyles.step}>
              <span className={sheetStyles.stepCount}>{s.count}</span>
              {s.leader && <span className={sheetStyles.lead}><b>男</b>{s.leader}</span>}
              {s.follower && <span className={sheetStyles.follow}><b>女</b>{s.follower}</span>}
            </li>
          ))}
        </ul>
      )}
      {facts && <p className={styles.facts}>{facts}</p>}
      {row.leaderTurn && <p className={styles.facts}>{row.leaderTurn}</p>}
      {row.diagram && <div className={styles.diagram}><MoveDiagram data={row.diagram} /></div>}
    </article>
  );
}

type SwipeProps = {
  rows: SheetRow[];
  page: number;
  onPage: (p: number) => void;
  /** go(-1 | 1) を外（キー操作）から呼べるように */
  goRef: RefObject<((step: -1 | 1) => void) | null>;
};

/** 横に払ってめくる。前・今・次の 3 ページを並べ、指に合わせてずらし、離したらスナップする */
function SwipePages({ rows, page, onPage, goRef }: SwipeProps) {
  const n = rows.length;
  const viewRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const [anim, setAnim] = useState<-1 | 0 | 1 | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; t: number; horiz: boolean | null } | null>(null);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef(page);
  useLayoutEffect(() => { pageRef.current = page; }, [page]);

  const finish = useCallback((step: -1 | 0 | 1) => {
    if (finishTimer.current) clearTimeout(finishTimer.current);
    finishTimer.current = null;
    setAnim(null);
    setDrag(0);
    if (step !== 0) onPage(clampPage(pageRef.current + step, n));
  }, [n, onPage]);

  const go = useCallback((step: -1 | 0 | 1) => {
    const next = pageRef.current + step;
    if (step !== 0 && (next < 0 || next >= n)) step = 0;
    if (prefersReducedMotion()) { finish(step); return; }
    setAnim(step);
    // transitionend が来ない（タブが裏・テスト環境）ときも必ず終わらせる
    if (finishTimer.current) clearTimeout(finishTimer.current);
    finishTimer.current = setTimeout(() => finish(step), SNAP_MS + 80);
  }, [n, finish]);

  useEffect(() => {
    goRef.current = s => go(s);
    return () => { goRef.current = null; };
  }, [go, goRef]);

  useEffect(() => () => { if (finishTimer.current) clearTimeout(finishTimer.current); }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (anim !== null) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp || Date.now(), horiz: null };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.horiz === null) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        g.horiz = true;
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* noop */ }
      } else if (Math.abs(dy) > 8) {
        g.horiz = false; // 縦のスクロールに任せる
      }
    }
    if (g.horiz) setDrag(dragOffset(dx, pageRef.current, n));
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!g.horiz) return;
    const dx = e.clientX - g.x;
    const ms = (e.timeStamp || Date.now()) - g.t;
    const width = viewRef.current?.clientWidth ?? 0;
    go(e.type === 'pointercancel' ? 0 : swipeStep(dx, width, ms, pageRef.current, n));
  };

  const shift = anim !== null ? `${-anim * 100}%` : `${drag}px`;
  const slots = [-1, 0, 1]
    .map(k => ({ k, row: rows[page + k] }))
    .filter((s): s is { k: number; row: SheetRow } => !!s.row);

  return (
    <div
      ref={viewRef}
      className={styles.viewport}
      data-testid="flip-pages"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div
        className={`${styles.track} ${anim !== null ? styles.snapping : ''}`}
        style={{ transform: `translate3d(${shift}, 0, 0)` }}
        onTransitionEnd={e => { if (e.target === e.currentTarget && anim !== null) finish(anim); }}
      >
        {slots.map(({ k, row }) => (
          <div key={row.index} className={styles.slot} style={{ transform: `translateX(${k * 100}%)` }}
            aria-hidden={k !== 0} data-current={k === 0 ? 'true' : undefined}>
            <MovePage row={row} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 一覧の上に出す「めくり / 一覧」の切り替え */
export function ReportViewToggle({ view, onChange }: { view: 'flip' | 'list'; onChange: (v: 'flip' | 'list') => void }) {
  return (
    <div className={`${styles.seg} ${styles.viewToggle}`} role="group" aria-label="表示">
      <button type="button" className={`${styles.segBtn} ${view === 'flip' ? styles.segOn : ''}`}
        aria-pressed={view === 'flip'} onClick={() => onChange('flip')}>めくり</button>
      <button type="button" className={`${styles.segBtn} ${view === 'list' ? styles.segOn : ''}`}
        aria-pressed={view === 'list'} onClick={() => onChange('list')}>一覧</button>
    </div>
  );
}

// ─── 全体 ─────────────────────────────────────────────────────────────────────

export function FlipView({
  sheet, frames, framesIndex, resolveUrl, initialIndex, onIndexChange, onList, onClose, title,
}: Props) {
  const rows = sheet.rows;
  const n = rows.length;
  const [page, setPage] = useState(() => {
    const p = initialIndex === null || initialIndex === undefined ? 0 : rows.findIndex(r => r.index === initialIndex);
    return clampPage(p < 0 ? 0 : p, n);
  });
  const [speed, setSpeedState] = useState<FlipSpeed>(loadFlipSpeed);
  const [clicks, setClicks] = useState(false);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const goRef = useRef<((step: -1 | 1) => void) | null>(null);

  const sources = useMemo(() => {
    if (framesIndex) {
      const parsed = parseFlipIndex(framesIndex, rows, resolveUrl);
      if (parsed.size > 0) return parsed;
    }
    const m = new Map<number, FlipSource>();
    rows.forEach(r => {
      const s = sourceFromFrameSet(frames.get(r.index));
      if (s) m.set(r.index, s);
    });
    return m;
  }, [framesIndex, frames, rows, resolveUrl]);

  const timeline = useMemo(
    () => buildTimeline(rows, sheet.beatSec, { timing: sheet.header[0] === 'On1' ? 'on1' : 'on2' }),
    [rows, sheet.beatSec, sheet.header],
  );
  const beatSec = sheet.beatSec ?? timeline?.beatSec ?? null;

  const row = rows[page];

  const changePage = useCallback((p: number) => {
    setPage(p);
    const r = rows[p];
    if (r) onIndexChange?.(r.index);
  }, [rows, onIndexChange]);

  // 今の技と次の技の写真を先に読んでおく
  useEffect(() => {
    const imgs = preloadUrls(sources, rows, page).map(u => {
      const img = new Image();
      img.decoding = 'async';
      img.src = u;
      return img;
    });
    return () => { imgs.length = 0; };
  }, [sources, rows, page]);

  // ← → で前後の技、Esc で一覧へ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const step = keyStep(e.key);
      if (step !== 0) {
        e.preventDefault();
        goRef.current?.(step);
      } else if (e.key === 'Escape' && onList) {
        e.preventDefault();
        onList();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onList]);

  const setSpeed = (s: FlipSpeed) => { setSpeedState(s); saveFlipSpeed(s); };

  if (!row) return null;
  const prev = rows[page - 1], next = rows[page + 1];

  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-label={`めくり — ${title ?? '振付シート'}`} data-testid="flip-view">
      <div className={styles.top}>
        <Flipbook
          row={row}
          source={sources.get(row.index) ?? null}
          beatSec={beatSec}
          speed={speed}
          onSpeed={setSpeed}
          clicks={clicks}
          onClicks={setClicks}
          timeline={timeline}
          playing={playing}
          onPlaying={setPlaying}
        />
        <div className={styles.bar}>
          <div className={styles.seg} role="group" aria-label="表示">
            <button type="button" className={`${styles.segBtn} ${styles.segOn}`} aria-pressed="true">めくり</button>
            <button type="button" className={styles.segBtn} aria-pressed="false" onClick={onList}>一覧</button>
          </div>
          {title && <span className={styles.title}>{title}</span>}
          {onClose && <button type="button" className={styles.close} aria-label="閉じる" onClick={onClose}>✕</button>}
        </div>
      </div>
      <div className={styles.bottom}>
        <SwipePages rows={rows} page={page} onPage={changePage} goRef={goRef} />
        <nav className={styles.nav} aria-label="技の移動">
          <button type="button" className={styles.navBtn} disabled={!prev} onClick={() => goRef.current?.(-1)}
            aria-label={prev ? `前の技: #${prev.no} ${prev.name}` : '前の技なし'}>
            {prev && <><span aria-hidden="true">‹</span><span className={styles.navName}>{prev.name}</span></>}
          </button>
          <span className={styles.pageNo} data-testid="flip-page">{pageLabel(page, n)}</span>
          <button type="button" className={`${styles.navBtn} ${styles.navNext}`} disabled={!next} onClick={() => goRef.current?.(1)}
            aria-label={next ? `次の技: #${next.no} ${next.name}` : '次の技なし'}>
            {next && <><span className={styles.navName}>{next.name}</span><span aria-hidden="true">›</span></>}
          </button>
        </nav>
      </div>
    </div>
  );
}
