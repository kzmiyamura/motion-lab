import { useEffect, useState, type ReactNode } from 'react';
import { getJobDetail, resolveHomeServerUrl, type AnalysisJobDetail } from '../engine/homeServer';
import styles from './ReportModal.module.css';

type Props = {
  jobId: string;
  videoTitle: string;
  baseUrl: string;
  onClose: () => void;
};

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
    out.push(<p key={key} className={styles.para}>{renderInline(line, baseUrl, key)}</p>);
  });
  flushList('tail-ul');
  flushTable('tail-tb');
  return out;
}

export function ReportModal({ jobId, videoTitle, baseUrl, onClose }: Props) {
  const [job, setJob] = useState<AnalysisJobDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getJobDetail(baseUrl, jobId)
      .then(j => { if (!cancelled) setJob(j); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'レポートの取得に失敗しました'); });
    return () => { cancelled = true; };
  }, [baseUrl, jobId]);

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
          {job && (
            job.reportMd
              ? renderMarkdown(job.reportMd, baseUrl)
              : <p className={styles.hint}>このジョブにはレポートがありません（status: {job.status}{job.errorMessage ? ` / ${job.errorMessage}` : ''}）</p>
          )}
        </div>
        {job?.finishedAt && (
          <p className={styles.meta}>解析完了: {new Date(job.finishedAt).toLocaleString()} / preset: {job.preset}</p>
        )}
      </div>
    </div>
  );
}
