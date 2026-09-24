import { useCallback, useEffect, useState } from 'react';
import {
  listCaptures, listHomeServerFolders, loginCapture, requestCapture,
  type CaptureItem, type HomeServerFolder,
} from '../engine/homeServer';
import styles from './CaptureTab.module.css';

const HOME_SERVER_URL = (import.meta.env.VITE_HOME_SERVER_URL ?? '') as string;
const POLL_MS = 10_000;

const STATUS_LABEL: Record<CaptureItem['status'], string> = {
  queued: '順番待ち',
  running: '録画中',
  done: '完了',
  error: '失敗',
};

/**
 * 取込タブ: Facebook リール等の URL を渡すと、ThinkCentre が再生を録画して保存する。
 * 開くたびにパスワードを聞く（パスワードはサーバー側で確かめる。アプリには持たせず、入力値をメモリに置くだけ）
 */
export function CaptureTab() {
  const [password, setPassword] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [checking, setChecking] = useState(false);

  const [urls, setUrls] = useState('');
  const [folders, setFolders] = useState<HomeServerFolder[]>([]);
  const [folderId, setFolderId] = useState<string>('');
  const [captures, setCaptures] = useState<CaptureItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input) return;
    setChecking(true);
    setAuthError('');
    try {
      await loginCapture(HOME_SERVER_URL, input);
      setPassword(input);
      setInput('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '確認に失敗しました');
    } finally {
      setChecking(false);
    }
  };

  const refresh = useCallback(async (pw: string) => {
    try {
      setCaptures(await listCaptures(HOME_SERVER_URL, pw));
    } catch (err) {
      setError(err instanceof Error ? err.message : '一覧の取得に失敗しました');
    }
  }, []);

  // 解錠したらフォルダ一覧と取り込み状況を読む。サルサのフォルダがあれば既定にする
  useEffect(() => {
    if (!password) return;
    void refresh(password);
    listHomeServerFolders(HOME_SERVER_URL)
      .then(f => {
        setFolders(f);
        const salsa = f.find(x => x.name.includes('サルサ'));
        if (salsa) setFolderId(prev => prev || salsa.id);
      })
      .catch(() => {});
  }, [password, refresh]);

  // 順番待ち・録画中があるあいだは状況を定期的に読み直す
  const active = captures.some(c => c.status === 'queued' || c.status === 'running');
  useEffect(() => {
    if (!password || !active) return;
    const timer = setInterval(() => { void refresh(password); }, POLL_MS);
    return () => clearInterval(timer);
  }, [password, active, refresh]);

  const handleSubmit = async () => {
    if (!password) return;
    const list = urls.split(/\s+/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    let ok = 0;
    const failed: string[] = [];
    for (const u of list) {
      try {
        await requestCapture(HOME_SERVER_URL, password, u, folderId || null);
        ok++;
      } catch (err) {
        failed.push(`${u}: ${err instanceof Error ? err.message : '失敗'}`);
      }
    }
    setSubmitting(false);
    if (ok > 0) {
      setMessage(`${ok}件を順番待ちに入れました。1本ずつ録画します（1本ごとに30秒空けます）。`);
      setUrls('');
    }
    if (failed.length > 0) setError(failed.join('\n'));
    void refresh(password);
  };

  if (!HOME_SERVER_URL) {
    return <p className={styles.hint}>ThinkCentre サーバーが設定されていません。</p>;
  }

  if (!password) {
    return (
      <form className={styles.lock} onSubmit={handleLogin}>
        <h3 className={styles.heading}>📥 動画の取り込み</h3>
        <p className={styles.hint}>この機能を使うにはパスワードが必要です。</p>
        <input
          type="password"
          className={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="パスワード"
          autoComplete="current-password"
        />
        <button type="submit" className={styles.primaryBtn} disabled={checking || !input}>
          {checking ? '確認中…' : '開く'}
        </button>
        {authError && <p className={styles.error}>{authError}</p>}
      </form>
    );
  }

  return (
    <div className={styles.wrapper}>
      <h3 className={styles.heading}>📥 動画の取り込み</h3>
      <p className={styles.hint}>
        Facebook のリールの URL を貼ってください（複数は改行で区切る）。
        ThinkCentre が動画を再生しながら録画して保存します。自分の練習用に留め、公開・共有はしないでください。
      </p>
      <textarea
        className={styles.textarea}
        value={urls}
        onChange={e => setUrls(e.target.value)}
        placeholder="https://www.facebook.com/reel/..."
        rows={3}
      />
      <label className={styles.folderRow}>
        保存先フォルダ
        <select className={styles.select} value={folderId} onChange={e => setFolderId(e.target.value)}>
          <option value="">（フォルダなし）</option>
          {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      <button className={styles.primaryBtn} onClick={handleSubmit} disabled={submitting || !urls.trim()}>
        {submitting ? '登録中…' : '取り込む'}
      </button>
      {message && <p className={styles.message}>{message}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.listHeader}>
        <span className={styles.label}>取り込み状況</span>
        <button className={styles.smallBtn} onClick={() => void refresh(password)}>更新</button>
      </div>
      {captures.length === 0 ? (
        <p className={styles.hint}>まだありません。</p>
      ) : (
        <ul className={styles.list}>
          {captures.map(c => (
            <li key={c.id} className={styles.item}>
              <span className={`${styles.badge} ${styles[`badge_${c.status}`]}`}>{STATUS_LABEL[c.status]}</span>
              <span className={styles.url}>{c.url}</span>
              {c.status === 'done' && <span className={styles.sub}>Home タブに保存しました</span>}
              {c.status === 'error' && c.errorMessage && <span className={styles.subError}>{c.errorMessage}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
