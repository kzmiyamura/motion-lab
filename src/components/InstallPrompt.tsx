import { useInstallPrompt } from '../hooks/useInstallPrompt';
import styles from './InstallPrompt.module.css';

/** iOS Safari の共有ボタン（↑）SVG */
function ShareIcon() {
  return (
    <svg
      className={styles.shareIconSvg}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 16V4M12 4L7 9M12 4l5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 13v6a1 1 0 001 1h14a1 1 0 001-1v-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function InstallPrompt() {
  const { visible, platform, nonSafari, iosGuideOpen, handleInstall, dismiss, closeIosGuide } =
    useInstallPrompt();

  if (!visible) return null;

  return (
    <>
      {/* ── インラインバナー ── */}
      <div className={styles.banner} role="complementary" aria-label="インストール案内">
        <span className={styles.bannerIcon}>{nonSafari ? '🌐' : '📲'}</span>
        <span className={styles.bannerText}>
          {nonSafari
            ? 'Safari で開くとホーム画面に追加してオフラインで使えます'
            : 'ホーム画面に追加してオフラインで使う'}
        </span>
        <button className={styles.installBtn} onClick={handleInstall}>
          {nonSafari ? 'Safariで開く' : '追加'}
        </button>
        <button className={styles.closeBtn} onClick={dismiss} aria-label="閉じる">
          ✕
        </button>
      </div>

      {/* ── iOS Safari ガイドモーダル（画面中央） ── */}
      {platform === 'ios' && !nonSafari && iosGuideOpen && (
        <div
          className={styles.overlay}
          onClick={closeIosGuide}
          role="dialog"
          aria-modal="true"
          aria-label="ホーム画面に追加する方法"
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            {/* 閉じる */}
            <button className={styles.modalClose} onClick={closeIosGuide} aria-label="閉じる">
              ✕
            </button>

            <h2 className={styles.modalTitle}>ホーム画面に追加</h2>
            <p className={styles.modalSub}>
              オフラインでも使えるアプリとして保存できます
            </p>

            {/* Step 1 */}
            <div className={styles.step}>
              <div className={styles.stepNum}>1</div>
              <div className={styles.stepBody}>
                <p className={styles.stepText}>
                  Safari 画面下部の <strong>共有ボタン</strong> をタップ
                </p>
                {/* Safari UI イメージ */}
                <div className={styles.safariBar}>
                  <span className={styles.safariDot} />
                  <span className={styles.safariDot} />
                  <span className={styles.safariBarCenter}>safari.example.com</span>
                  <div className={styles.safariShareHighlight} aria-label="共有ボタン">
                    <ShareIcon />
                  </div>
                  <span className={styles.safariDot} />
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className={styles.step}>
              <div className={styles.stepNum}>2</div>
              <div className={styles.stepBody}>
                <p className={styles.stepText}>
                  下にスクロールして{' '}
                  <strong>「ホーム画面に追加」</strong> をタップ
                </p>
                <div className={styles.menuPreview}>
                  <div className={styles.menuItem}>AirDrop</div>
                  <div className={styles.menuItem}>メッセージ</div>
                  <div className={`${styles.menuItem} ${styles.menuItemHighlight}`}>
                    <span className={styles.menuAddIcon}>＋</span>
                    ホーム画面に追加
                  </div>
                  <div className={styles.menuItem}>ブックマークを追加</div>
                </div>
                <p className={styles.hint}>
                  ※ 見当たらない場合はリストを下端の「編集」から追加できます
                </p>
              </div>
            </div>

            {/* Step 3 */}
            <div className={styles.step}>
              <div className={styles.stepNum}>3</div>
              <div className={styles.stepBody}>
                <p className={styles.stepText}>
                  右上の <strong>「追加」</strong> をタップして完了
                </p>
              </div>
            </div>

            <button className={styles.modalOk} onClick={closeIosGuide}>
              わかった
            </button>
          </div>
        </div>
      )}
    </>
  );
}
