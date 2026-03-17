import { useState, useRef, useCallback, useEffect } from 'react';
import YouTube, { type YouTubePlayer } from 'react-youtube';
import { useBpmMeasure } from '../hooks/useBpmMeasure';
import styles from './YouTubeControl.module.css';

type Props = {
  isPlaying: boolean;
  bpm: number;
  onBpmChange: (bpm: number) => void;
  onStart: (delayMs?: number) => void;
  onStop: () => void;
  onAdjustOffset: (ms: number) => void;
  initialVideoId?: string | null;
  initialOffset?: number;
};

function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0];
    const v = url.searchParams.get('v');
    if (v) return v;
    const m = url.pathname.match(/\/embed\/([\w-]{11})/);
    if (m) return m[1];
  } catch { /* not a URL */ }
  return null;
}

/** Format seconds → "M:SS.s" */
function formatVideoTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export function YouTubeControl({ isPlaying, bpm, onBpmChange, onStart, onStop, onAdjustOffset, initialVideoId, initialOffset }: Props) {
  const [urlInput, setUrlInput] = useState(initialVideoId ?? '');
  const [videoId, setVideoId] = useState<string | null>(initialVideoId ?? null);
  const [baseBpm, setBaseBpm] = useState<number | null>(null);
  /** Video timestamp (seconds) captured when the user started measuring beat 1 */
  const [syncPoint, setSyncPoint] = useState<number | null>(null);
  const [ytVolume, setYtVolume] = useState(80);
  const [ytMuted, setYtMuted] = useState(false);
  const [offset, setOffset] = useState(initialOffset ?? 0);

  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerReadyRef = useRef(false);

  const handleMeasuredBpm = useCallback((measured: number) => {
    setBaseBpm(measured);
    onBpmChange(measured);
  }, [onBpmChange]);

  const {
    mode, switchMode,
    isPressing, elapsedMs, estimatedBeat,
    firstTapSet,
    handlePressStart, handlePressEnd, handleTap,
  } = useBpmMeasure(handleMeasuredBpm, bpm);

  /** Capture the current video position as beat-1 anchor, then start the measurement */
  const captureSyncPoint = useCallback(() => {
    try {
      const t = playerRef.current?.getCurrentTime?.();
      if (typeof t === 'number' && isFinite(t)) {
        setSyncPoint(t);
      }
    } catch { /* player not ready */ }
  }, []);

  /** Long-press wrapper: capture syncPoint on pointerdown */
  const handleMeasurePressStart = useCallback(() => {
    captureSyncPoint();
    handlePressStart();
  }, [captureSyncPoint, handlePressStart]);

  /** Two-tap wrapper: capture syncPoint on the FIRST tap only */
  const handleMeasureTap = useCallback(() => {
    if (!firstTapSet) {
      captureSyncPoint();
    }
    handleTap();
  }, [firstTapSet, captureSyncPoint, handleTap]);

  /* Playback rate: currentBpm / baseBpm */
  useEffect(() => {
    if (!playerReadyRef.current || !baseBpm || !playerRef.current) return;
    const rate = Math.min(2, Math.max(0.25, bpm / baseBpm));
    try { playerRef.current.setPlaybackRate(rate); } catch { /* ignore */ }
  }, [bpm, baseBpm]);

  /* YouTube volume / mute */
  useEffect(() => {
    if (!playerReadyRef.current || !playerRef.current) return;
    try {
      if (ytMuted) {
        playerRef.current.mute();
      } else {
        playerRef.current.unMute();
        playerRef.current.setVolume(ytVolume);
      }
    } catch { /* ignore */ }
  }, [ytVolume, ytMuted]);

  const handleLoad = useCallback(() => {
    const id = extractVideoId(urlInput);
    if (id) {
      setVideoId(id);
      setSyncPoint(null); // reset on new video
    }
  }, [urlInput]);

  const handlePlayerReady = useCallback((e: { target: YouTubePlayer }) => {
    playerRef.current = e.target;
    playerReadyRef.current = true;
    try { e.target.setVolume(ytVolume); } catch { /* ignore */ }
  }, [ytVolume]);

  // State change is observed only to keep UI in sync — AudioEngine is
  // started exclusively from handleSyncStart (same user gesture, iOS safe).
  const handleStateChange = useCallback((_e: { data: number }) => {}, []);

  /**
   * Start Sync — iOS compatible: both calls in same user gesture.
   * Seeks to syncPoint (beat 1 captured during measurement) so that
   * video beat 1 and AudioEngine beat 1 start at the same instant.
   */
  const handleSyncStart = useCallback(() => {
    try {
      playerRef.current?.seekTo(syncPoint ?? 0, true);
      playerRef.current?.playVideo();
    } catch { /* ignore */ }
    onStart(offset);
  }, [onStart, offset, syncPoint]);

  const handleStop = useCallback(() => {
    try { playerRef.current?.pauseVideo(); } catch { /* ignore */ }
    onStop();
  }, [onStop]);

  const handleOffsetAdjust = useCallback((delta: number) => {
    setOffset(o => Math.max(-500, Math.min(500, o + delta)));
    if (isPlaying) onAdjustOffset(delta);
  }, [isPlaying, onAdjustOffset]);

  const playbackRate = baseBpm ? Math.min(2, Math.max(0.25, bpm / baseBpm)) : 1;

  return (
    <div className={styles.wrapper}>

      {/* ── BPM 測定 ── */}
      <div className={styles.block}>
        <div className={styles.blockHeader}>
          <span className={styles.blockLabel}>BPM 測定</span>
          <div className={styles.modeToggle}>
            <button
              className={`${styles.modeBtn} ${mode === 'longpress' ? styles.modeBtnActive : ''}`}
              onClick={() => switchMode('longpress')}
            >長押し</button>
            <button
              className={`${styles.modeBtn} ${mode === 'twotap' ? styles.modeBtnActive : ''}`}
              onClick={() => switchMode('twotap')}
            >2タップ</button>
          </div>
        </div>

        {/* Beat dots 1–8 */}
        <div className={styles.beatDots}>
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className={[
                styles.beatDot,
                isPressing && i < estimatedBeat ? styles.beatDotLit : '',
                isPressing && i === estimatedBeat - 1 ? styles.beatDotCurrent : '',
              ].filter(Boolean).join(' ')}
            >
              {i + 1}
            </div>
          ))}
        </div>

        {/* Measure button */}
        {mode === 'longpress' ? (
          <button
            className={`${styles.measureBtn} ${isPressing ? styles.measureBtnActive : ''}`}
            onPointerDown={handleMeasurePressStart}
            onPointerUp={handlePressEnd}
            onPointerLeave={handlePressEnd}
          >
            {isPressing
              ? `${(elapsedMs / 1000).toFixed(1)} s 計測中…`
              : '① 押す  →  ⑧ 離す（8拍分）'}
          </button>
        ) : (
          <button
            className={`${styles.measureBtn} ${(isPressing || firstTapSet) ? styles.measureBtnActive : ''}`}
            onClick={handleMeasureTap}
          >
            {!firstTapSet
              ? '「1」でタップ'
              : `${(elapsedMs / 1000).toFixed(1)} s — 「次の1」でタップ`}
          </button>
        )}

        {baseBpm !== null && (
          <div className={styles.bpmResult}>
            <span className={styles.bpmResultValue}>{baseBpm}</span>
            <span className={styles.bpmResultUnit}>BPM 基準</span>
            {bpm !== baseBpm && (
              <span className={styles.rateTag}>×{playbackRate.toFixed(2)}</span>
            )}
          </div>
        )}

        {/* syncPoint indicator */}
        {syncPoint !== null && (
          <div className={styles.syncPointRow}>
            <span className={styles.syncPointIcon}>●</span>
            <span className={styles.syncPointLabel}>
              同期ポイント
            </span>
            <span className={styles.syncPointValue}>
              {formatVideoTime(syncPoint)}
            </span>
          </div>
        )}
      </div>

      {/* ── YouTube ── */}
      <div className={styles.block}>
        <div className={styles.blockHeader}>
          <span className={styles.blockLabel}>YouTube</span>
        </div>

        <div className={styles.urlRow}>
          <input
            className={styles.urlInput}
            type="text"
            placeholder="URL または Video ID"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLoad()}
          />
          <button className={styles.loadBtn} onClick={handleLoad}>Load</button>
        </div>

        {videoId && (
          <>
            <div className={styles.playerWrapper}>
              <YouTube
                videoId={videoId}
                opts={{ width: '100%', height: '100%', playerVars: { autoplay: 0 } }}
                onReady={handlePlayerReady}
                onStateChange={handleStateChange}
                className={styles.ytFrame}
              />
            </div>

            {/* Volume */}
            <div className={styles.volRow}>
              <button
                className={`${styles.muteBtn} ${ytMuted ? styles.muteBtnMuted : ''}`}
                onClick={() => setYtMuted(m => !m)}
                title={ytMuted ? 'ミュート解除' : 'ミュート'}
              >
                {ytMuted ? '🔇' : '🔊'}
              </button>
              <input
                type="range"
                min={0} max={100} step={1}
                value={ytVolume}
                onChange={(e) => setYtVolume(Number(e.target.value))}
                className={styles.volSlider}
                disabled={ytMuted}
                aria-label="YouTube 音量"
              />
              <span className={styles.volValue}>{ytMuted ? '–' : `${ytVolume}%`}</span>
            </div>
          </>
        )}
      </div>

      {/* ── 同期 ── */}
      <div className={styles.block}>
        <div className={styles.blockHeader}>
          <span className={styles.blockLabel}>同期</span>
          {syncPoint !== null && (
            <span className={styles.syncPointBadge}>
              beat 1 @ {formatVideoTime(syncPoint)}
            </span>
          )}
        </div>

        {/* Offset fine-tuning */}
        <div className={styles.offsetRow}>
          <span className={styles.offsetLabel}>ラグ補正</span>
          <button className={styles.offsetBtn} onClick={() => handleOffsetAdjust(-50)}>−</button>
          <span className={styles.offsetValue}>
            {offset === 0 ? '0 ms' : `${offset > 0 ? '+' : ''}${offset} ms`}
          </span>
          <button className={styles.offsetBtn} onClick={() => handleOffsetAdjust(50)}>＋</button>
        </div>

        {/* Start / Stop */}
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
            {syncPoint !== null
              ? `▶ Start Sync  (→ ${formatVideoTime(syncPoint)})`
              : '▶ Start Sync'}
          </button>
        )}
      </div>
    </div>
  );
}
