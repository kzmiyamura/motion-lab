import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { getJobDetail, resolveHomeServerUrl, type AnalysisJobDetail } from '../engine/homeServer';
import { routineFromResult } from '../engine/routineClip';
import { sendRoutineTo3D } from '../engine/routineBus';
import {
  mapFrameUrls, moveFramesPending, parseChoreoSheet, parseMoveFrames, reportSummary,
  type MoveFrameSet, type SheetRow,
} from '../engine/choreoSheet';
import { ChoreoSheet } from './ChoreoSheet';
import { MoveClipPlayer } from './MoveClipPlayer';
import styles from './ReportModal.module.css';

type Props = {
  jobId: string;
  videoTitle: string;
  baseUrl: string;
  /** 元動画の URL（解決済みの HLS playlist）。あれば振付シートのカードから技の区間をスロー再生できる */
  videoUrl?: string | null;
  onClose: () => void;
};

const FRAME_POLL_MS = 8000;
const FRAME_POLL_MAX = 45; // 約6分（57技の画像作成が2〜3分）

// リーダー技ジェネレーター（Artifact）。解析結果を貼り付けて動画のルーティンを再現する
const GENERATOR_URL = 'https://claude.ai/code/artifact/761235c0-5005-41e4-a315-5772ca8b516e';

/** result.json に再現可能な技イベントが含まれるか（events の件数）を返す */
function countEvents(resultJson: string | null): number {
  if (!resultJson) return 0;
  try {
    const d = JSON.parse(resultJson) as { events?: unknown[] };
    return Array.isArray(d.events) ? d.events.length : 0;
  } catch {
    return 0;
  }
}

/** インライン記法（リンク・太字・コード）を React ノードに変換する */
function renderInline(text: string, baseUrl: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // [text](url) / **bold** / `code` を1パスで分解
  const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      // 相対パス（/analysis-output/... 等）はホームサーバーのURLに解決する
      const href = m[2].startsWith('/') ? resolveHomeServerUrl(baseUrl, m[2]) ?? m[2] : m[2];
      nodes.push(<a key={`${keyPrefix}-a${i}`} href={href} target="_blank" rel="noreferrer">{m[1]}</a>);
    } else if (m[3] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[3]}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-c${i}`}>{m[4]}</code>);
    }
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * レポート用の軽量 Markdown レンダラ（見出し・箇条書き・表・リンク・太字のみ）。
 * レポートはサーバー側で生成する既知の形式なので、汎用ライブラリは入れない
 */
function renderMarkdown(md: string, baseUrl: string): ReactNode[] {
  const lines = md.split('\n');
  const out: ReactNode[] = [];
  let listBuf: string[] = [];
  let tableBuf: string[] = [];

  const flushList = (key: string) => {
    if (listBuf.length === 0) return;
    out.push(
      <ul key={key} className={styles.list}>
        {listBuf.map((item, i) => <li key={i}>{renderInline(item, baseUrl, `${key}-${i}`)}</li>)}
      </ul>,
    );
    listBuf = [];
  };
  const flushTable = (key: string) => {
    if (tableBuf.length === 0) return;
    const rows = tableBuf
      .map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
      .filter(cells => !cells.every(c => /^:?-+:?$/.test(c))); // 区切り行を除く
    const [head, ...body] = rows;
    out.push(
      <div key={key} className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr>{head.map((c, i) => <th key={i}>{renderInline(c, baseUrl, `${key}-h${i}`)}</th>)}</tr></thead>
          <tbody>
            {body.map((cells, ri) => (
              <tr key={ri}>{cells.map((c, ci) => <td key={ci}>{renderInline(c, baseUrl, `${key}-${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    tableBuf = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const key = `l${idx}`;
    if (/^\|.*\|$/.test(line.trim())) {
      flushList(`${key}-ul`);
      tableBuf.push(line.trim());
      return;
    }
    flushTable(`${key}-tb`);
    const list = line.match(/^\s*[-*]\s+(.*)$/) ?? line.match(/^\s*\d+\.\s+(.*)$/);
    if (list) {
      listBuf.push(list[1]);
      return;
    }
    flushList(`${key}-ul`);
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const cls = level <= 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
      out.push(<p key={key} className={cls}>{renderInline(heading[2], baseUrl, key)}</p>);
      return;
    }
    if (line.trim() === '') return;
    // 1行まるごとの画像（技のタイムラインの各場面の連続コマ）。タップで原寸を開く
    const img = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      const src = img[2].startsWith('/') ? resolveHomeServerUrl(baseUrl, img[2]) ?? img[2] : img[2];
      out.push(
        <a key={key} href={src} target="_blank" rel="noreferrer" className={styles.figure}>
          <img src={src} alt={img[1]} loading="lazy" className={styles.figureImg} />
        </a>,
      );
      return;
    }
    out.push(<p key={key} className={styles.para}>{renderInline(line, baseUrl, key)}</p>);
  });
  flushList('tail-ul');
  flushTable('tail-tb');
  return out;
}

export function ReportModal({ jobId, videoTitle, baseUrl, videoUrl, onClose }: Props) {
  const [job, setJob] = useState<AnalysisJobDetail | null>(null);
  const [error, setError] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [moveFrames, setMoveFrames] = useState<Map<number, MoveFrameSet>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    getJobDetail(baseUrl, jobId)
      .then(j => { if (!cancelled) setJob(j); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'レポートの取得に失敗しました'); });
    return () => { cancelled = true; };
  }, [baseUrl, jobId]);

  // 振付シート（result.json の routine.moves があれば既定の表示。無ければ従来の Markdown）
  const sheet = useMemo(() => parseChoreoSheet(job?.resultJson ?? null), [job]);
  const summary = useMemo(() => (sheet ? reportSummary(job?.reportMd ?? null) : []), [sheet, job]);

  // 技ごとの連続コマ画像（サーバーの out/move_frames/index.json）。
  // 画像はジョブ完了の直前（または後からの作り直し）で作られるので、開いた時点でまだ無い・作成途中のことがある。
  // そのときは揃うまで読み直す（以前は1回きりで、作成中に開くと写真が一枚も出なかった）。
  // ブラウザのキャッシュで古い・空の index を掴まないよう no-store で取る
  useEffect(() => {
    if (!sheet) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = resolveHomeServerUrl(baseUrl, `/analysis-output/${jobId}/out/move_frames/index.json`);
    if (!url) return;
    let tries = 0;
    const load = () => {
      tries++;
      fetch(url, { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(json => {
          if (cancelled) return;
          if (json) {
            const raw = parseMoveFrames(json, sheet.rows);
            const resolved = new Map<number, MoveFrameSet>();
            const abs = (p: string) => (p.startsWith('/') ? resolveHomeServerUrl(baseUrl, p) ?? p : p);
            raw.forEach((set, i) => resolved.set(i, mapFrameUrls(set, abs)));
            setMoveFrames(resolved);
          }
          if ((!json || moveFramesPending(json)) && tries < FRAME_POLL_MAX) timer = setTimeout(load, FRAME_POLL_MS);
        })
        .catch(() => {
          if (!cancelled && tries < FRAME_POLL_MAX) timer = setTimeout(load, FRAME_POLL_MS);
        });
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sheet, baseUrl, jobId]);

  // 見て覚える: カードを押すとその技の区間を 0.5 倍で繰り返す（元動画が分かるときだけ）
  const [clip, setClip] = useState<SheetRow | null>(null);
  const playRow = (row: SheetRow) => setClip(c => (c?.index === row.index ? null : row));

  // 解析結果をクリップボードへコピーし、ジェネレーターを新しいタブで開く。
  // ユーザーはジェネレーターの「📥」に貼り付けて、動画のルーティンを骨格で再現できる。
  const reproduceInGenerator = async () => {
    if (!job?.resultJson) return;
    try {
      await navigator.clipboard.writeText(job.resultJson);
      setCopyMsg('解析結果をコピーしました。ジェネレーターの「📥」に貼り付けてください');
    } catch {
      setCopyMsg('コピーできませんでした。タブを開いたら result.json を手動で貼り付けてください');
    }
    window.open(GENERATOR_URL, '_blank', 'noopener');
  };
  const canReproduce = countEvents(job?.resultJson ?? null) > 0;
  // 解析の技の並びを、アプリ内の 3D（手描きの振付を並べたもの）で再生する
  const routine = routineFromResult(job?.resultJson ?? null);
  const playIn3D = () => {
    if (!routine) return;
    sendRoutineTo3D(routine, videoTitle);
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>📋 解析レポート — {videoTitle}</h3>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div className={styles.body}>
          {error && <p className={styles.error}>{error}</p>}
          {!job && !error && <p className={styles.hint}>読み込み中…</p>}
          {job && sheet && (
            <>
              {summary.length > 0 && (
                <div className={styles.summary}>
                  {summary.map((s, i) => <p key={i} className={styles.para}>{renderInline(s, baseUrl, `sum${i}`)}</p>)}
                </div>
              )}
              {videoUrl && clip && clip.start !== null && (
                <MoveClipPlayer
                  src={videoUrl}
                  start={clip.start}
                  end={clip.end ?? clip.start + 8 * (sheet.beatSec ?? 0.35)}
                  beatSec={sheet.beatSec}
                  label={`#${clip.no} ${clip.name}（${clip.counts}）`}
                  onClose={() => setClip(null)}
                />
              )}
              <ChoreoSheet
                sheet={sheet}
                frames={moveFrames}
                onPlay={videoUrl ? playRow : undefined}
                playingIndex={clip?.index ?? null}
              />
              {job.reportMd && (
                <>
                  <button
                    type="button"
                    className={styles.detailToggle}
                    aria-expanded={showDetail}
                    onClick={() => setShowDetail(v => !v)}
                  >
                    {showDetail ? '詳細を閉じる ▲' : '詳細を表示 ▼'}
                  </button>
                  {showDetail && <div className={styles.detail}>{renderMarkdown(job.reportMd, baseUrl)}</div>}
                </>
              )}
            </>
          )}
          {job && !sheet && (
            job.reportMd
              ? renderMarkdown(job.reportMd, baseUrl)
              : <p className={styles.hint}>このジョブにはレポートがありません（status: {job.status}{job.errorMessage ? ` / ${job.errorMessage}` : ''}）</p>
          )}
        </div>
        {(canReproduce || routine) && (
          <div className={styles.genRow}>
            {routine && (
              <button className={styles.genBtn} onClick={playIn3D}>
                🧍 3Dで再現
              </button>
            )}
            {canReproduce && (
              <button className={styles.genBtn} onClick={reproduceInGenerator}>
                🕺 ジェネレーターで再現
              </button>
            )}
            {copyMsg && <span className={styles.genMsg}>{copyMsg}</span>}
          </div>
        )}
        {job?.finishedAt && (
          <p className={styles.meta}>解析完了: {new Date(job.finishedAt).toLocaleString()} / preset: {job.preset}</p>
        )}
      </div>
    </div>
  );
}
