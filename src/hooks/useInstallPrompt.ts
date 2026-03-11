import { useEffect, useState, useCallback } from 'react';

type Platform = 'android' | 'ios' | 'other';

const DISMISSED_KEY = 'pwa_install_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// ─── 判定ユーティリティ ───────────────────────────────────────────────────────

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'other';
}

/**
 * iOS でも Safari 以外のブラウザ（Chrome iOS / LINE 等）かどうか。
 * これらは iOS の制限で「ホーム画面に追加」ができないため Safari へ誘導する。
 */
function detectNonSafariBrowser(): boolean {
  const ua = navigator.userAgent;
  // アプリ内ブラウザ
  if (/Line\//i.test(ua) || /Instagram/i.test(ua) || /FBAN|FBAV/i.test(ua)) return true;
  // Chrome / Firefox / Edge iOS
  if (/CriOS/i.test(ua) || /FxiOS/i.test(ua) || /EdgiOS/i.test(ua)) return true;
  return false;
}

/** PWA としてホーム画面から起動中かどうか */
function isStandalone(): boolean {
  // iOS Safari: navigator.standalone が最も信頼性が高い
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  // Android / その他
  return window.matchMedia('(display-mode: standalone)').matches;
}

/** localhost または ?debug_pwa=true で強制表示するデバッグモード */
function isDebugMode(): boolean {
  return (
    location.hostname === 'localhost' ||
    new URLSearchParams(location.search).has('debug_pwa')
  );
}

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveDismissed(): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch { /* ignore */ }
}

// ─── フック ──────────────────────────────────────────────────────────────────

export function useInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform>('other');
  const [nonSafari, setNonSafari] = useState(false);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const debug = isDebugMode();

    // デバッグモード: 条件を全スキップして強制表示（UI確認用）
    if (debug) {
      const p = detectPlatform();
      setPlatform(p === 'other' ? 'ios' : p);
      setNonSafari(false);
      setVisible(true);
      return; // ← debug の場合はここで終了
    }

    // すでに今セッションで閉じた場合は表示しない
    if (wasDismissed()) return;

    const p = detectPlatform();
    const notSafari = detectNonSafariBrowser();
    setPlatform(p);
    setNonSafari(notSafari);

    // ── iOS ──────────────────────────────────────────────────────────────────
    if (p === 'ios') {
      // スタンドアロン（ホーム画面から起動中）は表示不要
      if (isStandalone()) return;

      // Safari 以外（Chrome iOS / LINE 等）→ Safari で開くよう誘導
      // Safari → ホーム画面追加手順を案内（即時表示）
      setVisible(true);
      return;
    }

    // ── Android ──────────────────────────────────────────────────────────────
    if (p === 'android') {
      if (isStandalone()) return;

      const handler = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e as BeforeInstallPromptEvent);
        setVisible(true);
      };
      window.addEventListener('beforeinstallprompt', handler);

      const appInstalled = () => {
        setVisible(false);
        saveDismissed();
      };
      window.addEventListener('appinstalled', appInstalled);

      return () => {
        window.removeEventListener('beforeinstallprompt', handler);
        window.removeEventListener('appinstalled', appInstalled);
      };
    }
  }, []);

  const openInSafari = useCallback(() => {
    const url = new URL(location.href);
    url.searchParams.set('openExternalBrowser', '1');
    url.searchParams.delete('debug_pwa');
    location.href = url.toString();
  }, []);

  const handleInstall = useCallback(async () => {
    if (nonSafari) {
      openInSafari();
      return;
    }
    if (platform === 'ios') {
      setIosGuideOpen(true);
      return;
    }
    // Android
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setVisible(false);
      saveDismissed();
    }
    setDeferredPrompt(null);
  }, [nonSafari, platform, deferredPrompt, openInSafari]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setIosGuideOpen(false);
    saveDismissed();
  }, []);

  const closeIosGuide = useCallback(() => {
    setIosGuideOpen(false);
  }, []);

  return { visible, platform, nonSafari, iosGuideOpen, handleInstall, dismiss, closeIosGuide };
}
