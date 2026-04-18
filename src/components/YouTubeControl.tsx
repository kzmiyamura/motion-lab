import { useState, useRef, useCallback, useEffect, useMemo, type MutableRefObject } from 'react';
import YouTube, { type YouTubePlayer } from 'react-youtube';
import { useBpmMeasure } from '../hooks/useBpmMeasure';
import { useVideoTraining, PSEUDO_SLOW_RATES } from '../hooks/useVideoTraining';
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

const IS_IOS = typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent) && !(navigator as unknown as { MSStream?: unknown }).MSStream;

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
  const [beat1VideoTime, setBeat1VideoTime] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);

  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerReadyRef = useRef(false);
  const playerSectionRef = useRef<HTMLDivElement>(null);
  const seekInputRef = useRef<HTMLInputElement>(null);
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
  // seekPos（時刻テキスト表示用）と seekInputRef.value（スライダー DOM）を両方更新する。
  // スライダーは uncontrolled なので ref で直接書き込み、
  // React の再レンダリングがドラッグ中につまみ位置を上書きするのを防ぐ。
  useEffect(() => {
    const id = setInterval(() => {
      if (!playerReadyRef.current || !playerRef.current || isSeekingRef.current) return;
      try {
        const cur = playerRef.current.getCurrentTime() ?? 0;
        const dur = playerRef.current.getDuration() ?? 0;
        setSeekPos(cur);
        if (seekInputRef.current) seekInputRef.current.value = String(cur);
        if (dur > 0) {
          setDuration(dur);
          if (seekInputRef.current) seekInputRef.current.max = String(dur);
        }
      } catch { /* ignore */ }
    }, 100);
    return () => clearInterval(id);
  }, []);

  // ── Prevent body scroll in theater mode ──────────────────────────────
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

  // ── シーク確定：ネイティブ change イベント ────────────────────────────
  // React の onChange は native "input" イベントにマップされるが、
  // iOS Safari でのタップや素早いスワイプでは "input" が touchend より
  // 後に発火するため onTouchEnd で読む値が古くなる。
  // native "change" イベントはドラッグ終了・タップどちらでも
  // 値確定後に必ず発火するため、これを seekTo の唯一のトリガーにする。
  const showControlsRef = useRef(showControls);
  showControlsRef.current = showControls;
  useEffect(() => {
    const input = seekInputRef.current;
    if (!input) return;
    const handler = () => {
      const val = Number(input.value);
      setSeekPos(val);
      setBeat1VideoTime(null);
      try { playerRef.current?.seekTo(val, true); } catch { /* ignore */ }
      isSeekingRef.current = false;
      showControlsRef.current();
    };
    input.addEventListener('change', handler);
    return () => input.removeEventListener('change', handler);
  // <input> が mount/unmount されるトリガーを deps に含める:
  //   videoId     : 動画ロード時に controls が現れる
  //   playerSize  : theater 切替時に controls が別ラッパーへ移動しリマウントされる
  //   isFullscreen: 全画面切替時も同様
  // その他の参照は安定した ref なので追加不要
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, playerSize, isFullscreen]);

  // ── BPM / Audio ───────────────────────────────────────────────────────
  const handleMeasuredBpm = useCallback((measured: number) => {
    setBaseBpm(measured);
    onBpmChange(measured);
  }, [onBpmChange]);

  const {
    isPressing, elapsedMs,
    firstTapSet,
    handleTap,
  } = useBpmMeasure(handleMeasuredBpm, bpm);

  const video = useVideoTraining(playerRef, viewMode === 'video', overlayTapRef);
  useWakeLock(video.ytPlaying);

  // ── Unified playback rate effect ──────────────────────────────────────
  // Both modes: (bpm/baseBpm) * slowRate, or just slowRate if no baseBpm
  // 250ms デバウンス: スライダーを動かすたびに YouTube API を叩かないようにする
  useEffect(() => {
    if (!playerReadyRef.current || !playerRef.current) return;
    let rate: number;
    if (baseBpm) {
      const bpmRatio = bpm / baseBpm;
      rate = bpmRatio * video.slowRate;
    } else {
      rate = video.slowRate;
    }
    rate = Math.min(2, Math.max(0.25, rate));
    // Pseudo-slow rates are managed by useVideoTraining's play/pause cycling — skip debounce
    if (PSEUDO_SLOW_RATES.has(video.slowRate)) return;
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
    // Pseudo-slow mode manages ytPlaying internally; ignore YouTube state events
    if (video.pseudoPlayingRef.current) return;
    setYtPlaying(e.data === 1 || e.data === 3);
  }, [setYtPlaying, video.pseudoPlayingRef]);

  const handleSlowRate = useCallback((rate: SlowRate) => {
    video.setSlowRate(rate);
  }, [video]);

  const playbackRate = baseBpm ? Math.min(2, Math.max(0.25, bpm / baseBpm)) : 1;

  const ytOpts = useMemo(() => ({
    width: '100%', height: '100%',
    playerVars: {
      autoplay: 0 as const,
      rel: 0 as const,
      // iOS Safari でインライン再生を強制する。
      // これがないと AVPlayer（ネイティブ全画面）で再生され、
      // IFrame API（seekTo / setPlaybackRate 等）が一切届かなくなる。
      playsinline: 1 as const,
    },
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
          ref={seekInputRef}
          type="range"
          min={0}
          max={duration || 1}
          step={0.5}
          defaultValue={0}
          onPointerDown={() => {
            isSeekingRef.current = true;
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          }}
          onChange={(e) => {
            // ドラッグ中の時刻テキスト表示のみ更新。
            // seekTo の呼び出しはネイティブ change イベントリスナーが担当する。
            setSeekPos(Number(e.target.value));
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

        {/* iOSでは画面スリープを完全には防げないため設定変更を促す */}
        {videoId && IS_IOS && video.ytPlaying && (
          <p className={styles.sleepHint}>
            iPhoneで画面が暗くなる場合は「設定 → 画面表示と明るさ → 自動ロック → なし」に変更してください
          </p>
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
              {/* 一時停止中のコマ送りオーバーレイボタン */}
              {viewMode === 'video' && !video.ytPlaying && (
                <>
                  <button
                    className={`${styles.stepOverlayBtn} ${styles.stepOverlayBtnLeft}`}
                    onPointerDown={() => video.startStep(-1)}
                    onPointerUp={video.stopStep}
                    onPointerLeave={video.stopStep}
                    onPointerCancel={video.stopStep}
                    title="コマ戻し（長押し）"
                  >◀</button>
                  <button
                    className={`${styles.stepOverlayBtn} ${styles.stepOverlayBtnRight}`}
                    onPointerDown={() => video.startStep(1)}
                    onPointerUp={video.stopStep}
                    onPointerLeave={video.stopStep}
                    onPointerCancel={video.stopStep}
                    title="コマ送り（長押し）"
                  >▶</button>
                </>
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
      {viewMode === 'audio' && (() => {
        const measBpm = baseBpm ?? 0;
        const beat1Elapsed = beat1VideoTime !== null ? seekPos - beat1VideoTime : -1;
        const secsPerBar = measBpm > 0 ? 8 * 60 / measBpm : 0;
        const nextBeat1 = (beat1VideoTime !== null && secsPerBar > 0)
          ? beat1VideoTime + (Math.floor(Math.max(0, beat1Elapsed / secsPerBar)) + 1) * secsPerBar
          : null;
        const SUB_BEATS = ['1','and','2','and','3','and','4','and','5','and','6','and','7','and','8','and'];
        // activeSub: 0–15, which sub-beat is currently playing. -1 = unknown
        const activeSub = (beat1VideoTime !== null && measBpm > 0)
          ? Math.floor((seekPos - beat1VideoTime) * measBpm / 30) % 16
          : -1;
        const fmtBeatTime = (sec: number) => {
          const m = Math.floor(sec / 60);
          const s = Math.floor(sec % 60);
          const ms = Math.round((sec % 1) * 1000);
          return `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
        };
        const handleBpmTap = () => {
          if (!firstTapSet) setBeat1VideoTime(seekPos);
          handleTap();
        };
        return (
          <div className={styles.block}>
            <div className={styles.blockHeader}>
              <span className={styles.blockLabel}>BPM 測定</span>
            </div>

            {/* SlowRate buttons */}
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

            {/* Beat display 1and2and...8and */}
            <div className={styles.beatDots}>
              {SUB_BEATS.map((label, i) => {
                const isBeat = i % 2 === 0;
                const beatNum = Math.floor(i / 2);
                const isAccent = isBeat && (beatNum === 0 || beatNum === 4);
                const isActive = i === activeSub;
                return (
                  <div key={i} className={[
                    isBeat ? styles.beatDot : styles.beatDotAnd,
                    isActive && isAccent ? styles.beatDotAccent : '',
                    isActive && !isAccent && isBeat ? styles.beatDotCurrent : '',
                    isActive && !isBeat ? styles.beatDotAndActive : '',
                  ].filter(Boolean).join(' ')}>
                    {label}
                  </div>
                );
              })}
            </div>

            {/* Beat 1 timestamps */}
            {beat1VideoTime !== null && measBpm > 0 && (
              <div className={styles.beat1Info}>
                <span>Beat 1: {fmtBeatTime(beat1VideoTime)}</span>
                {nextBeat1 !== null && <span>→ 次: {fmtBeatTime(nextBeat1)}</span>}
              </div>
            )}

            {/* 2-tap button */}
            <button
              className={`${styles.measureBtn} ${(isPressing || firstTapSet) ? styles.measureBtnActive : ''}`}
              onClick={handleBpmTap}
            >
              {!firstTapSet ? '「1」でタップ' : `${(elapsedMs / 1000).toFixed(1)} s — 「次の1」でタップ`}
            </button>

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
                onTouchEnd={(e) => onBpmChange(Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => onBpmChange(Number((e.target as HTMLInputElement).value))}
                className={styles.bpmSlider}
                aria-label="BPM"
              />
              <span className={styles.bpmSliderValue}>{sliderBpm}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
