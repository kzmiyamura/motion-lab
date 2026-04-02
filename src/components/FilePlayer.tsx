import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { requestDriveToken, revokeDriveToken, getStoredToken } from '../engine/googleAuth';
import { listMediaFiles, fetchFileBlob, findOrCreateFolder, uploadFileResumable, createPublicPermission, type DriveFile, type UploadStats } from '../engine/googleDrive';
import { saveFile, listFiles, deleteFile, type StoredFile } from '../engine/localFileStore';
import { SLOW_RATES, ZOOM_PRESETS, type SlowRate, type ZoomState } from '../hooks/useVideoTraining';
import { useWakeLock } from '../hooks/useWakeLock';
import { usePoseEstimation, type VizMode, type SalsaStyle } from '../hooks/usePoseEstimation';
import { usePoseLogger } from '../hooks/usePoseLogger';
import { loadModel, modelFromJson, type RoleModel } from '../engine/poseClassifier';
import { useBpmMeasure } from '../hooks/useBpmMeasure';
import { ModeSwitcher } from './ModeSwitcher';
import { SequenceView } from './SequenceView';
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

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024)      return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

function fmtSpeed(bps: number): string {
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
  if (bps >= 1024)      return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60)   return `残り約${Math.ceil(sec)}秒`;
  if (sec < 3600) return `残り約${Math.ceil(sec / 60)}分`;
  return `残り約${(sec / 3600).toFixed(1)}時間`;
}

export function FilePlayer({ bpm, onBpmChange }: Props) {
  const navigate = useNavigate();
  const [subTab, setSubTab] = useState<'local' | 'drive'>('local');
  const [source, setSource] = useState<FileSource | null>(null);
  const [baseBpm, setBaseBpm] = useState<number | null>(null);
  const [sliderBpm, setSliderBpm] = useState(bpm);

  // Player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);

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
  const [uploadStats, setUploadStats] = useState<UploadStats | null>(null);
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
  // View mode (audio / video)
  const [fileViewMode, setFileViewMode] = useState<'audio' | 'video'>('video');

  // Pose estimation
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [vizMode, setVizMode] = useState<VizMode>('off');
  const [lockModeActive, setLockModeActive] = useState(false);
  const [salsaStyle, setSalsaStyle] = useState<SalsaStyle>('on1');
  const [heightLeaderHint, setHeightLeaderHint] = useState(false);

  // Zoom gesture refs
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastDistRef = useRef<number | null>(null);

  // ── ML ロール推論
  const [mlMode, setMlMode] = useState(false);
  const mlModelRef = useRef<RoleModel | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mlTfRef = useRef<any>(null);

  const [mlModelLoaded, setMlModelLoaded] = useState(false);

  // モデルを IndexedDB → Drive の順で読み込む
  useEffect(() => {
    import('@tensorflow/tfjs').then(tf => { mlTfRef.current = tf; });

    const MODEL_DRIVE_FILENAME = 'salsa_role_model.json';
    const DRIVE_FOLDER_NAME    = 'salsa_annotations';

    async function fetchModel() {
      // 1) IndexedDB から試みる
      const local = await loadModel();
      if (local) { mlModelRef.current = local; setMlModelLoaded(true); return; }

      // 2) Drive から取得（token があれば）
      const token = getStoredToken();
      if (!token || !CLIENT_ID) return;
      try {
        const { findOrCreateFolder, listFilesInFolder, fetchFileBlob } = await import('../engine/googleDrive');
        const folderId = await findOrCreateFolder(token, DRIVE_FOLDER_NAME);
        const files = await listFilesInFolder(token, folderId);
        const modelFile = files.find(f => f.name === MODEL_DRIVE_FILENAME);
        if (!modelFile) return;
        const blob = await fetchFileBlob(token, modelFile.id);
        const json = await blob.text();
        const model = await modelFromJson(json);
        // IndexedDB にキャッシュしておく
        const { saveModel } = await import('../engine/poseClassifier');
        await saveModel(model);
        mlModelRef.current = model;
        setMlModelLoaded(true);
      } catch {
        // Drive 取得失敗は無視
      }
    }

    fetchModel();
  }, []);

  // ── ポーズロガー
  const { isRecording, frameCount, startRecording, stopRecording, exportJson, getLog, onRawPoses } = usePoseLogger();

  const {
    lockAt, unlock, isLocked,
    sequence, clearSequence,
    syncError, clearRoles,
    roleDetected, swapRoles,
    annotations, exportDebugLog,
    debugInfo,
    mlResult,
  } = usePoseEstimation(
    mediaRef, canvasRef, source?.isVideo ? vizMode : 'off',
    bpm, isMirrored, salsaStyle, heightLeaderHint,
    vizMode !== 'off' ? onRawPoses : undefined,
    mlMode ? mlModelRef.current : null,   // ML ON時のみモデルを渡す → RAFループ内で同期推論
    mlTfRef.current,
  );

  // ── BPM 計測（音声モード）
  const handleMeasuredBpm = useCallback((measured: number) => {
    setBaseBpm(measured);
    onBpmChange(measured);
  }, [onBpmChange]);

  const {
    mode: bpmMode, switchMode: switchBpmMode,
    isPressing, elapsedMs, estimatedBeat,
    firstTapSet,
    handlePressStart, handlePressEnd, handleTap,
  } = useBpmMeasure(handleMeasuredBpm, bpm);

  // ── 音声/動画モード切替
  const handleViewModeChange = useCallback((m: 'audio' | 'video') => {
    setFileViewMode(m);
    if (m === 'audio') {
      // 音声モードでは骨格をOFFにしてリセット
      setVizMode('off');
      unlock();
      setLockModeActive(false);
      applySlowRate(1.0);
    }
  }, [unlock]);

  // Derived
  const isTheater = playerSize === 'theater';
  const isExpanded = isTheater || isFullscreen;

  // マウント時に有効なトークンを復元（アプリ更新後も再認証不要）
  useEffect(() => {
    const stored = getStoredToken();
    if (stored) setToken(stored);
  }, []);

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

  // Sync volume/mute to media element
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

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
    // ロック状態をリセット
    unlock();
    setLockModeActive(false);
    clearSequence();
  }, [bpm, unlock, clearSequence]);

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

  // Overlay click: lock-on → controls toggle → play/pause
  const handleOverlayClick = (e: React.MouseEvent) => {
    // ロック待機中 & 骨格表示 ON → その座標の人物をロックオン
    if (lockModeActive && source?.isVideo && vizMode !== 'off') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const tapX = e.clientX - rect.left;
      const tapY = e.clientY - rect.top;
      const cw = rect.width;
      const ch = rect.height;

      // CSS transform の逆変換：ビジュアル座標 → キャンバス描画座標
      // 適用された CSS: [scaleX(-1)?] scale(zoom.scale) translate(zoom.x/zoom.scale, zoom.y/zoom.scale)
      // 逆変換：
      //   ミラーあり: canvasX = cw/2 + (-tapX + cw/2 - zoom.x) / zoom.scale
      //   ミラーなし: canvasX = cw/2 + ( tapX - cw/2 - zoom.x) / zoom.scale
      //   共通:      canvasY = ch/2 + ( tapY - ch/2 - zoom.y) / zoom.scale
      const canvasX = isMirrored
        ? cw / 2 + (-tapX + cw / 2 - zoom.x) / zoom.scale
        : cw / 2 + ( tapX - cw / 2 - zoom.x) / zoom.scale;
      const canvasY = ch / 2 + (tapY - ch / 2 - zoom.y) / zoom.scale;

      lockAt(canvasX, canvasY);
      return;
    }
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
    unlock();
    setLockModeActive(false);
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
    setUploadStats(null);

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
        const { requestDriveWriteToken } = await import('../engine/googleAuth');
        uploadToken = await requestDriveWriteToken(CLIENT_ID);
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
    setUploadStats(null);
    try {
      const fileId = await uploadFileResumable(uploadToken, folderId, file, stats => setUploadStats(stats));
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
      {/* 音声 / 動画 モード切替 */}
      <div className={styles.modeSwitcherRow}>
        <ModeSwitcher mode={fileViewMode} onChange={handleViewModeChange} />
      </div>

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
        {source.isVideo && fileViewMode === 'video' && (
          <button
            className={`${styles.mirrorBtn} ${isMirrored ? styles.mirrorBtnActive : ''}`}
            onClick={() => setIsMirrored(v => !v)}
            title={isMirrored ? 'ミラー解除' : 'ミラー反転'}
            aria-label="ミラー反転"
          >↔</button>
        )}
        {/* On1/On2 スタイルトグル（骨格ON時のみ） */}
        {source.isVideo && fileViewMode === 'video' && vizMode !== 'off' && (
          <div className={styles.styleToggleGroup}>
            {(['on1', 'on2'] as const).map(s => (
              <button
                key={s}
                className={`${styles.styleToggleBtn} ${salsaStyle === s ? styles.styleToggleBtnActive : ''}`}
                onClick={() => { setSalsaStyle(s); clearRoles(); }}
                title={s === 'on1' ? 'On1 (LA Style) — Count 1 でブレイク' : 'On2 (NY Style) — Count 2 でブレイク'}
              >
                {s === 'on1' ? 'On1' : 'On2'}
              </button>
            ))}
          </div>
        )}
        {/* 背が高い方をリーダーにするヒントチェックボックス */}
        {source.isVideo && fileViewMode === 'video' && vizMode !== 'off' && (
          <label className={styles.heightHintLabel}>
            <input
              type="checkbox"
              checked={heightLeaderHint}
              onChange={e => { setHeightLeaderHint(e.target.checked); clearRoles(); }}
            />
            背が高い方がリーダー
          </label>
        )}
        {/* Swap Roles ボタン（ロール判定済み時） */}
        {source.isVideo && fileViewMode === 'video' && vizMode !== 'off' && roleDetected && (
          <button
            className={styles.swapBtn}
            onClick={swapRoles}
            title="Leader/Follower を手動で入れ替え、前後5フレームをデバッグログに記録"
          >
            ⇄ Swap{annotations.length > 0 ? ` (${annotations.length})` : ''}
          </button>
        )}
        {/* Export Debug Log ボタン */}
        {source.isVideo && fileViewMode === 'video' && annotations.length > 0 && (
          <button
            className={styles.exportLogBtn}
            onClick={() => exportDebugLog(source.name)}
            title="salsa_debug_log.json をダウンロード"
          >
            ⬇ Log
          </button>
        )}
        {/* ── ポーズロガー Rec / Export ── */}
        {source.isVideo && fileViewMode === 'video' && vizMode !== 'off' && (
          <>
            <button
              className={styles.vizModeBtn}
              style={{ color: isRecording ? '#ff4444' : undefined, fontWeight: isRecording ? 'bold' : undefined }}
              onClick={() => isRecording ? stopRecording() : startRecording(
                mediaRef.current?.videoWidth,
                mediaRef.current?.videoHeight,
              )}
              title={isRecording ? `録画中 ${frameCount}f — クリックで停止` : 'ポーズデータ録画開始'}
            >
              {isRecording ? `■ ${frameCount}f` : '● REC'}
            </button>
            {frameCount > 0 && !isRecording && (
              <>
                <button
                  className={styles.vizModeBtn}
                  onClick={() => exportJson(source.name)}
                  title="salsa_raw_v2_*.json として書き出し"
                >
                  ⬇ Raw
                </button>
                <button
                  className={styles.vizModeBtn}
                  style={{ color: '#bb88ff', borderColor: '#bb88ff' }}
                  onClick={() => {
                    const rawLog = getLog(source.name);
                    if (!rawLog) return;
                    // FilePlayer のアンマウント前に新しい blob URL を作成して渡す
                    const videoFile = sourceFileRef.current;
                    const newVideoUrl = videoFile ? URL.createObjectURL(videoFile) : null;
                    navigate('/annotate', { state: { rawLog, videoUrl: newVideoUrl, videoName: source.name } });
                  }}
                  title="アノテーションツールへ移動（データ・動画を引き継ぎ）"
                >
                  → Annotate
                </button>
              </>
            )}
          </>
        )}

        {source.isVideo && fileViewMode === 'video' && (
          <div className={styles.vizModeGroup} role="group" aria-label="骨格表示モード">
            {(['off', 'full', 'salsa', 'trail'] as const).map(m => (
              <button
                key={m}
                className={`${styles.vizModeBtn} ${vizMode === m ? styles.vizModeBtnActive : ''}`}
                onClick={() => {
                  setVizMode(m);
                  // 骨格OFFにしたらロックも解除
                  if (m === 'off') { unlock(); setLockModeActive(false); }
                }}
                title={
                  m === 'off'   ? '骨格表示 OFF' :
                  m === 'full'  ? '全身表示' :
                  m === 'salsa' ? 'サルサ軸解析（傾き角度付き）' :
                                  'ステップ軌跡（足首トレイル）'
                }
              >
                {m === 'off' ? 'OFF' : m === 'full' ? '全身' : m === 'salsa' ? '軸' : '軌跡'}
              </button>
            ))}
          </div>
        )}
        {source.isVideo && fileViewMode === 'video' && (
          <button
            className={`${styles.vizModeBtn} ${mlMode ? styles.vizModeBtnActive : ''}`}
            style={mlMode ? { color: '#cc88ff', borderColor: '#cc88ff' } : { color: mlModelLoaded ? '#aa77cc' : '#554466' }}
            onClick={() => {
              if (!mlModelLoaded) return;
              const next = !mlMode;
              setMlMode(next);
              // 骨格がOFFのままだとMLの色が反映されないので自動でONにする
              if (next && vizMode === 'off') setVizMode('full');
            }}
            title={mlModelLoaded ? 'ML推論モード切替（骨格OFFの場合は自動でONにします）' : 'モデル未読み込み — Annotation画面でTrainしてください'}
          >
            {mlModelLoaded ? (mlMode ? 'ML ON' : 'ML') : 'ML —'}
          </button>
        )}
        {source.isVideo && fileViewMode === 'video' && vizMode !== 'off' && (
          <button
            className={
              `${styles.lockBtn} ` +
              (isLocked ? styles.lockBtnLocked : lockModeActive ? styles.lockBtnWaiting : '')
            }
            onClick={() => {
              if (isLocked || lockModeActive) {
                unlock();
                setLockModeActive(false);
              } else {
                setLockModeActive(true);
              }
            }}
            title={
              isLocked ? 'ロック解除' :
              lockModeActive ? '人物をタップして選択 / キャンセル' :
              'ターゲットロック（人物タップで固定）'
            }
            aria-label="ターゲットロック"
          >
            {isLocked ? '🔓' : lockModeActive ? '🎯…' : '🎯'}
          </button>
        )}
        {fileViewMode === 'video' && (
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
        )}
      </div>

      {/* Row 2: A-B Loop（動画モードのみ） */}
      {fileViewMode === 'video' && (
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
      )}

      {/* Row 3: Zoom presets（動画モード × 動画ファイルのみ） */}
      {fileViewMode === 'video' && source.isVideo && (
        <div className={styles.ctrlRow}>
          <span className={styles.ctrlLabel}>Zoom</span>
          {ZOOM_PRESETS.map(p => (
            <button key={p.id} className={styles.presetBtn} onClick={() => applyPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* ── BPM 計測ブロック（音声モードのみ） ── */}
      {fileViewMode === 'audio' && (
        <div className={styles.bpmMeasureBlock}>
          <div className={styles.bpmMeasureHeader}>
            <span className={styles.bpmMeasureLabel}>BPM 計測</span>
            <div className={styles.bpmModeToggle}>
              <button
                className={`${styles.bpmModeBtn} ${bpmMode === 'longpress' ? styles.bpmModeBtnActive : ''}`}
                onClick={() => switchBpmMode('longpress')}
              >長押し</button>
              <button
                className={`${styles.bpmModeBtn} ${bpmMode === 'twotap' ? styles.bpmModeBtnActive : ''}`}
                onClick={() => switchBpmMode('twotap')}
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

          {bpmMode === 'longpress' ? (
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
                onClick={() => { const n = Math.max(1, baseBpm - 1); setBaseBpm(n); onBpmChange(n); }}
              >−</button>
              <span className={styles.bpmResultValue}>{baseBpm}</span>
              <button
                className={styles.bpmAdjBtn}
                onClick={() => { const n = baseBpm + 1; setBaseBpm(n); onBpmChange(n); }}
              >＋</button>
              <span className={styles.bpmResultUnit}>BPM 基準</span>
              {bpm !== baseBpm && (
                <span className={styles.bpmRateTag}>×{(bpm / baseBpm).toFixed(2)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* BPM slider */}
      <div className={styles.bpmRow}>
        <span className={styles.bpmLabel}>
          BPM
          {fileViewMode === 'video' && (
            <span className={styles.rateHint}> ×{(slowRate * (baseBpm ? sliderBpm / baseBpm : 1)).toFixed(2)}</span>
          )}
        </span>
        <input
          type="range" min={60} max={220} step={1} value={sliderBpm}
          onChange={e => setSliderBpm(Number(e.target.value))}
          onPointerUp={e => commitBpm(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={e => commitBpm(Number((e.target as HTMLInputElement).value))}
          onKeyUp={e => commitBpm(Number((e.target as HTMLInputElement).value))}
          className={styles.bpmSlider}
        />
        <span className={styles.bpmValue}>{sliderBpm}</span>
      </div>

      {/* Volume row */}
      <div className={styles.bpmRow}>
        <button
          className={styles.muteBtn}
          onClick={() => setIsMuted(v => !v)}
          title={isMuted ? 'ミュート解除' : 'ミュート'}
        >
          {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
        </button>
        <input
          type="range" min={0} max={1} step={0.01} value={isMuted ? 0 : volume}
          onChange={e => { setIsMuted(false); setVolume(Number(e.target.value)); }}
          className={styles.bpmSlider}
        />
        <span className={styles.bpmValue}>{isMuted ? 0 : Math.round(volume * 100)}%</span>
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
                  style={{ width: `${uploadStats?.percent ?? 0}%` }}
                />
              </div>
              {uploadStatus === 'authing' && (
                <span className={styles.uploadProgressLabel}>認証中…</span>
              )}
              {uploadStatus === 'folder' && (
                <span className={styles.uploadProgressLabel}>フォルダ確認中…</span>
              )}
              {uploadStatus === 'uploading' && uploadStats && (
                <div className={styles.uploadStatsRow}>
                  <span className={styles.uploadPct}>{uploadStats.percent}%</span>
                  <span className={styles.uploadDetail}>
                    {fmtBytes(uploadStats.loaded)} / {fmtBytes(uploadStats.total)}
                  </span>
                  {uploadStats.speedBps > 0 && (
                    <span className={styles.uploadSpeed}>{fmtSpeed(uploadStats.speedBps)}</span>
                  )}
                  {uploadStats.etaSec > 0 && (
                    <span className={styles.uploadEta}>{fmtEta(uploadStats.etaSec)}</span>
                  )}
                </div>
              )}
              {uploadStatus === 'uploading' && !uploadStats && (
                <span className={styles.uploadProgressLabel}>アップロード開始中…</span>
              )}
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
            <div className={[styles.theaterBar, !controlsVisible ? styles.theaterBarHidden : ''].filter(Boolean).join(' ')}>
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
              onEnded={() => {
                const el = mediaRef.current;
                if (el) { el.currentTime = 0; el.play().catch(() => {}); }
              }}
              playsInline
              controls={false}
            />
            {source.isVideo && (
              <>
                <canvas
                  ref={canvasRef}
                  className={styles.poseCanvas}
                  style={{
                    transform: `${isMirrored ? 'scaleX(-1) ' : ''}scale(${zoom.scale}) translate(${zoom.x / zoom.scale}px, ${zoom.y / zoom.scale}px)`,
                    display: vizMode !== 'off' ? 'block' : 'none',
                  }}
                />
                {mlMode && mlResult && (
                  <div style={{
                    position: 'absolute', top: 6, right: 6,
                    background: 'rgba(0,0,0,0.75)',
                    border: `1px solid ${mlResult.leaderSlot === 0 ? '#4488ff' : '#ff44cc'}`,
                    borderRadius: 6, padding: '3px 8px',
                    fontSize: 11, fontFamily: 'monospace',
                    color: mlResult.leaderSlot === 0 ? '#4488ff' : '#ff44cc',
                    pointerEvents: 'none', zIndex: 10,
                  }}>
                    🤖 L=S{mlResult.leaderSlot} {Math.round(mlResult.prob * 100)}%
                  </div>
                )}
                <div
                  className={styles.videoOverlay}
                  onPointerDown={onOverlayPointerDown}
                  onPointerMove={onOverlayPointerMove}
                  onPointerUp={onOverlayPointerUp}
                  onPointerCancel={onOverlayPointerUp}
                  onClick={handleOverlayClick}
                  style={{ cursor: lockModeActive && vizMode !== 'off' && !isLocked ? 'crosshair' : 'pointer' }}
                />
                {debugInfo && vizMode !== 'off' && (
                  <div className={styles.debugPanel}>
                    {/* ── スロット状態（シンプル表示）── */}
                    {debugInfo.slots.map(sl => (
                      <div key={sl.slotIdx} className={styles.debugRow}>
                        <span className={styles.debugSlot}
                          style={{ color: sl.role === 'leader' ? '#4af' : sl.role === 'follower' ? '#f4a' : '#aaa' }}>
                          S{sl.slotIdx}:{sl.role ? sl.role[0].toUpperCase() : '?'}
                        </span>
                        <span className={styles.debugVal}
                          style={{ color: sl.lockSource === 'face' ? '#0f0' : sl.lockSource === 'shr' ? '#4af' : '#888' }}>
                          [{sl.lockSource ?? '-'}]
                        </span>
                        <span className={styles.debugVal}
                          style={{ color: '#ff8' }}>
                          ps:{sl.profileScore.toFixed(3)}
                        </span>
                        <span className={styles.debugVal}
                          style={{ color: sl.isDetected ? '#4f4' : '#f44' }}>
                          {sl.isDetected ? 'det' : 'occ'}
                        </span>
                        <span className={styles.debugVal}>{sl.frontalN}f</span>
                      </div>
                    ))}
                    {/* ── グローバル状態 ── */}
                    <div className={styles.debugRow}>
                      <span className={styles.debugVal}
                        style={{ color: debugInfo.faceReady ? '#0f0' : '#fa4' }}>
                        face:{debugInfo.faceReady ? 'READY' : 'loading'}
                      </span>
                      {debugInfo.faceSuspending && (
                        <span className={styles.debugVal} style={{ color: '#fa4' }}>SHR-WAIT</span>
                      )}
                      {debugInfo.faceLocked && (
                        <span className={styles.debugVal} style={{ color: '#0f0' }}>FACE-LOCK</span>
                      )}
                      {debugInfo.genderLocked && !debugInfo.faceLocked && (
                        <span className={styles.debugVal} style={{ color: '#4af' }}>SHR-LOCK</span>
                      )}
                      {debugInfo.manualLocked && (
                        <span className={styles.debugVal} style={{ color: '#f44' }}>MANUAL-LOCK</span>
                      )}
                      {!debugInfo.profileComplete && (
                        <span className={styles.debugVal} style={{ color: '#888' }}>profiling…</span>
                      )}
                      {debugInfo.isOccluded && (
                        <span className={styles.debugVal} style={{ color: '#fa4' }}>OCC</span>
                      )}
                    </div>
                  </div>
                )}
              </>
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

      {/* ── 修正アノテーション一覧（クリックでシーク） */}
      {fileViewMode === 'video' && annotations.length > 0 && (
        <div className={styles.annotationBar}>
          <span className={styles.annotationBarLabel}>修正済み:</span>
          {annotations.map((a, i) => (
            <button
              key={i}
              className={styles.annotationDot}
              onClick={() => { const el = mediaRef.current; if (el) el.currentTime = a.videoTime; }}
              title={`修正 #${i + 1} @ ${formatTime(a.videoTime)} — クリックでジャンプ`}
            >
              {formatTime(a.videoTime)}
            </button>
          ))}
        </div>
      )}

      {/* ── ロール同期エラー通知 */}
      {syncError && (
        <div className={styles.syncErrorNotice}>
          ⚠ 解析エラー：同期が取れていません（LeaderとFollowerが同方向に移動しています）
          <button className={styles.syncErrorDismiss} onClick={clearRoles}>リセット</button>
        </div>
      )}

      {/* ── Sequence View（動画読み込み後は常時表示、動画モードのみ） */}
      {source?.isVideo && fileViewMode === 'video' && (
        <SequenceView
          events={sequence}
          duration={duration}
          currentTime={currentTime}
          onClear={clearSequence}
          onSeek={time => {
            const el = mediaRef.current;
            if (!el) return;
            el.currentTime = time;
          }}
          isAnalyzing={vizMode !== 'off'}
        />
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
