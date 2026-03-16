import { useState, useRef, useCallback, useEffect } from 'react';
import YouTube, { type YouTubePlayer } from 'react-youtube';
import { useBpmMeasure } from '../hooks/useBpmMeasure';
import styles from './YouTubeControl.module.css';

const YT_PLAYING = 1;

type Props = {
  isPlaying: boolean;
  bpm: number;
  onBpmChange: (bpm: number) => void;
  onStart: (delayMs?: number) => void;
  onStop: () => void;
  onAdjustOffset: (ms: number) => void;
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

export function YouTubeControl({ isPlaying, bpm, onBpmChange, onStart, onStop, onAdjustOffset }: Props) {
  const [urlInput, setUrlInput] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [baseBpm, setBaseBpm] = useState<number | null>(null);
  const [ytVolume, setYtVolume] = useState(80);
  const [ytMuted, setYtMuted] = useState(false);
  const [offset, setOffset] = useState(0);

  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerReadyRef = useRef(false);
  const pendingSyncRef = useRef(false);

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
    if (id) setVideoId(id);
  }, [urlInput]);

  const handlePlayerReady = useCallback((e: { target: YouTubePlayer }) => {
    playerRef.current = e.target;
    playerReadyRef.current = true;
    try { e.target.setVolume(ytVolume); } catch { /* ignore */ }
  }, [ytVolume]);

  const handleStateChange = useCallback((e: { data: number }) => {
    if (e.data === YT_PLAYING) {
      if (!pendingSyncRef.current) {
        // User used native YouTube play button (non-iOS path)
        onStart(offset);
      }
      pendingSyncRef.current = false;
    }
  }, [onStart, offset]);

  /* iOS: both calls in same user gesture */
  const handleSyncStart = useCallback(() => {
    pendingSyncRef.current = true;
    try {
      playerRef.current?.seekTo(0);
      playerRef.current?.playVideo();
    } catch { /* ignore */ }
    onStart(offset);
  }, [onStart, offset]);

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
            onPointerDown={handlePressStart}
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
            onClick={handleTap}
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
        </div>

        {/* Offset */}
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
            ▶ Start Sync
          </button>
        )}
      </div>
    </div>
  );
}
