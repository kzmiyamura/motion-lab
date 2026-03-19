import { useState, useRef, useCallback, useEffect } from 'react';
import { requestDriveToken, revokeDriveToken } from '../engine/googleAuth';
import { listMediaFiles, fetchFileBlob, findOrCreateFolder, uploadFileResumable, createPublicPermission, type DriveFile } from '../engine/googleDrive';
import { saveFile, listFiles, deleteFile, type StoredFile } from '../engine/localFileStore';
import { SLOW_RATES, ZOOM_PRESETS, type SlowRate, type ZoomState } from '../hooks/useVideoTraining';
import { useWakeLock } from '../hooks/useWakeLock';
import styles from './FilePlayer.module.css';

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '') as string;

type FileSource = { name: string; url: string; isVideo: boolean };
type PlayerSize = 'normal' | 'theater';

type Props = { bpm: number; onBpmChange: (bpm: number) => void };

function formatTime(s: number): string {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

function formatSize(bytes: string | undefined): string {
  if (!bytes) return '';
  return `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;
}

export function FilePlayer({ bpm, onBpmChange }: Props) {
  const [subTab, setSubTab] = useState<'local' | 'drive'>('local');
  const [source, setSource] = useState<FileSource | null>(null);
  const [baseBpm, setBaseBpm] = useState<number | null>(null);
  const [sliderBpm, setSliderBpm] = useState(bpm);

  // Player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Training controls
  const [slowRate, setSlowRateState] = useState<SlowRate>(1.0);
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [isLooping, setIsLooping] = useState(false);
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, x: 0, y: 0 });

  // Layout state
  const [playerSize, setPlayerSize] = useState<PlayerSize>('normal');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [isMirrored, setIsMirrored] = useState(false);

  // Local stored files
  const [storedFiles, setStoredFiles] = useState<StoredFile[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Drive state
  const [token, setToken] = useState<string | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [driveQuery, setDriveQuery] = useState('');
  const [driveError, setDriveError] = useState('');

  // Upload state
  type UploadStatus = 'idle' | 'authing' | 'folder' | 'uploading' | 'done' | 'error';
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [uploadedFileId, setUploadedFileId] = useState<string | null>(null);

  // Share state
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareToast, setShareToast] = useState('');

  const mediaRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevBlobUrl = useRef<string | null>(null);
  /** アップロード用に元の File オブジェクトを保持（Drive ファイルは null） */
  const sourceFileRef = useRef<File | null>(null);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playerSectionRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Zoom gesture refs
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastDistRef = useRef<number | null>(null);

  // Derived
  const isTheater = playerSize === 'theater';
  const isExpanded = isTheater || isFullscreen;

  // ── Fullscreen detection ───────────────────────────────────────────────
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  // Prevent body scroll in theater mode
  useEffect(() => {
    document.body.style.overflow = playerSize === 'theater' ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [playerSize]);

  useWakeLock(isPlaying);

  // Sync BPM slider from external changes
  useEffect(() => { setSliderBpm(bpm); }, [bpm]);

  // Load IndexedDB file list on mount
  useEffect(() => {
    listFiles().then(setStoredFiles).catch(() => {});
  }, []);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => { if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current); };
  }, []);

  // ── Fullscreen helpers ─────────────────────────────────────────────────
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

  // ── Controls show/hide (expanded mode) ────────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  const resetHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  useEffect(() => {
    if (isExpanded) {
      showControls();
    } else {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setControlsVisible(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  // ── File opening ───────────────────────────────────────────────────────
  const openFileSource = useCallback((
    name: string, url: string, mimeType: string,
  ) => {
    if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current);
    prevBlobUrl.current = url;
    setSource({ name, url, isVideo: mimeType.startsWith('video/') });
    setBaseBpm(bpm);
    setSliderBpm(bpm);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSlowRateState(1.0);
    setLoopStart(null);
    setLoopEnd(null);
    setIsLooping(false);
    setZoom({ scale: 1, x: 0, y: 0 });
  }, [bpm]);

  const handleFileSelect = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    sourceFileRef.current = file;
    setUploadStatus('idle');
    openFileSource(file.name, url, file.type);
    setIsSaving(true);
    saveFile(file.name, file, file.type)
      .then(() => listFiles())
      .then(setStoredFiles)
      .catch(() => {})
      .finally(() => setIsSaving(false));
  }, [openFileSource]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.type.startsWith('audio/') || file.type.startsWith('video/'))) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);

  const handleStoredFileOpen = (sf: StoredFile) => {
    const url = URL.createObjectURL(sf.blob);
    sourceFileRef.current = new File([sf.blob], sf.name, { type: sf.mimeType });
    setUploadStatus('idle');
    openFileSource(sf.name, url, sf.mimeType);
  };

  const handleStoredFileDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteFile(id).catch(() => {});
    setStoredFiles(await listFiles().catch(() => []));
  };

  // ── Google Drive ───────────────────────────────────────────────────────
  const loadDriveFiles = useCallback(async (t: string, q: string) => {
    setIsLoadingFiles(true);
    setDriveError('');
    try {
      setDriveFiles(await listMediaFiles(t, q));
    } catch {
      setDriveError('ファイル一覧の取得に失敗しました。');
    } finally {
      setIsLoadingFiles(false);
    }
  }, []);

  const handleDriveAuth = async () => {
    if (!CLIENT_ID) {
      setDriveError('VITE_GOOGLE_CLIENT_ID が設定されていません。');
      return;
    }
    setIsLoadingAuth(true);
    setDriveError('');
    try {
      const t = await requestDriveToken(CLIENT_ID);
      setToken(t);
      await loadDriveFiles(t, '');
    } catch {
      setDriveError('認証に失敗しました。ポップアップがブロックされていないか確認してください。');
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const handleDriveSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (token) loadDriveFiles(token, driveQuery);
  };

  const handleDriveFileSelect = async (file: DriveFile) => {
    if (!token) return;
    setIsLoadingFile(true);
    setDownloadProgress(0);
    setDriveError('');
    try {
      const blob = await fetchFileBlob(token, file.id, pct => setDownloadProgress(pct));
      const url = URL.createObjectURL(blob);
      sourceFileRef.current = null; // Drive ファイルはバックアップ不要
      setUploadStatus('idle');
      openFileSource(file.name, url, file.mimeType);
    } catch {
      setDriveError('ファイルの読み込みに失敗しました。');
    } finally {
      setIsLoadingFile(false);
      setDownloadProgress(null);
    }
  };

  const handleSignOut = () => {
    if (token) revokeDriveToken(token);
    setToken(null);
    setDriveFiles([]);
    setDriveError('');
  };

  // ── Player controls ────────────────────────────────────────────────────
  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = mediaRef.current;
    if (!el || !isFinite(el.duration)) return;
    el.currentTime = Number(e.target.value);
  };

  const handleTimeUpdate = () => {
    const el = mediaRef.current;
    if (!el) return;
    const t = el.currentTime;
    setCurrentTime(t);
    if (isLooping && loopStart !== null && loopEnd !== null && t >= loopEnd) {
      el.currentTime = loopStart;
    }
  };

  const applySlowRate = (rate: SlowRate) => {
    setSlowRateState(rate);
    if (mediaRef.current) mediaRef.current.playbackRate = rate;
  };

  const commitBpm = (val: number) => {
    onBpmChange(val);
    if (!baseBpm) setBaseBpm(val);
    const base = baseBpm ?? val;
    if (mediaRef.current) {
      mediaRef.current.playbackRate = Math.max(0.25, Math.min(2, slowRate * (val / base)));
    }
  };

  const stepFrame = (dir: 1 | -1) => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, el.currentTime + dir * 0.033);
  };

  const startStep = (dir: 1 | -1) => {
    stepFrame(dir);
    stepIntervalRef.current = setInterval(() => stepFrame(dir), 120);
  };

  const stopStep = () => {
    if (stepIntervalRef.current) { clearInterval(stepIntervalRef.current); stepIntervalRef.current = null; }
  };

  const markLoop = (point: 'start' | 'end') => {
    const t = mediaRef.current?.currentTime;
    if (t === undefined) return;
    if (point === 'start') setLoopStart(t);
    else setLoopEnd(t);
  };

  const clearLoop = () => { setLoopStart(null); setLoopEnd(null); setIsLooping(false); };

  const applyPreset = (id: string) => {
    const p = ZOOM_PRESETS.find(pr => pr.id === id);
    if (p) setZoom({ scale: p.scale, x: p.x, y: p.y });
  };

  // Overlay click: toggle controls in expanded mode, play/pause in normal
  const handleOverlayClick = () => {
    if (isExpanded) {
      if (controlsVisible) {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        setControlsVisible(false);
      } else {
        showControls();
      }
    } else {
      togglePlay();
    }
  };

  // Pinch-to-zoom & drag overlay handlers
  const onOverlayPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      lastDistRef.current = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    }
  };

  const onOverlayPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    e.preventDefault();
    const prev = pointersRef.current.get(e.pointerId)!;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (lastDistRef.current !== null && lastDistRef.current > 0) {
        const ratio = dist / lastDistRef.current;
        setZoom(z => ({ ...z, scale: Math.min(3, Math.max(1, z.scale * ratio)) }));
      }
      lastDistRef.current = dist;
    } else {
      setZoom(z => ({ ...z, x: z.x + dx, y: z.y + dy }));
    }
  };

  const onOverlayPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) lastDistRef.current = null;
  };

  const goHome = () => {
    mediaRef.current?.pause();
    if (playerSize === 'theater') setPlayerSize('normal');
    if (isFullscreen) exitFullscreen();
    setSource(null);
    setBaseBpm(null);
    sourceFileRef.current = null;
    setUploadStatus('idle');
    setUploadedFileId(null);
  };

  // ── Toast ─────────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    setShareToast(msg);
    setTimeout(() => setShareToast(''), 3500);
  }, []);

  // ── Drive 共有 ────────────────────────────────────────────────────────
  const APP_URL = 'https://motion-lab-apa.pages.dev';

  const handleShare = useCallback(async (fileId: string) => {
    if (!token) return;
    setSharingId(fileId);
    try {
      await createPublicPermission(token, fileId);
      const shareUrl = `${APP_URL}/?fileId=${fileId}`;
      if (navigator.share) {
        await navigator.share({
          title: 'Motion Lab でサルサの練習動画を共有しました',
          text: 'このリンクから動画をスロー再生やループ再生で確認できます。',
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        showToast('URLをクリップボードにコピーしました');
      }
    } catch (e) {
      // AbortError はユーザーキャンセルなので無視
      if (e instanceof Error && e.name !== 'AbortError') {
        showToast('共有に失敗しました');
      }
    } finally {
      setSharingId(null);
    }
  }, [token, showToast]);

  // ── Google Drive バックアップ ───────────────────────────────────────────
  const BACKUP_FOLDER = 'MotionLab_Videos';

  const handleUpload = async () => {
    const file = sourceFileRef.current;
    if (!file) return;

    setUploadError('');
    setUploadProgress(0);

    // 未認証なら認証を挟む
    let uploadToken = token;
    if (!uploadToken) {
      if (!CLIENT_ID) {
        setUploadError('VITE_GOOGLE_CLIENT_ID が設定されていません。');
        setUploadStatus('error');
        return;
      }
      setUploadStatus('authing');
      try {
        const { requestDriveToken } = await import('../engine/googleAuth');
        uploadToken = await requestDriveToken(CLIENT_ID);
        setToken(uploadToken);
      } catch {
        setUploadError('Google 認証に失敗しました。ポップアップがブロックされていないか確認してください。');
        setUploadStatus('error');
        return;
      }
    }

    // フォルダ取得 or 作成
    setUploadStatus('folder');
    let folderId: string;
    try {
      folderId = await findOrCreateFolder(uploadToken, BACKUP_FOLDER);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'フォルダの作成に失敗しました。');
      setUploadStatus('error');
      return;
    }

    // アップロード
    setUploadStatus('uploading');
    try {
      const fileId = await uploadFileResumable(uploadToken, folderId, file, pct => setUploadProgress(pct));
      setUploadedFileId(fileId || null);
      setUploadStatus('done');
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'アップロードに失敗しました。');
      setUploadStatus('error');
    }
  };

  // ── Player controls content (shared between normal and theater layout) ──
  const playerControlsContent = source ? (
    <>
      {/* Seek bar */}
      <div className={styles.seekRow}>
        <span className={styles.timeLabel}>{formatTime(currentTime)}</span>
        <input
          type="range" min={0} max={isFinite(duration) ? duration : 100} step={0.1}
          value={currentTime} onChange={handleSeek} className={styles.seekBar}
        />
        <span className={styles.timeLabel}>{formatTime(duration)}</span>
      </div>

      {/* Row 1: Play / Step / Rate buttons */}
      <div className={styles.ctrlRow}>
        <button
          className={`${styles.playBtn} ${isPlaying ? styles.playBtnPlaying : ''}`}
          onClick={togglePlay}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button
          className={styles.stepBtn}
          onPointerDown={() => startStep(-1)} onPointerUp={stopStep}
          onPointerLeave={stopStep} onPointerCancel={stopStep}
          title="コマ戻し（長押し）"
        >⏮</button>
        <button
          className={styles.stepBtn}
          onPointerDown={() => startStep(1)} onPointerUp={stopStep}
          onPointerLeave={stopStep} onPointerCancel={stopStep}
          title="コマ送り（長押し）"
        >⏭</button>
        {source.isVideo && (
          <button
            className={`${styles.mirrorBtn} ${isMirrored ? styles.mirrorBtnActive : ''}`}
            onClick={() => setIsMirrored(v => !v)}
            title={isMirrored ? 'ミラー解除' : 'ミラー反転'}
            aria-label="ミラー反転"
          >↔</button>
        )}
        <div className={styles.rateGroup}>
          {SLOW_RATES.map(r => (
            <button
              key={r}
              className={`${styles.rateBtn} ${slowRate === r ? styles.rateBtnActive : ''}`}
              onClick={() => applySlowRate(r)}
            >
              {r === 1.0 ? '1×' : `${r}×`}
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: A-B Loop */}
      <div className={styles.ctrlRow}>
        <span className={styles.ctrlLabel}>Loop</span>
        <button className={styles.loopBtn} onClick={() => markLoop('start')}>
          {loopStart !== null ? `A: ${formatTime(loopStart)}` : 'A 点'}
        </button>
        <button className={styles.loopBtn} onClick={() => markLoop('end')}>
          {loopEnd !== null ? `B: ${formatTime(loopEnd)}` : 'B 点'}
        </button>
        {(loopStart !== null || loopEnd !== null) && (
          <button className={styles.loopClear} onClick={clearLoop}>✕</button>
        )}
        <button
          className={`${styles.loopToggle} ${isLooping ? styles.loopToggleOn : ''}`}
          onClick={() => setIsLooping(v => !v)}
          disabled={loopStart === null || loopEnd === null}
        >
          {isLooping ? '⟳ ON' : '⟳ OFF'}
        </button>
      </div>

      {/* Row 3: Zoom presets (video only) */}
      {source.isVideo && (
        <div className={styles.ctrlRow}>
          <span className={styles.ctrlLabel}>Zoom</span>
          {ZOOM_PRESETS.map(p => (
            <button key={p.id} className={styles.presetBtn} onClick={() => applyPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* BPM slider */}
      <div className={styles.bpmRow}>
        <span className={styles.bpmLabel}>
          BPM
          <span className={styles.rateHint}> ×{(slowRate * (baseBpm ? sliderBpm / baseBpm : 1)).toFixed(2)}</span>
        </span>
        <input
          type="range" min={60} max={220} step={1} value={sliderBpm}
          onChange={e => setSliderBpm(Number(e.target.value))}
          onPointerUp={e => commitBpm(Number((e.target as HTMLInputElement).value))}
          onKeyUp={e => commitBpm(Number((e.target as HTMLInputElement).value))}
          className={styles.bpmSlider}
        />
        <span className={styles.bpmValue}>{sliderBpm}</span>
      </div>

      {/* Google Drive バックアップ（ローカルファイルのみ） */}
      {sourceFileRef.current && (
        <div className={styles.uploadSection}>
          {uploadStatus === 'idle' || uploadStatus === 'error' ? (
            <>
              <button
                className={styles.uploadBtn}
                onClick={handleUpload}
              >
                ☁ Google Drive にバックアップ
              </button>
              {uploadStatus === 'error' && (
                <p className={styles.uploadError}>{uploadError}</p>
              )}
            </>
          ) : uploadStatus === 'done' ? (
            <div className={styles.uploadDoneWrap}>
              <p className={styles.uploadSuccess}>
                ✅ Google ドライブに保存しました。端末の空き容量を増やすために、写真アプリから元の動画を削除しても大丈夫です。
              </p>
              {uploadedFileId && (
                <button
                  className={styles.shareBtn}
                  onClick={() => handleShare(uploadedFileId)}
                  disabled={sharingId === uploadedFileId}
                  aria-label="共有"
                >
                  {sharingId === uploadedFileId ? '…' : '⬆ 共有する'}
                </button>
              )}
            </div>
          ) : (
            <div className={styles.uploadProgressWrap}>
              <div className={styles.uploadProgressBar}>
                <div
                  className={styles.uploadProgressFill}
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <span className={styles.uploadProgressLabel}>
                {uploadStatus === 'authing' && '認証中…'}
                {uploadStatus === 'folder' && 'フォルダ確認中…'}
                {uploadStatus === 'uploading' && `アップロード中… ${uploadProgress}%`}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className={styles.wrapper}>

      {/* クリップボードコピー時のトースト（PC フォールバック） */}
      {shareToast && (
        <div className={styles.toast}>{shareToast}</div>
      )}

      {/* ── Player section (video + controls) ── */}
      {source && (
        <div
          ref={playerSectionRef}
          className={playerSize === 'theater' ? styles.sectionTheater : styles.sectionNormal}
        >
          {/* Theater / fullscreen top bar */}
          {isExpanded && (
            <div className={styles.theaterBar}>
              <span className={styles.theaterBarTitle}>{source.name}</span>
              <div className={styles.theaterBarBtns}>
                <button
                  className={styles.theaterBarBtn}
                  onClick={isFullscreen ? exitFullscreen : enterFullscreen}
                  title={isFullscreen ? '全画面解除' : '全画面'}
                >{isFullscreen ? '⊠' : '⛶'}</button>
                {isTheater && !isFullscreen && (
                  <button
                    className={styles.theaterBarBtn}
                    onClick={() => setPlayerSize('normal')}
                    title="閉じる"
                  >✕</button>
                )}
              </div>
            </div>
          )}

          {/* Video element */}
          <div className={
            source.isVideo
              ? (isExpanded ? styles.theaterVideoArea : styles.videoContainer)
              : styles.audioOnlyWrap
          }>
            <video
              ref={mediaRef}
              src={source.url}
              className={styles.videoEl}
              style={{
                transform: source.isVideo
                  ? `${isMirrored ? 'scaleX(-1) ' : ''}scale(${zoom.scale}) translate(${zoom.x / zoom.scale}px, ${zoom.y / zoom.scale}px)`
                  : undefined,
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={() => {
                setDuration(mediaRef.current?.duration ?? 0);
                if (mediaRef.current) mediaRef.current.playbackRate = slowRate;
              }}
              onEnded={() => setIsPlaying(false)}
              playsInline
              controls={false}
            />
            {source.isVideo && (
              <div
                className={styles.videoOverlay}
                onPointerDown={onOverlayPointerDown}
                onPointerMove={onOverlayPointerMove}
                onPointerUp={onOverlayPointerUp}
                onPointerCancel={onOverlayPointerUp}
                onClick={handleOverlayClick}
              />
            )}
          </div>

          {/* Controls — theater overlay or normal card */}
          {isExpanded ? (
            <div
              className={[
                styles.theaterControls,
                !controlsVisible ? styles.theaterControlsHidden : '',
              ].filter(Boolean).join(' ')}
              onPointerDown={resetHideTimer}
            >
              {playerControlsContent}
            </div>
          ) : (
            <div className={styles.playerWrap}>
              {/* Header */}
              <div className={styles.playerHeader}>
                <button className={styles.homeBtn} onClick={goHome} title="ファイル選択に戻る">⌂</button>
                <p className={styles.fileName} title={source.name}>{source.name}</p>
                <div className={styles.sizeButtons}>
                  <button
                    className={`${styles.sizeBtn} ${isTheater ? styles.sizeBtnActive : ''}`}
                    onClick={() => setPlayerSize(s => s === 'theater' ? 'normal' : 'theater')}
                    title="ブラウザ最大化"
                  >⊞</button>
                  <button
                    className={styles.sizeBtn}
                    onClick={isFullscreen ? exitFullscreen : enterFullscreen}
                    title={isFullscreen ? '全画面解除' : '全画面'}
                  >{isFullscreen ? '⊠' : '⛶'}</button>
                </div>
              </div>
              {playerControlsContent}
            </div>
          )}
        </div>
      )}

      {/* ── File selection UI ── */}
      {!source && (
        <div className={styles.selectWrap}>
          <div className={styles.subTabs}>
            <button
              className={`${styles.subTab} ${subTab === 'local' ? styles.subTabActive : ''}`}
              onClick={() => setSubTab('local')}
            >📂 ローカル</button>
            <button
              className={`${styles.subTab} ${subTab === 'drive' ? styles.subTabActive : ''}`}
              onClick={() => setSubTab('drive')}
            >☁ Google Drive</button>
          </div>

          {subTab === 'local' ? (
            <div className={styles.localWrap}>
              <div
                className={styles.dropZone}
                onDrop={handleDrop} onDragOver={e => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              >
                <input
                  ref={fileInputRef} type="file" accept="video/*,audio/*"
                  className={styles.fileInputHidden}
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) handleFileSelect(f);
                    e.target.value = '';
                  }}
                />
                <p className={styles.dropIcon}>🎵</p>
                <p className={styles.dropText}>クリックまたはドラッグ&ドロップ</p>
                <p className={styles.dropHint}>MP3・MP4・WAV・M4A・OGG / カメラで録画も可</p>
                {isSaving && <p className={styles.savingMsg}>保存中…</p>}
              </div>

              {storedFiles.length > 0 && (
                <div className={styles.savedSection}>
                  <p className={styles.savedLabel}>保存済みファイル</p>
                  <ul className={styles.fileList}>
                    {storedFiles.map(sf => (
                      <li key={sf.id}>
                        <button className={styles.fileItem} onClick={() => handleStoredFileOpen(sf)}>
                          <span className={styles.fileIcon}>{sf.mimeType.startsWith('video/') ? '🎬' : '🎵'}</span>
                          <span className={styles.fileItemName}>{sf.name}</span>
                          <span className={styles.fileDate}>
                            {new Date(sf.savedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <button
                            className={styles.deleteBtn}
                            onClick={e => handleStoredFileDelete(sf.id, e)}
                            title="削除"
                          >✕</button>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

          ) : (
            <div className={styles.driveWrap}>
              {!token ? (
                <div className={styles.driveAuth}>
                  <p className={styles.driveAuthDesc}>
                    Google ドライブ内の音楽・動画ファイルを再生できます。
                  </p>
                  <button className={styles.googleBtn} onClick={handleDriveAuth} disabled={isLoadingAuth}>
                    {isLoadingAuth ? '認証中…' : '🔑 Google でサインイン'}
                  </button>
                  {driveError && <p className={styles.errorMsg}>{driveError}</p>}
                </div>
              ) : (
                <>
                  <div className={styles.driveTopRow}>
                    <form onSubmit={handleDriveSearch} className={styles.driveSearchForm}>
                      <input
                        type="text" value={driveQuery} onChange={e => setDriveQuery(e.target.value)}
                        placeholder="ファイル名で検索…" className={styles.driveSearchInput}
                      />
                      <button type="submit" className={styles.driveSearchBtn} disabled={isLoadingFiles}>🔍</button>
                    </form>
                    <button className={styles.signOutBtn} onClick={handleSignOut}>サインアウト</button>
                  </div>
                  {driveError && <p className={styles.errorMsg}>{driveError}</p>}
                  {isLoadingFile ? (
                    <div className={styles.progressWrap}>
                      <div
                        className={styles.progressBar}
                        style={{ width: `${downloadProgress ?? 0}%` }}
                      />
                      <span className={styles.progressLabel}>
                        {downloadProgress !== null ? `${downloadProgress}%` : '読み込み中…'}
                      </span>
                    </div>
                  ) : isLoadingFiles ? (
                    <p className={styles.statusMsg}>読み込み中…</p>
                  ) : driveFiles.length === 0 ? (
                    <p className={styles.statusMsg}>音楽・動画ファイルが見つかりません</p>
                  ) : (
                    <ul className={styles.fileList}>
                      {driveFiles.map(f => (
                        <li key={f.id} className={styles.driveFileRow}>
                          <button className={styles.fileItem} onClick={() => handleDriveFileSelect(f)}>
                            <span className={styles.fileIcon}>{f.mimeType.startsWith('video/') ? '🎬' : '🎵'}</span>
                            <span className={styles.fileItemName}>{f.name}</span>
                            <span className={styles.fileSize}>{formatSize(f.size)}</span>
                          </button>
                          <button
                            className={styles.driveShareBtn}
                            onClick={() => handleShare(f.id)}
                            disabled={sharingId === f.id}
                            aria-label="共有"
                            title="共有"
                          >
                            {sharingId === f.id ? '…' : '⬆'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
