import { useInstallPrompt } from '../hooks/useInstallPrompt';
import styles from './InstallPrompt.module.css';

export function InstallPrompt() {
  const { visible, platform, inAppBrowser, iosGuideOpen, handleInstall, dismiss, closeIosGuide } =
    useInstallPrompt();

  if (!visible) return null;

  return (
    <>
      {/* Inline install banner */}
      <div className={styles.banner} role="complementary" aria-label="インストール案内">
        <span className={styles.bannerIcon}>{inAppBrowser ? '🌐' : '📲'}</span>
        <span className={styles.bannerText}>
          {inAppBrowser
            ? 'Safari で開くとホーム画面に追加してオフラインで使えます'
            : 'ホーム画面に追加してオフラインで使う'}
        </span>
        <button className={styles.installBtn} onClick={handleInstall}>
          {inAppBrowser ? 'Safariで開く' : '追加'}
        </button>
        <button className={styles.closeBtn} onClick={dismiss} aria-label="閉じる">
          ✕
        </button>
      </div>

      {/* iOS guide modal (Safari のみ) */}
      {platform === 'ios' && !inAppBrowser && iosGuideOpen && (
        <div className={styles.overlay} onClick={closeIosGuide} role="dialog" aria-modal="true">
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <button className={styles.modalClose} onClick={closeIosGuide} aria-label="閉じる">
              ✕
            </button>
            <h2 className={styles.modalTitle}>ホーム画面に追加する方法</h2>
            <ol className={styles.steps}>
              <li>
                <span className={styles.stepIcon}>1</span>
                <span>
                  Safari 下部ツールバーの{' '}
                  <span className={styles.shareIcon} aria-label="共有">
                    <svg width="16" height="20" viewBox="0 0 16 20" fill="none" aria-hidden="true">
                      <path
                        d="M8 13V1M8 1L4 5M8 1l4 4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <rect
                        x="1"
                        y="8"
                        width="14"
                        height="11"
                        rx="2"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      />
                    </svg>
                  </span>{' '}
                  共有ボタンをタップ
                </span>
              </li>
              <li>
                <span className={styles.stepIcon}>2</span>
                <span>
                  メニューをスクロールして{' '}
                  <strong>「ホーム画面に追加」</strong> をタップ
                </span>
              </li>
              <li>
                <span className={styles.stepIcon}>3</span>
                <span>右上の「追加」をタップして完了</span>
              </li>
            </ol>
            <button className={styles.modalOk} onClick={closeIosGuide}>
              わかった
            </button>
          </div>
        </div>
      )}
    </>
  );
}
