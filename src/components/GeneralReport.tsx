import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { resolveHomeServerUrl } from '../engine/homeServer';
import { formatClock, nearestStill, parseGeneralResult, stillImagesFrom, type StillImage } from '../engine/generalReport';
import { useVideoSource } from '../hooks/usePractice';
import styles from './GeneralReport.module.css';

type Props = {
  jobId: string;
  baseUrl: string;
  resultJson: string | null;
  videoUrl?: string | null;
  /** report.md の本文（ReportModal の Markdown 表示を渡す） */
  body: ReactNode;
};

/** 汎用解析の表示: 要約 → 動画 → 所見（時刻を押すとシーク・近い静止画つき）→ 限界 → レポート本文（折りたたみ） */
export function GeneralReport({ jobId, baseUrl, resultJson, videoUrl, body }: Props) {
  const result = useMemo(() => parseGeneralResult(resultJson), [resultJson]);
  const [images, setImages] = useState<StillImage[]>([]);
  const [showBody, setShowBody] = useState(!result);
  const videoRef = useRef<HTMLVideoElement>(null);
  const failed = useVideoSource(videoRef, videoUrl ?? null);

  useEffect(() => {
    let cancelled = false;
    const url = resolveHomeServerUrl(baseUrl, `/analysis-output/${jobId}/out/measurements.json`);
    if (!url) return;
    fetch(url)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!cancelled && j) setImages(stillImagesFrom(j)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [baseUrl, jobId]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    v.scrollIntoView?.({ block: 'nearest' });
  };
  const thumbUrl = (file: string) =>
    resolveHomeServerUrl(baseUrl, `/analysis-output/${jobId}/out/keyframes/${file}`) ?? '';
  const canSeek = !!videoUrl && !failed;

  return (
    <div data-testid="general-report">
      {result?.summary && <p className={styles.summary}>{result.summary}</p>}
      {videoUrl && !failed && <video ref={videoRef} className={styles.video} controls playsInline muted />}
      {result && result.findings.length > 0 && (
        <ul className={styles.list} data-testid="general-findings">
          {result.findings.map((f, i) => {
            const img = nearestStill(images, f.t);
            return (
              <li key={i} className={styles.card} data-testid="general-finding">
                {img && <img className={styles.thumb} src={thumbUrl(img.file)} alt={f.title} loading="lazy" />}
                <div className={styles.text}>
                  {f.t !== null && (
                    canSeek
                      ? <button type="button" className={styles.time} onClick={() => seek(f.t as number)}>{formatClock(f.t)}</button>
                      : <span className={styles.time}>{formatClock(f.t)}</span>
                  )}
                  <strong className={styles.title}>{f.title}</strong>
                  {f.detail && <p className={styles.detail}>{f.detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {result?.limitations && <p className={styles.limits}>限界: {result.limitations}</p>}
      {result && (
        <button type="button" className={styles.toggle} aria-expanded={showBody} onClick={() => setShowBody(v => !v)}>
          {showBody ? 'レポート本文を閉じる ▲' : 'レポート本文を表示 ▼'}
        </button>
      )}
      {showBody && <div>{body}</div>}
    </div>
  );
}
