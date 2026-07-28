import { useEffect, useRef, useState } from 'react';
import {
  startRotationAnalysis, fetchRotationAnalysis, type RotationAnalysis, type RotationSample,
} from '../engine/homeServer';
import styles from './RotationMeter.module.css';

const HOME_SERVER_URL = (import.meta.env.VITE_HOME_SERVER_URL ?? '') as string;
const POLL_MS = 3000;

type Props = {
  /** ThinkCentre上の動画ID（ローカルファイル等、ThinkCentreに存在しない場合は null） */
  videoId: string | null;
  loopStart: number | null;
  loopEnd: number | null;
};

/** samples から t に最も近いサンプルを探す（許容誤差内になければ null） */
function findNearest(samples: RotationSample[], t: number, toleranceSec = 0.5): RotationSample | null {
  let best: RotationSample | null = null;
  let bestDiff = Infinity;
  for (const s of samples) {
    const diff = Math.abs(s.t - t);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best && bestDiff <= toleranceSec ? best : null;
}

export function RotationMeter({ videoId, loopStart, loopEnd }: Props) {
  const [analysis, setAnalysis] = useState<RotationAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const refresh = async () => {
    if (!videoId || !HOME_SERVER_URL) return;
    try {
      const a = await fetchRotationAnalysis(HOME_SERVER_URL, videoId);
      setAnalysis(a);
      if (a?.status !== 'processing') stopPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析結果の取得に失敗しました。');
      stopPolling();
    }
  };

  useEffect(() => {
    stopPolling();
    setAnalysis(null);
    setError('');
    refresh();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const handleAnalyze = async () => {
    if (!videoId) return;
    setLoading(true);
    setError('');
    try {
      await startRotationAnalysis(HOME_SERVER_URL, videoId);
      setAnalysis({ status: 'processing', fps: null, totalFrames: null, detectedFrames: null, samples: null, errorMessage: null, updatedAt: '' });
      pollRef.current = setInterval(refresh, POLL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析開始に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  if (!videoId || !HOME_SERVER_URL) return null;

  // ── 解析済みなら、現在のA-B区間から回転速度を算出 ──
  let rpm: number | null = null;
  let rpmHint = '';
  if (analysis?.status === 'ready' && analysis.samples) {
    if (loopStart === null || loopEnd === null) {
      rpmHint = 'A/B点を指定してください';
    } else {
      const s1 = findNearest(analysis.samples, loopStart);
      const s2 = findNearest(analysis.samples, loopEnd);
      if (!s1 || !s2) {
        rpmHint = 'その区間に検出データがありません';
      } else {
        const dtSec = s2.t - s1.t;
        const dAngle = s2.angleDeg - s1.angleDeg;
        if (dtSec > 0) rpm = (dAngle / 360) / dtSec * 60;
      }
    }
  }

  return (
    <div className={styles.row}>
      <span className={styles.label}>🔬 回転</span>

      {!analysis || analysis.status === 'error' ? (
        <>
          <button className={styles.analyzeBtn} onClick={handleAnalyze} disabled={loading}>
            {loading ? '開始中…' : analysis?.status === 'error' ? '再解析する' : '解析する'}
          </button>
          {analysis?.status === 'error' && (
            <span className={styles.hint} title={analysis.errorMessage ?? ''}>解析失敗</span>
          )}
        </>
      ) : analysis.status === 'processing' ? (
        <span className={styles.hint}>解析中…（数十秒〜かかります）</span>
      ) : rpm !== null ? (
        <span className={styles.rpmValue}>{Math.abs(rpm).toFixed(1)} RPM</span>
      ) : (
        <span className={styles.hint}>{rpmHint}</span>
      )}

      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
