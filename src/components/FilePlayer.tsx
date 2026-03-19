import { useState, useRef, useCallback, useEffect } from 'react';
import { requestDriveToken, revokeDriveToken } from '../engine/googleAuth';
import { listMediaFiles, fetchFileBlob, type DriveFile } from '../engine/googleDrive';
import styles from './FilePlayer.module.css';

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '') as string;

type FileSource = {
  name: string;
  url: string;
  isVideo: boolean;
};

type Props = {
  bpm: number;
  onBpmChange: (bpm: number) => void;
};

function formatTime(s: number): string {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
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

  // Drive state
  const [token, setToken] = useState<string | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [driveQuery, setDriveQuery] = useState('');
  const [driveError, setDriveError] = useState('');

  const mediaRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevBlobUrl = useRef<string | null>(null);

  // Sync slider when external BPM changes (e.g. from Rhythm tab)
  useEffect(() => { setSliderBpm(bpm); }, [bpm]);

  // Apply playback rate with debounce
  useEffect(() => {
    if (!baseBpm || !source) return;
    const rate = Math.max(0.25, Math.min(2, sliderBpm / baseBpm));
    if (rateTimerRef.current) clearTimeout(rateTimerRef.current);
    rateTimerRef.current = setTimeout(() => {
      if (mediaRef.current) mediaRef.current.playbackRate = rate;
    }, 250);
  }, [sliderBpm, baseBpm, source]);

  // Revoke previous blob URL to free memory
  useEffect(() => {
    return () => {
      if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current);
    };
  }, []);

  // ── Local file ──────────────────────────────────────────────────
  const openFileSource = useCallback((name: string, url: string, mimeType: string) => {
    if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current);
    prevBlobUrl.current = url;
    setSource({ name, url, isVideo: mimeType.startsWith('video/') });
    setBaseBpm(bpm);
    setSliderBpm(bpm);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [bpm]);

  const handleFileSelect = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    openFileSource(file.name, url, file.type);
  }, [openFileSource]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.type.startsWith('audio/') || file.type.startsWith('video/'))) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);

  // ── Google Drive ─────────────────────────────────────────────────
  const loadDriveFiles = useCallback(async (t: string, q: string) => {
    setIsLoadingFiles(true);
    setDriveError('');
    try {
      const files = await listMediaFiles(t, q);
      setDriveFiles(files);
    } catch {
      setDriveError('ファイル一覧の取得に失敗しました。');
    } finally {
      setIsLoadingFiles(false);
    }
  }, []);

  const handleDriveAuth = async () => {
    if (!CLIENT_ID) {
      setDriveError('VITE_GOOGLE_CLIENT_ID が設定されていません。.env.local を確認してください。');
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
    setDriveError('');
    try {
      const blob = await fetchFileBlob(token, file.id);
      const url = URL.createObjectURL(blob);
      openFileSource(file.name, url, file.mimeType);
    } catch {
      setDriveError('ファイルの読み込みに失敗しました。');
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleSignOut = () => {
    if (token) revokeDriveToken(token);
    setToken(null);
    setDriveFiles([]);
    setDriveError('');
  };

  // ── Player controls ──────────────────────────────────────────────
  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) { el.play().catch(() => {}); } else { el.pause(); }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = mediaRef.current;
    if (!el || !isFinite(el.duration)) return;
    el.currentTime = Number(e.target.value);
  };

  const commitBpm = (val: number) => {
    onBpmChange(val);
    if (!baseBpm) setBaseBpm(val);
  };

  const goHome = () => {
    const el = mediaRef.current;
    if (el) el.pause();
    setSource(null);
    setBaseBpm(null);
    setIsPlaying(false);
  };

  const rate = baseBpm ? sliderBpm / baseBpm : 1;

  return (
    <div className={styles.wrapper}>
      {/* Media element — always present when source loaded */}
      {source && (
        <video
          ref={mediaRef}
          src={source.url}
          className={source.isVideo ? styles.video : styles.audioOnly}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime ?? 0)}
          onLoadedMetadata={() => {
            setDuration(mediaRef.current?.duration ?? 0);
            if (baseBpm && mediaRef.current) {
              mediaRef.current.playbackRate = Math.max(0.25, Math.min(2, sliderBpm / baseBpm));
            }
          }}
          onEnded={() => setIsPlaying(false)}
          playsInline
          controls={false}
        />
      )}

      {source ? (
        // ── Player UI ────────────────────────────────────────────
        <div className={styles.playerWrap}>
          <div className={styles.playerHeader}>
            <button className={styles.homeBtn} onClick={goHome} title="ファイル選択に戻る">
              ⌂
            </button>
            <p className={styles.fileName} title={source.name}>{source.name}</p>
          </div>

          {/* Seek bar */}
          <div className={styles.seekRow}>
            <span className={styles.timeLabel}>{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={isFinite(duration) ? duration : 100}
              step={0.5}
              value={currentTime}
              onChange={handleSeek}
              className={styles.seekBar}
            />
            <span className={styles.timeLabel}>{formatTime(duration)}</span>
          </div>

          {/* Play/Pause */}
          <div className={styles.controlRow}>
            <button className={styles.playBtn} onClick={togglePlay}>
              {isPlaying ? '⏸' : '▶'}
            </button>
          </div>

          {/* BPM / Rate slider */}
          <div className={styles.bpmRow}>
            <span className={styles.bpmLabel}>
              BPM
              <span className={styles.rateHint}> ×{rate.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={60}
              max={220}
              step={1}
              value={sliderBpm}
              onChange={e => setSliderBpm(Number(e.target.value))}
              onPointerUp={e => commitBpm(Number((e.target as HTMLInputElement).value))}
              onKeyUp={e => commitBpm(Number((e.target as HTMLInputElement).value))}
              className={styles.bpmSlider}
            />
            <span className={styles.bpmValue}>{sliderBpm}</span>
          </div>
        </div>
      ) : (
        // ── File selection UI ─────────────────────────────────────
        <div className={styles.selectWrap}>
          {/* Sub-tab */}
          <div className={styles.subTabs}>
            <button
              className={`${styles.subTab} ${subTab === 'local' ? styles.subTabActive : ''}`}
              onClick={() => setSubTab('local')}
            >
              📂 ローカル
            </button>
            <button
              className={`${styles.subTab} ${subTab === 'drive' ? styles.subTabActive : ''}`}
              onClick={() => setSubTab('drive')}
            >
              ☁ Google Drive
            </button>
          </div>

          {subTab === 'local' ? (
            // ── Local file picker ────────────────────────────────
            <div
              className={styles.dropZone}
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/*"
                className={styles.fileInputHidden}
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) handleFileSelect(f);
                  // reset so same file can be re-selected
                  e.target.value = '';
                }}
              />
              <p className={styles.dropIcon}>🎵</p>
              <p className={styles.dropText}>クリックまたはドラッグ&ドロップ</p>
              <p className={styles.dropHint}>MP3・MP4・WAV・M4A・OGG など</p>
            </div>
          ) : (
            // ── Google Drive ──────────────────────────────────────
            <div className={styles.driveWrap}>
              {!token ? (
                <div className={styles.driveAuth}>
                  <p className={styles.driveAuthDesc}>
                    Google ドライブ内の音楽・動画ファイルを再生できます。
                  </p>
                  <button
                    className={styles.googleBtn}
                    onClick={handleDriveAuth}
                    disabled={isLoadingAuth}
                  >
                    {isLoadingAuth ? '認証中…' : '🔑 Google でサインイン'}
                  </button>
                  {driveError && <p className={styles.errorMsg}>{driveError}</p>}
                </div>
              ) : (
                <>
                  <div className={styles.driveTopRow}>
                    <form onSubmit={handleDriveSearch} className={styles.driveSearchForm}>
                      <input
                        type="text"
                        value={driveQuery}
                        onChange={e => setDriveQuery(e.target.value)}
                        placeholder="ファイル名で検索…"
                        className={styles.driveSearchInput}
                      />
                      <button type="submit" className={styles.driveSearchBtn} disabled={isLoadingFiles}>
                        🔍
                      </button>
                    </form>
                    <button className={styles.signOutBtn} onClick={handleSignOut}>
                      サインアウト
                    </button>
                  </div>

                  {driveError && <p className={styles.errorMsg}>{driveError}</p>}

                  {(isLoadingFiles || isLoadingFile) ? (
                    <p className={styles.statusMsg}>読み込み中…</p>
                  ) : driveFiles.length === 0 ? (
                    <p className={styles.statusMsg}>音楽・動画ファイルが見つかりません</p>
                  ) : (
                    <ul className={styles.fileList}>
                      {driveFiles.map(f => (
                        <li key={f.id}>
                          <button
                            className={styles.fileItem}
                            onClick={() => handleDriveFileSelect(f)}
                          >
                            <span className={styles.fileIcon}>
                              {f.mimeType.startsWith('video/') ? '🎬' : '🎵'}
                            </span>
                            <span className={styles.fileItemName}>{f.name}</span>
                            {f.size && (
                              <span className={styles.fileSize}>
                                {(Number(f.size) / 1024 / 1024).toFixed(1)} MB
                              </span>
                            )}
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
