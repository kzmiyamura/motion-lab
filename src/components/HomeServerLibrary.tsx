import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { listHomeServerVideos, resolveHomeServerUrl, type HomeServerVideo } from '../engine/homeServer';
import styles from './HomeServerLibrary.module.css';

const HOME_SERVER_URL = (import.meta.env.VITE_HOME_SERVER_URL ?? '') as string;

export function HomeServerLibrary() {
  const [videos, setVideos] = useState<HomeServerVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState<HomeServerVideo | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const load = async () => {
    if (!HOME_SERVER_URL) return;
    setLoading(true);
    setError('');
    try {
      setVideos(await listHomeServerVideos(HOME_SERVER_URL));
    } catch (e) {
      setError(e instanceof Error ? e.message : '一覧の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing?.hlsUrl) return;
    const src = resolveHomeServerUrl(HOME_SERVER_URL, playing.hlsUrl);
    if (!src) return;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [playing]);

  if (!HOME_SERVER_URL) {
    return (
      <div className={styles.wrapper}>
        <p className={styles.emptyHint}>
          VITE_HOME_SERVER_URL が設定されていません。.env.local を確認してください。
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      {playing && (
        <div className={styles.playerWrap}>
          <button className={styles.closeBtn} onClick={() => setPlaying(null)}>✕ 閉じる</button>
          <video ref={videoRef} className={styles.player} controls autoPlay playsInline />
          <p className={styles.playerTitle}>{playing.title}</p>
        </div>
      )}

      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionLabel}>🏠 ThinkCentre の動画</h3>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          {loading ? '…' : '↻ 更新'}
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {!loading && videos.length === 0 && !error && (
        <p className={styles.emptyHint}>まだ動画がありません。Files タブから「ThinkCentre に保存」してください。</p>
      )}

      <div className={styles.grid}>
        {videos.map(v => (
          <button
            key={v.id}
            className={styles.card}
            disabled={v.status !== 'ready'}
            onClick={() => setPlaying(v)}
          >
            <div className={styles.thumbWrap}>
              {v.thumbnailUrl ? (
                <img
                  className={styles.thumb}
                  src={resolveHomeServerUrl(HOME_SERVER_URL, v.thumbnailUrl) ?? undefined}
                  alt={v.title}
                  loading="lazy"
                />
              ) : (
                <div className={styles.thumbPlaceholder}>
                  {v.status === 'processing' ? '変換中…' : v.status === 'error' ? '⚠ エラー' : ''}
                </div>
              )}
            </div>
            <div className={styles.info}>
              <p className={styles.title}>{v.title}</p>
              {v.status === 'error' && (
                <p className={styles.cardError}>{v.errorMessage ?? '変換に失敗しました'}</p>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
