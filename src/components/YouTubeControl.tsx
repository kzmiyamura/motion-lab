import { useState, useRef, useCallback, useEffect, useMemo, type MutableRefObject } from 'react';
import YouTube, { type YouTubePlayer } from 'react-youtube';
import { useBpmMeasure } from '../hooks/useBpmMeasure';
import { useVideoTraining } from '../hooks/useVideoTraining';
import type { SlowRate } from '../hooks/useVideoTraining';
import { ModeSwitcher } from './ModeSwitcher';
import { VideoControls } from './VideoControls';
import { VideoGrid } from './VideoGrid';
import { SearchPanel } from './SearchPanel';
import { useWakeLock } from '../hooks/useWakeLock';
import styles from './YouTubeControl.module.css';

const HISTORY_KEY = 'motionlab:yt-history';
const MAX_HISTORY = 5;

type HistoryEntry = { url: string; bpm: number | null };

function loadHistory(): HistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    // migrate old format (string[]) to new format
    return (raw as unknown[]).map(item =>
      typeof item === 'string' ? { url: item, bpm: null } : item as HistoryEntry
    );
  } catch { return []; }
}

function saveHistory(url: string, bpm: number | null, prev: HistoryEntry[]): HistoryEntry[] {
  const entry: HistoryEntry = { url, bpm };
  const next = [entry, ...prev.filter(e => e.url !== url)].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

type PlayerSize = 'normal' | 'theater';

type Props = {
  bpm: number;
  onBpmChange: (bpm: number) => void;
  initialVideoId?: string | null;
  initialBpm?: number | null;
  onVideoIdChange?: (id: string | null) => void;
  viewMode: 'audio' | 'video';
  onViewModeChange: (mode: 'audio' | 'video') => void;
};

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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
  initialVideoId, initialBpm, onVideoIdChange,
  viewMode, onViewModeChange,
}: Props) {
  const [urlInput, setUrlInput] = useState(initialVideoId ?? '');
  const [videoId, setVideoId] = useState<string | null>(initialVideoId ?? null);
  // 再起動時: URL から動画ID+BPMが復元されている場合はそれを基準BPMとして初期化
  const [baseBpm, setBaseBpm] = useState<number | null>(
    initialVideoId && initialBpm != null ? initialBpm : null
  );
  // スライダーのローカル表示値（コミットは pointer/key up 時のみ）
  const [sliderBpm, setSliderBpm] = useState(bpm);
  const [ytVolume, setYtVolume] = useState(80);
  const [ytMuted, setYtMuted] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [playerSize, setPlayerSize] = useState<PlayerSize>('normal');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [searchHasResults, setSearchHasResults] = useState(false);
  const [isMirrored, setIsMirrored] = useState(false);

  const [seekPos, setSeekPos] = useState(0);
  const [duration, setDuration] = useState(0);

  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerReadyRef = useRef(false);
  const playerSectionRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setRateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayTapRef = useRef<(() => void) | undefined>(undefined) as MutableRefObject<(() => void) | undefined>;
  const isSeekingRef = useRef(false);

  // ── Fullscreen detection ──────────────────────────────────────────────
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  // ── Reset player refs when videoId is cleared (back button) ─────────
  useEffect(() => {
    if (!videoId) {
      playerRef.current = null;
      playerReadyRef.current = false;
      setSeekPos(0);
      setDuration(0);
      video.setYtPlaying(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // ── Seek position polling (500ms) ────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (!playerReadyRef.current || !playerRef.current || isSeekingRef.current) return;
      try {
        const cur = playerRef.current.getCurrentTime() ?? 0;
        const dur = playerRef.current.getDuration() ?? 0;
        setSeekPos(cur);
        if (dur > 0) setDuration(dur);
      } catch { /* ignore */ }
    }, 500);
    return () => clearInterval(id);
  }, []);

  // ── Prevent body scroll in theater mode ───────────────────────────────
  useEffect(() => {
    document.body.style.overflow = playerSize === 'theater' ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [playerSize]);

  const enterFullscreen = useCallback(async () => {
    try {
      const el = playerSectionRef.current as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
      };
      await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
    } catch { /* ignore */ }
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      const doc = document as Document & { webkitExitFullscreen?: () => void };
      await (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    } catch { /* ignore */ }
  }, []);

  // ── Controls show/hide (expanded mode) ───────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  const resetHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  // ── BPM / Audio ───────────────────────────────────────────────────────
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

  const video = useVideoTraining(playerRef, viewMode === 'video', overlayTapRef);
  useWakeLock(video.ytPlaying);

  // ── Unified playback rate effect ──────────────────────────────────────
  // audio mode: bpm/baseBpm ratio  (slowRate ignored)
  // video mode: (bpm/baseBpm) * slowRate, or just slowRate if no baseBpm
  // 250ms デバウンス: スライダーを動かすたびに YouTube API を叩かないようにする
  useEffect(() => {
    if (!playerReadyRef.current || !playerRef.current) return;
    let rate: number;
    if (baseBpm) {
      const bpmRatio = bpm / baseBpm;
      rate = viewMode === 'video' ? bpmRatio * video.slowRate : bpmRatio;
    } else {
      rate = viewMode === 'video' ? video.slowRate : 1;
    }
    rate = Math.min(2, Math.max(0.25, rate));
    if (setRateTimerRef.current) clearTimeout(setRateTimerRef.current);
    const rateToSet = rate;
    setRateTimerRef.current = setTimeout(() => {
      try { playerRef.current?.setPlaybackRate(rateToSet); } catch { /* ignore */ }
    }, 250);
  }, [bpm, baseBpm, viewMode, video.slowRate]);

  useEffect(() => {
    if (!playerReadyRef.current || !playerRef.current) return;
    try {
      if (ytMuted) { playerRef.current.mute(); }
      else { playerRef.current.unMute(); playerRef.current.setVolume(ytVolume); }
    } catch { /* ignore */ }
  }, [ytVolume, ytMuted]);

  // sliderBpm を外部 bpm（BPM計測や履歴ロード）に追従させる
  useEffect(() => { setSliderBpm(bpm); }, [bpm]);

  const handleLoad = useCallback((url?: string, restoreBpm?: number | null) => {
    const target = url ?? urlInput;
    const id = extractVideoId(target);
    if (id) {
      if (!url) setUrlInput(target);
      setVideoId(id);
      onVideoIdChange?.(id);
      if (restoreBpm != null) {
        // baseBpm はローカルの再生速度基準としてのみ使用。
        // BPM測定なしに動画を選択しただけではグローバルBPM（Rhythm タブ）を変更しない。
        setBaseBpm(restoreBpm);
      }
      const bpmToSave = restoreBpm !== undefined ? restoreBpm : baseBpm;
      setHistory(prev => saveHistory(target.trim(), bpmToSave ?? null, prev));
    }
  }, [urlInput, onVideoIdChange, baseBpm, onBpmChange]);

  const handlePlayerReady = useCallback((e: { target: YouTubePlayer }) => {
    playerRef.current = e.target;
    playerReadyRef.current = true;
    try { e.target.setVolume(ytVolume); } catch { /* ignore */ }
    if (viewMode === 'video') {
      try { e.target.setPlaybackRate(video.slowRate); } catch { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytVolume, viewMode]);

  const { setYtPlaying } = video;
  const handleStateChange = useCallback((e: { data: number }) => {
    // state 0 = ended → seek to beginning to dismiss the related-videos end screen
    if (e.data === 0) {
      try { playerRef.current?.seekTo(0, true); } catch { /* ignore */ }
    }
    setYtPlaying(e.data === 1 || e.data === 3);
  }, [setYtPlaying]);

  const handleSlowRate = useCallback((rate: SlowRate) => {
    video.setSlowRate(rate);
  }, [video]);

  const playbackRate = baseBpm ? Math.min(2, Math.max(0.25, bpm / baseBpm)) : 1;

  const ytOpts = useMemo(() => ({
    width: '100%', height: '100%',
    playerVars: { autoplay: 0 as const, rel: 0 as const },
  }), []);

  const { scale, x, y } = video.zoom;
  const transformStyle = (viewMode === 'video' && (scale !== 1 || x !== 0 || y !== 0)) || isMirrored
    ? {
        transform: `translate(${x}px, ${y}px) scale(${scale})${isMirrored ? ' scaleX(-1)' : ''}`,
        transformOrigin: 'center center',
      }
    : {};

  // ── Derived layout flags ──────────────────────────────────────────────
  const isExpanded = playerSize === 'theater' || isFullscreen;

  // Auto-show controls when entering expanded mode; hide on exit
  useEffect(() => {
    if (isExpanded) {
      showControls();
    } else {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setControlsVisible(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  // Keep overlayTapRef current so useVideoTraining always calls latest handler
  overlayTapRef.current = isExpanded
    ? () => {
        if (controlsVisible) {
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          setControlsVisible(false);
        } else {
          showControls();
        }
      }
    : () => {
        video.togglePlay();
      };

  const videoAreaClass = isExpanded
    ? styles.theaterVideoArea
    : viewMode === 'video'
      ? styles.videoPlayerOuter
      : styles.playerWrapper;

  // Controls rendered in both normal and theater/fullscreen
  const controls = (
    <>
      <div className={styles.seekRow}>
        <span className={styles.seekTime}>{formatTime(seekPos)}</span>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.5}
          value={seekPos}
          onPointerDown={() => {
            isSeekingRef.current = true;
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          }}
          onChange={(e) => setSeekPos(Number(e.target.value))}
          onPointerUp={(e) => {
            const val = Number((e.target as HTMLInputElement).value);
            setSeekPos(val);
            try { playerRef.current?.seekTo(val, true); } catch { /* ignore */ }
            isSeekingRef.current = false;
            showControls();
          }}
          className={styles.seekSlider}
          aria-label="シーク"
          disabled={duration === 0}
        />
        <span className={styles.seekTime}>{formatTime(duration)}</span>
      </div>

      <div className={styles.volRow}>
        <button
          className={`${styles.muteBtn} ${ytMuted ? styles.muteBtnMuted : ''}`}
          onClick={() => setYtMuted(m => !m)}
          title={ytMuted ? 'ミュート解除' : 'ミュート'}
        >
          {ytMuted ? '🔇' : '🔊'}
        </button>
        <input
          type="range" min={0} max={100} step={1}
          value={ytVolume}
          onChange={(e) => setYtVolume(Number(e.target.value))}
          className={styles.volSlider}
          disabled={ytMuted}
          aria-label="YouTube 音量"
        />
        <span className={styles.volValue}>{ytMuted ? '–' : `${ytVolume}%`}</span>
      </div>

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
          isMirrored={isMirrored}
          onMirrorToggle={() => setIsMirrored(v => !v)}
        />
      )}

      {baseBpm !== null && (() => {
        const effectiveRate = viewMode === 'video'
          ? Math.min(2, Math.max(0.25, playbackRate * video.slowRate))
          : playbackRate;
        return effectiveRate !== 1 ? (
          <div className={styles.syncNote}>
            <span className={styles.syncNoteText}>再生速度</span>
            <span className={styles.rateTag}>×{effectiveRate.toFixed(2)}</span>
          </div>
        ) : null;
      })()}
    </>
  );

  return (
    <div className={styles.wrapper}>

      {/* ── Mode switcher ── */}
      <div className={styles.modeRow}>
        <ModeSwitcher mode={viewMode} onChange={onViewModeChange} />
      </div>

      {/* ── YouTube ── */}
      <div className={styles.block}>
        <div className={styles.blockHeader}>
          <span className={styles.blockLabel}>YouTube</span>
          {viewMode === 'video' && video.zoom.scale > 1 && (
            <span className={styles.zoomBadge}>{video.zoom.scale.toFixed(1)}×</span>
          )}
          {videoId && (
            <div className={styles.sizeButtons}>
              {/* 動画選択グリッドに戻る */}
              <button
                className={styles.sizeBtn}
                onClick={() => { setVideoId(null); setUrlInput(''); setSearchHasResults(false); onVideoIdChange?.(null); }}
                title="別の動画を選択"
              >⌂</button>
              <button
                className={`${styles.sizeBtn} ${playerSize === 'theater' ? styles.sizeBtnActive : ''}`}
                onClick={() => setPlayerSize(s => s === 'theater' ? 'normal' : 'theater')}
                title="ブラウザ最大化"
              >⊞</button>
              <button
                className={styles.sizeBtn}
                onClick={isFullscreen ? exitFullscreen : enterFullscreen}
                title={isFullscreen ? '全画面解除' : '全画面'}
              >{isFullscreen ? '⊠' : '⛶'}</button>
            </div>
          )}
        </div>

        {/* URL入力（動画再生中は折りたたんで非表示） */}
        {!videoId && (
          <div className={styles.urlRow}>
            <input
              className={styles.urlInput}
              type="text"
              placeholder="URL または Video ID を入力"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLoad()}
            />
            <button className={styles.loadBtn} onClick={() => handleLoad()}>Load</button>
          </div>
        )}

        {/* 動画未選択時: 検索 + レコメンドグリッド */}
        {!videoId && (
          <>
            <SearchPanel
              onSelect={(id, bpm) => {
                setUrlInput(id);
                handleLoad(id, bpm);
              }}
              onSearchStateChange={setSearchHasResults}
            />
            {/* 検索結果表示中は VideoGrid を非表示 */}
            {!searchHasResults && (
              <VideoGrid
                history={history}
                onSelect={(id, bpm) => {
                  setUrlInput(id);
                  handleLoad(id, bpm);
                }}
              />
            )}
          </>
        )}

        {videoId && (
          /* playerSectionRef: CSS class changes with playerSize.
             <YouTube> stays mounted here — never re-created. */
          <div
            ref={playerSectionRef}
            className={playerSize === 'theater' ? styles.sectionTheater : styles.sectionNormal}
          >
            {/* Theater / fullscreen top bar */}
            {isExpanded && (
              <div className={[styles.theaterBar, !controlsVisible ? styles.theaterBarHidden : ''].filter(Boolean).join(' ')}>
                <span className={styles.theaterBarTitle}>YouTube</span>
                <div className={styles.theaterBarBtns}>
                  <button
                    className={styles.theaterBarBtn}
                    onClick={isFullscreen ? exitFullscreen : enterFullscreen}
                    title={isFullscreen ? '全画面解除' : '全画面'}
                  >{isFullscreen ? '⊠' : '⛶'}</button>
                  {playerSize === 'theater' && !isFullscreen && (
                    <button
                      className={styles.theaterBarBtn}
                      onClick={() => setPlayerSize('normal')}
                      title="閉じる"
                    >✕</button>
                  )}
                </div>
              </div>
            )}

            {/* Video player */}
            <div className={videoAreaClass}>
              {viewMode === 'video' && (
                <div className={styles.zoomOverlay} {...video.overlayHandlers} />
              )}
              <div className={styles.transformContainer} style={transformStyle}>
                <YouTube
                  videoId={videoId}
                  opts={ytOpts}
                  onReady={handlePlayerReady}
                  onStateChange={handleStateChange}
                  className={styles.ytFrame}
                />
              </div>
            </div>

            {/* Controls */}
            {isExpanded
              ? (
                <div
                  className={[
                    styles.theaterControls,
                    !controlsVisible ? styles.theaterControlsHidden : '',
                  ].filter(Boolean).join(' ')}
                  onPointerDown={resetHideTimer}
                >
                  {controls}
                </div>
              )
              : controls
            }
          </div>
        )}
      </div>

      {/* ── BPM 測定（audio mode のみ）── */}
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
              {!firstTapSet ? '「1」でタップ' : `${(elapsedMs / 1000).toFixed(1)} s — 「次の1」でタップ`}
            </button>
          )}

          {baseBpm !== null && (
            <div className={styles.bpmResult}>
              <button
                className={styles.bpmAdjBtn}
                onClick={() => { const n = Math.max(1, (baseBpm ?? 1) - 1); setBaseBpm(n); onBpmChange(n); }}
                aria-label="BPM基準 −1"
              >−</button>
              <span className={styles.bpmResultValue}>{baseBpm}</span>
              <button
                className={styles.bpmAdjBtn}
                onClick={() => { const n = (baseBpm ?? 1) + 1; setBaseBpm(n); onBpmChange(n); }}
                aria-label="BPM基準 +1"
              >＋</button>
              <span className={styles.bpmResultUnit}>BPM 基準</span>
              {bpm !== baseBpm && (
                <span className={styles.rateTag}>×{playbackRate.toFixed(2)}</span>
              )}
            </div>
          )}

          {/* ── BPM スライダー ── */}
          {/* onChange はローカル表示のみ。onPointerUp/onKeyUp で確定 → setPlaybackRate は1回だけ */}
          <div className={styles.bpmSliderRow}>
            <label className={styles.bpmSliderLabel} htmlFor="yt-bpm-slider">BPM</label>
            <input
              id="yt-bpm-slider"
              type="range"
              min={80}
              max={220}
              step={1}
              value={sliderBpm}
              onChange={(e) => setSliderBpm(Number(e.target.value))}
              onPointerUp={(e) => onBpmChange(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => onBpmChange(Number((e.target as HTMLInputElement).value))}
              className={styles.bpmSlider}
              aria-label="BPM"
            />
            <span className={styles.bpmSliderValue}>{sliderBpm}</span>
          </div>
        </div>
      )}
    </div>
  );
}
