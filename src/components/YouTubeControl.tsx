import { useState, useRef, useCallback, useEffect } from 'react';
import YouTube, { type YouTubePlayer } from 'react-youtube';
import { useBpmMeasure } from '../hooks/useBpmMeasure';
import { useVideoTraining } from '../hooks/useVideoTraining';
import type { SlowRate } from '../hooks/useVideoTraining';
import { ModeSwitcher } from './ModeSwitcher';
import { VideoControls } from './VideoControls';
import styles from './YouTubeControl.module.css';

const HISTORY_KEY = 'motionlab:yt-history';
const MAX_HISTORY = 5;

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); }
  catch { return []; }
}

function saveHistory(url: string, prev: string[]): string[] {
  const next = [url, ...prev.filter(u => u !== url)].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

type Props = {
  bpm: number;
  onBpmChange: (bpm: number) => void;
  initialVideoId?: string | null;
  onVideoIdChange?: (id: string | null) => void;
  viewMode: 'audio' | 'video';
  onViewModeChange: (mode: 'audio' | 'video') => void;
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


export function YouTubeControl({
  bpm, onBpmChange,
  initialVideoId, onVideoIdChange,
  viewMode, onViewModeChange,
}: Props) {
  const [urlInput, setUrlInput] = useState(initialVideoId ?? '');
  const [videoId, setVideoId] = useState<string | null>(initialVideoId ?? null);
  const [baseBpm, setBaseBpm] = useState<number | null>(null);
  const [ytVolume, setYtVolume] = useState(80);
  const [ytMuted, setYtMuted] = useState(false);
  const [history, setHistory] = useState<string[]>(() => loadHistory());

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

  const video = useVideoTraining(playerRef, viewMode === 'video');

  // ── BPM sync (audio mode only) ──────────────────────────────────────────
  useEffect(() => {
    if (viewMode === 'video') return; // video mode uses slowRate
    if (!playerReadyRef.current || !baseBpm || !playerRef.current) return;
    const rate = Math.min(2, Math.max(0.25, bpm / baseBpm));
    try { playerRef.current.setPlaybackRate(rate); } catch { /* ignore */ }
  }, [bpm, baseBpm, viewMode]);

  // Apply slow rate when switching to video mode
  useEffect(() => {
    if (viewMode === 'video' && playerReadyRef.current) {
      video.activateSlowRate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // ── YouTube volume / mute ───────────────────────────────────────────────
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

  const handleLoad = useCallback((url?: string) => {
    const target = url ?? urlInput;
    const id = extractVideoId(target);
    if (id) {
      if (!url) setUrlInput(target);
      setVideoId(id);
      onVideoIdChange?.(id);
      setHistory(prev => saveHistory(target.trim(), prev));
    }
  }, [urlInput, onVideoIdChange]);

  const handlePlayerReady = useCallback((e: { target: YouTubePlayer }) => {
    playerRef.current = e.target;
    playerReadyRef.current = true;
    try { e.target.setVolume(ytVolume); } catch { /* ignore */ }
    // Apply mode-appropriate rate
    if (viewMode === 'video') {
      try { e.target.setPlaybackRate(video.slowRate); } catch { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytVolume, viewMode]);

  const { setYtPlaying } = video;
  const handleStateChange = useCallback((e: { data: number }) => {
    // YouTube player states: 1=playing, 2=paused, 0=ended, 3=buffering
    setYtPlaying(e.data === 1 || e.data === 3);
  }, [setYtPlaying]);

  const handleSlowRate = useCallback((rate: SlowRate) => {
    video.setSlowRate(rate);
  }, [video]);

  const playbackRate = baseBpm ? Math.min(2, Math.max(0.25, bpm / baseBpm)) : 1;

  // ── Zoom CSS ──────────────────────────────────────────────────────────
  const { scale, x, y } = video.zoom;
  const transformStyle = viewMode === 'video' && (scale !== 1 || x !== 0 || y !== 0)
    ? { transform: `translate(${x}px, ${y}px) scale(${scale})`, transformOrigin: 'center center' }
    : {};

  return (
    <div className={styles.wrapper}>

      {/* ── Mode switcher ── */}
      <div className={styles.modeRow}>
        <ModeSwitcher mode={viewMode} onChange={onViewModeChange} />
      </div>

      {/* ── BPM 測定（audio mode のみ表示）── */}
      {viewMode === 'audio' && (
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
      )}

      {/* ── YouTube ── */}
      <div className={styles.block}>
        <div className={styles.blockHeader}>
          <span className={styles.blockLabel}>YouTube</span>
          {viewMode === 'video' && video.zoom.scale > 1 && (
            <span className={styles.zoomBadge}>{video.zoom.scale.toFixed(1)}×</span>
          )}
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
          <button className={styles.loadBtn} onClick={() => handleLoad()}>Load</button>
        </div>

        {history.length > 0 && (
          <div className={styles.historyRow}>
            {history.map(url => (
              <button
                key={url}
                className={styles.historyItem}
                onClick={() => { setUrlInput(url); handleLoad(url); }}
                title={url}
              >
                {url.length > 36 ? url.slice(0, 36) + '…' : url}
              </button>
            ))}
          </div>
        )}

        {videoId && (
          <>
            {/* Player */}
            <div className={viewMode === 'video' ? styles.videoPlayerOuter : styles.playerWrapper}>
              {viewMode === 'video' && (
                <div
                  className={styles.zoomOverlay}
                  {...video.overlayHandlers}
                />
              )}
              <div
                className={styles.transformContainer}
                style={transformStyle}
              >
                <YouTube
                  videoId={videoId}
                  opts={{ width: '100%', height: '100%', playerVars: { autoplay: 0 } }}
                  onReady={handlePlayerReady}
                  onStateChange={handleStateChange}
                  className={styles.ytFrame}
                />
              </div>
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

            {/* Video controls (video mode only) */}
            {viewMode === 'video' && (
              <VideoControls
                ytPlaying={video.ytPlaying}
                onTogglePlay={video.togglePlay}
                onStep={video.stepFrame}
                slowRate={video.slowRate}
                onSlowRate={handleSlowRate}
                loopStart={video.loopStart}
                loopEnd={video.loopEnd}
                isLooping={video.isLooping}
                onMarkLoop={video.markLoop}
                onClearLoop={video.clearLoop}
                onToggleLoop={() => video.setIsLooping(v => !v)}
                onPreset={video.applyPreset}
              />
            )}

            {/* Rate indicator (audio mode only, when BPM sync active) */}
            {viewMode === 'audio' && baseBpm !== null && playbackRate !== 1 && (
              <div className={styles.syncNote}>
                <span className={styles.syncNoteText}>再生速度</span>
                <span className={styles.rateTag}>×{playbackRate.toFixed(2)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
