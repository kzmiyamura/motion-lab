import { useCallback, useEffect, useState } from 'react';
import {
  listHomeServerVideos, resolveHomeServerUrl, deleteHomeServerVideo, updateHomeServerVideo,
  listHomeServerFolders, createHomeServerFolder, deleteHomeServerFolder,
  getFolderSpec, listVideoJobs, reanalyzeVideo,
  type HomeServerVideo, type HomeServerFolder, type AnalysisJob,
} from '../engine/homeServer';
import { SpecEditorModal } from './SpecEditorModal';
import { ReportModal } from './ReportModal';
import styles from './HomeServerLibrary.module.css';

const HOME_SERVER_URL = (import.meta.env.VITE_HOME_SERVER_URL ?? '') as string;

type Props = {
  /** 動画をタップした時に呼ばれる。Files タブの FilePlayer（スロー・ループ等）で開く */
  onOpenInPlayer: (id: string, name: string, hlsUrl: string) => void;
};

export function HomeServerLibrary({ onOpenInPlayer }: Props) {
  const [videos, setVideos] = useState<HomeServerVideo[]>([]);
  const [folders, setFolders] = useState<HomeServerFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [specOpen, setSpecOpen] = useState(false);
  const [activeFolderHasSpec, setActiveFolderHasSpec] = useState(false);
  // 動画IDごとの最新解析ジョブ（フォルダ所属の動画のみ取得）
  const [latestJobs, setLatestJobs] = useState<Record<string, AnalysisJob | undefined>>({});
  // レポートモーダル（✅解析済みバッジのタップで開く）
  const [reportTarget, setReportTarget] = useState<{ jobId: string; title: string } | null>(null);

  const loadJobs = useCallback(async (targetVideos: HomeServerVideo[]) => {
    const withFolder = targetVideos.filter(v => v.folderId != null);
    if (withFolder.length === 0) {
      setLatestJobs({});
      return;
    }
    const entries = await Promise.all(withFolder.map(async v => {
      try {
        const jobs = await listVideoJobs(HOME_SERVER_URL, v.id);
        return [v.id, jobs[0]] as const;
      } catch {
        return [v.id, undefined] as const;
      }
    }));
    setLatestJobs(Object.fromEntries(entries));
  }, []);

  const load = async () => {
    if (!HOME_SERVER_URL) return;
    setLoading(true);
    setError('');
    try {
      const [v, f] = await Promise.all([
        listHomeServerVideos(HOME_SERVER_URL),
        listHomeServerFolders(HOME_SERVER_URL),
      ]);
      setVideos(v);
      setFolders(f);
      void loadJobs(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : '一覧の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // アクティブフォルダの指示書有無（📝ラベル・🔄表示の判定）
  useEffect(() => {
    if (!activeFolderId || !HOME_SERVER_URL) {
      setActiveFolderHasSpec(false);
      return;
    }
    let cancelled = false;
    getFolderSpec(HOME_SERVER_URL, activeFolderId)
      .then(spec => { if (!cancelled) setActiveFolderHasSpec(spec !== null); })
      .catch(() => { if (!cancelled) setActiveFolderHasSpec(false); });
    return () => { cancelled = true; };
  }, [activeFolderId, specOpen]);

  // queued / running のジョブがある間だけ10秒間隔でポーリング
  useEffect(() => {
    const active = Object.values(latestJobs).some(j => j && (j.status === 'queued' || j.status === 'running'));
    if (!active) return;
    const timer = setInterval(() => { void loadJobs(videos); }, 10_000);
    return () => clearInterval(timer);
  }, [latestJobs, videos, loadJobs]);

  const handlePlay = (v: HomeServerVideo) => {
    const src = resolveHomeServerUrl(HOME_SERVER_URL, v.hlsUrl);
    if (src) onOpenInPlayer(v.id, v.title, src);
  };

  const handleNewFolder = async () => {
    const name = prompt('新しいフォルダ名を入力してください');
    if (!name?.trim()) return;
    try {
      await createHomeServerFolder(HOME_SERVER_URL, name.trim());
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'フォルダ作成に失敗しました。');
    }
  };

  const handleDeleteFolder = async () => {
    if (!activeFolderId) return;
    const folder = folders.find(f => f.id === activeFolderId);
    if (!confirm(`フォルダ「${folder?.name ?? ''}」を削除しますか？（中の動画は削除されず「フォルダなし」に戻ります）`)) return;
    try {
      await deleteHomeServerFolder(HOME_SERVER_URL, activeFolderId);
      setActiveFolderId(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'フォルダ削除に失敗しました。');
    }
  };

  const handleRename = async (v: HomeServerVideo) => {
    const title = prompt('新しいタイトルを入力してください', v.title);
    if (!title?.trim() || title === v.title) return;
    try {
      await updateHomeServerVideo(HOME_SERVER_URL, v.id, { title: title.trim() });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : '名前変更に失敗しました。');
    }
  };

  const handleMove = async (v: HomeServerVideo, folderId: string) => {
    try {
      await updateHomeServerVideo(HOME_SERVER_URL, v.id, { folderId: folderId || null });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : '移動に失敗しました。');
    }
  };

  const handleReanalyze = async (v: HomeServerVideo) => {
    try {
      await reanalyzeVideo(HOME_SERVER_URL, v.id);
      await loadJobs(videos);
    } catch (e) {
      alert(e instanceof Error ? e.message : '再解析の開始に失敗しました。');
    }
  };

  const handleDelete = async (v: HomeServerVideo) => {
    if (!confirm(`「${v.title}」を削除しますか？この操作は取り消せません。`)) return;
    try {
      await deleteHomeServerVideo(HOME_SERVER_URL, v.id);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : '削除に失敗しました。');
    }
  };

  if (!HOME_SERVER_URL) {
    return (
      <div className={styles.wrapper}>
        <p className={styles.emptyHint}>
          VITE_HOME_SERVER_URL が設定されていません。.env.local を確認してください。
        </p>
      </div>
    );
  }

  const visibleVideos = videos.filter(v => (v.folderId ?? null) === activeFolderId);

  return (
    <div className={styles.wrapper}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionLabel}>🏠 ThinkCentre の動画</h3>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          {loading ? '…' : '↻ 更新'}
        </button>
      </div>

      <div className={styles.folderRow}>
        <button
          className={`${styles.folderChip} ${activeFolderId === null ? styles.folderChipActive : ''}`}
          onClick={() => setActiveFolderId(null)}
        >
          フォルダの外
        </button>
        {folders.map(f => (
          <button
            key={f.id}
            className={`${styles.folderChip} ${activeFolderId === f.id ? styles.folderChipActive : ''}`}
            onClick={() => setActiveFolderId(f.id)}
          >
            📁 {f.name}
          </button>
        ))}
        <button className={styles.folderChip} onClick={handleNewFolder}>+ 新規フォルダ</button>
        {activeFolderId && (
          <button
            className={styles.folderChip}
            onClick={() => setSpecOpen(true)}
            title="このフォルダの解析指示書を編集"
          >
            📝 解析設定{activeFolderHasSpec ? '' : '（未設定）'}
          </button>
        )}
        {activeFolderId && (
          <button className={styles.folderDeleteBtn} onClick={handleDeleteFolder} title="このフォルダを削除">
            🗑 フォルダ削除
          </button>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {!loading && visibleVideos.length === 0 && !error && (
        <p className={styles.emptyHint}>
          {activeFolderId ? 'このフォルダに動画はありません。' : 'まだ動画がありません。Files タブから「ThinkCentre に保存」してください。'}
        </p>
      )}

      <div className={styles.grid}>
        {visibleVideos.map(v => (
          <div key={v.id} className={styles.card}>
            <button
              className={styles.cardPlayArea}
              disabled={v.status !== 'ready'}
              onClick={() => handlePlay(v)}
            >
              <div className={styles.thumbWrap}>
                {v.thumbnailUrl ? (
                  <img
                    className={styles.thumb}
                    src={resolveHomeServerUrl(HOME_SERVER_URL, v.thumbnailUrl) ?? undefined}
                    alt={v.title}
                    loading="lazy"
                  />
                ) : (
                  <div className={styles.thumbPlaceholder}>
                    {v.status === 'processing' ? '変換中…' : v.status === 'error' ? '⚠ エラー' : ''}
                  </div>
                )}
              </div>
              <div className={styles.info}>
                <p className={styles.title}>{v.title}</p>
                {v.status === 'error' && (
                  <p className={styles.cardError}>{v.errorMessage ?? '変換に失敗しました'}</p>
                )}
                {(() => {
                  const j = latestJobs[v.id];
                  if (!j) return null;
                  if (j.status === 'queued') return <p className={styles.jobBadge}>⏳ 解析待ち</p>;
                  if (j.status === 'running') return <p className={styles.jobBadge}>🔬 解析中…</p>;
                  if (j.status === 'done') {
                    return (
                      <p
                        className={styles.jobBadgeDone}
                        role="button"
                        title="解析レポートを開く"
                        onClick={e => { e.stopPropagation(); setReportTarget({ jobId: j.id, title: v.title }); }}
                      >
                        📋 レポートを見る
                      </p>
                    );
                  }
                  return <p className={styles.jobBadgeError} title={j.errorMessage ?? undefined}>⚠ 解析失敗</p>;
                })()}
              </div>
            </button>
            <div className={styles.cardActions}>
              <select
                className={styles.moveSelect}
                value={v.folderId ?? ''}
                onChange={e => handleMove(v, e.target.value)}
                title="フォルダに移動"
              >
                <option value="">フォルダなし</option>
                {folders.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              {activeFolderHasSpec && v.status === 'ready' && (
                <button className={styles.cardActionBtn} onClick={() => handleReanalyze(v)} title="この動画を再解析">🔄</button>
              )}
              <button className={styles.cardActionBtn} onClick={() => handleRename(v)} title="名前変更">✏️</button>
              <button className={styles.cardActionBtn} onClick={() => handleDelete(v)} title="削除">🗑</button>
            </div>
          </div>
        ))}
      </div>

      {reportTarget && (
        <ReportModal
          jobId={reportTarget.jobId}
          videoTitle={reportTarget.title}
          baseUrl={HOME_SERVER_URL}
          onClose={() => setReportTarget(null)}
        />
      )}

      {specOpen && activeFolderId && (
        <SpecEditorModal
          folderId={activeFolderId}
          folderName={folders.find(f => f.id === activeFolderId)?.name ?? ''}
          baseUrl={HOME_SERVER_URL}
          onClose={() => setSpecOpen(false)}
          onSaved={() => { void loadJobs(videos); }}
        />
      )}
    </div>
  );
}
