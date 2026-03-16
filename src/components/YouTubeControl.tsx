import { useState, useRef, useCallback } from 'react';
import YouTube, { type YouTubePlayer } from 'react-youtube';
import { useTapTempo } from '../hooks/useTapTempo';
import styles from './YouTubeControl.module.css';

type Props = {
  isPlaying: boolean;
  bpm: number;
  onBpmChange: (bpm: number) => void;
  onStart: (delayMs?: number) => void;
  onStop: () => void;
};

function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  // Already a bare video ID (11 chars, no slashes)
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    // youtu.be/<id>
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0];
    // youtube.com/watch?v=<id>
    const v = url.searchParams.get('v');
    if (v) return v;
    // youtube.com/embed/<id>
    const embedMatch = url.pathname.match(/\/embed\/([\w-]{11})/);
    if (embedMatch) return embedMatch[1];
  } catch {
    // not a URL
  }
  return null;
}

export function YouTubeControl({ isPlaying, bpm, onBpmChange, onStart, onStop }: Props) {
  const [urlInput, setUrlInput] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0); // ms, 0–500
  const playerRef = useRef<YouTubePlayer | null>(null);

  const { tap, tapCount, reset: resetTaps } = useTapTempo(onBpmChange);

  const handleLoad = useCallback(() => {
    const id = extractVideoId(urlInput);
    if (id) {
      setVideoId(id);
    }
  }, [urlInput]);

  const handleSyncStart = useCallback(() => {
    // Both calls must happen in the same user gesture for iOS
    if (playerRef.current) {
      playerRef.current.seekTo(0);
      playerRef.current.playVideo();
    }
    onStart(offset);
  }, [onStart, offset]);

  const handleStop = useCallback(() => {
    if (playerRef.current) {
      playerRef.current.pauseVideo();
    }
    onStop();
  }, [onStop]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.title}>YouTube Sync</span>
      </div>

      {/* URL Input */}
      <div className={styles.urlRow}>
        <input
          className={styles.urlInput}
          type="text"
          placeholder="YouTube URL or Video ID"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLoad()}
        />
        <button className={styles.loadBtn} onClick={handleLoad}>
          Load
        </button>
      </div>

      {/* YouTube Player */}
      {videoId && (
        <div className={styles.playerWrapper}>
          <YouTube
            videoId={videoId}
            opts={{ width: '100%', height: '100%', playerVars: { autoplay: 0 } }}
            onReady={(e) => { playerRef.current = e.target; }}
            className={styles.ytFrame}
          />
        </div>
      )}

      {/* Tap Tempo */}
      <div className={styles.tapRow}>
        <button className={styles.tapBtn} onClick={tap}>
          Tap BPM
        </button>
        <span className={styles.tapInfo}>
          {tapCount < 4
            ? `あと ${4 - tapCount} 回タップ`
            : `${tapCount} taps → ${bpm} BPM`}
        </span>
        <button className={styles.resetBtn} onClick={resetTaps} title="タップリセット">
          ✕
        </button>
      </div>

      {/* Offset */}
      <div className={styles.offsetRow}>
        <span className={styles.offsetLabel}>オフセット</span>
        <button
          className={styles.offsetBtn}
          onClick={() => setOffset(o => Math.max(0, o - 50))}
          disabled={offset <= 0}
        >
          −
        </button>
        <span className={styles.offsetValue}>{offset} ms</span>
        <button
          className={styles.offsetBtn}
          onClick={() => setOffset(o => Math.min(500, o + 50))}
          disabled={offset >= 500}
        >
          ＋
        </button>
      </div>

      {/* Sync Start / Stop */}
      <div className={styles.syncRow}>
        {isPlaying ? (
          <button className={`${styles.syncBtn} ${styles.syncBtnStop}`} onClick={handleStop}>
            Stop Sync
          </button>
        ) : (
          <button
            className={`${styles.syncBtn} ${styles.syncBtnStart}`}
            onClick={handleSyncStart}
            disabled={!videoId}
            title={!videoId ? 'YouTube URLを先に読み込んでください' : ''}
          >
            ▶ Start Sync
          </button>
        )}
      </div>
    </div>
  );
}
