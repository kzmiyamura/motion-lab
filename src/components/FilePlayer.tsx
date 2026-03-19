import { useState, useRef, useCallback, useEffect } from 'react';
import { requestDriveToken, revokeDriveToken } from '../engine/googleAuth';
import { listMediaFiles, fetchFileBlob, type DriveFile } from '../engine/googleDrive';
import { saveFile, listFiles, deleteFile, type StoredFile } from '../engine/localFileStore';
import { SLOW_RATES, ZOOM_PRESETS, type SlowRate, type ZoomState } from '../hooks/useVideoTraining';
import styles from './FilePlayer.module.css';

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '') as string;

type FileSource = { name: string; url: string; isVideo: boolean };

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

  const mediaRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevBlobUrl = useRef<string | null>(null);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Zoom gesture refs
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastDistRef = useRef<number | null>(null);

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

  // ── File opening ─────────────────────────────────────────────────────────
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
    openFileSource(file.name, url, file.type);
    // IndexedDB に保存（録画・選択ファイル問わず）
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
    openFileSource(sf.name, url, sf.mimeType);
  };

  const handleStoredFileDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteFile(id).catch(() => {});
    setStoredFiles(await listFiles().catch(() => []));
  };

  // ── Google Drive ──────────────────────────────────────────────────────────
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

  // ── Player controls ───────────────────────────────────────────────────────
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
    // A-B ループ
    if (isLooping && loopStart !== null && loopEnd !== null && t >= loopEnd) {
      el.currentTime = loopStart;
    }
  };

  // Slow rate button
  const applySlowRate = (rate: SlowRate) => {
    setSlowRateState(rate);
    if (mediaRef.current) mediaRef.current.playbackRate = rate;
  };

  // BPM slider commit
  const commitBpm = (val: number) => {
    onBpmChange(val);
    if (!baseBpm) setBaseBpm(val);
    // BPMスライダーが変化したら再生速度を更新（slowRateは維持）
    const base = baseBpm ?? val;
    if (mediaRef.current) {
      mediaRef.current.playbackRate = Math.max(0.25, Math.min(2, slowRate * (val / base)));
    }
  };

  // Frame step
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

  // Loop
  const markLoop = (point: 'start' | 'end') => {
    const t = mediaRef.current?.currentTime;
    if (t === undefined) return;
    if (point === 'start') setLoopStart(t);
    else setLoopEnd(t);
  };

  const clearLoop = () => { setLoopStart(null); setLoopEnd(null); setIsLooping(false); };

  // Zoom presets
  const applyPreset = (id: string) => {
    const p = ZOOM_PRESETS.find(pr => pr.id === id);
    if (p) setZoom({ scale: p.scale, x: p.x, y: p.y });
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
    setSource(null);
    setBaseBpm(null);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.wrapper}>

      {/* Hidden / visible video element */}
      {source && (
        <div className={source.isVideo ? styles.videoContainer : styles.audioOnlyWrap}>
          <video
            ref={mediaRef}
            src={source.url}
            className={styles.videoEl}
            style={{
              transform: source.isVideo
                ? `scale(${zoom.scale}) translate(${zoom.x / zoom.scale}px, ${zoom.y / zoom.scale}px)`
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
          {/* Overlay for pinch/drag zoom (video only) */}
          {source.isVideo && (
            <div
              className={styles.videoOverlay}
              onPointerDown={onOverlayPointerDown}
              onPointerMove={onOverlayPointerMove}
              onPointerUp={onOverlayPointerUp}
              onPointerCancel={onOverlayPointerUp}
              onClick={togglePlay}
            />
          )}
        </div>
      )}

      {source ? (
        // ── Player UI ─────────────────────────────────────────────────────
        <div className={styles.playerWrap}>
          {/* Header */}
          <div className={styles.playerHeader}>
            <button className={styles.homeBtn} onClick={goHome} title="ファイル選択に戻る">⌂</button>
            <p className={styles.fileName} title={source.name}>{source.name}</p>
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
        </div>

      ) : (
        // ── File selection UI ──────────────────────────────────────────────
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
              {/* Drop zone */}
              <div
                className={styles.dropZone}
                onDrop={handleDrop} onDragOver={e => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              >
                <input
                  ref={fileInputRef} type="file" accept="audio/*,video/*"
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

              {/* Saved files list */}
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
            // ── Google Drive ───────────────────────────────────────────────
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
                        <li key={f.id}>
                          <button className={styles.fileItem} onClick={() => handleDriveFileSelect(f)}>
                            <span className={styles.fileIcon}>{f.mimeType.startsWith('video/') ? '🎬' : '🎵'}</span>
                            <span className={styles.fileItemName}>{f.name}</span>
                            <span className={styles.fileSize}>{formatSize(f.size)}</span>
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
