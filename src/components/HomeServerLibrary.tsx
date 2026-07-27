import { useEffect, useState } from 'react';
import {
  listHomeServerVideos, resolveHomeServerUrl, deleteHomeServerVideo, updateHomeServerVideo,
  listHomeServerFolders, createHomeServerFolder, deleteHomeServerFolder,
  type HomeServerVideo, type HomeServerFolder,
} from '../engine/homeServer';
import styles from './HomeServerLibrary.module.css';

const HOME_SERVER_URL = (import.meta.env.VITE_HOME_SERVER_URL ?? '') as string;

type Props = {
  /** 動画をタップした時に呼ばれる。Files タブの FilePlayer（スロー・ループ等）で開く */
  onOpenInPlayer: (name: string, hlsUrl: string) => void;
};

export function HomeServerLibrary({ onOpenInPlayer }: Props) {
  const [videos, setVideos] = useState<HomeServerVideo[]>([]);
  const [folders, setFolders] = useState<HomeServerFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
    } catch (e) {
      setError(e instanceof Error ? e.message : '一覧の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handlePlay = (v: HomeServerVideo) => {
    const src = resolveHomeServerUrl(HOME_SERVER_URL, v.hlsUrl);
    if (src) onOpenInPlayer(v.title, src);
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
          全て
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
              <button className={styles.cardActionBtn} onClick={() => handleRename(v)} title="名前変更">✏️</button>
              <button className={styles.cardActionBtn} onClick={() => handleDelete(v)} title="削除">🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
