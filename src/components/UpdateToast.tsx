import { useRegisterSW } from 'virtual:pwa-register/react';
import styles from './UpdateToast.module.css';

export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.text}>🎉 最新版に更新されました</span>
      <button
        className={styles.reloadBtn}
        onClick={() => updateServiceWorker(true)}
      >
        再読み込み
      </button>
      <button
        className={styles.closeBtn}
        onClick={() => setNeedRefresh(false)}
        aria-label="閉じる"
      >
        ✕
      </button>
    </div>
  );
}
