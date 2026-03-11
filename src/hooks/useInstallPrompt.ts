import { useEffect, useState, useCallback } from 'react';

type Platform = 'android' | 'ios' | 'other';

/**
 * Safari 以外の iOS ブラウザかどうか。
 * - LINE / Instagram / Facebook などのアプリ内ブラウザ
 * - Chrome iOS (CriOS) / Firefox iOS (FxiOS) など
 * これらは iOS の制限により「ホーム画面に追加」ができない。
 */
function detectNonSafariBrowser(): boolean {
  const ua = navigator.userAgent;
  if (/Line\//i.test(ua) || /Instagram/i.test(ua) || /FBAN|FBAV/i.test(ua)) return true;
  if (/CriOS/i.test(ua) || /FxiOS/i.test(ua) || /EdgiOS/i.test(ua)) return true;
  return false;
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'other';
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isMobile(): boolean {
  return detectPlatform() !== 'other';
}

/** localhost または ?debug_pwa=true の場合にデバッグ表示を強制する */
function isDebugMode(): boolean {
  return (
    location.hostname === 'localhost' ||
    new URLSearchParams(location.search).has('debug_pwa')
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function useInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform>('other');
  const [nonSafari, setNonSafari] = useState(false);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const debug = isDebugMode();

    // デバッグモード: モバイル判定・スタンドアロン判定をスキップして強制表示
    if (debug) {
      const p = detectPlatform();
      setPlatform(p === 'other' ? 'ios' : p); // PCデバッグ時は ios として扱う
      setNonSafari(false);
      setVisible(true);
    }

    if (!debug && (!isMobile() || isStandalone())) return;

    const p = detectPlatform();
    const notSafari = detectNonSafariBrowser();
    setPlatform(p);
    setNonSafari(notSafari);

    if (notSafari) {
      setVisible(true);
      return;
    }

    if (p === 'ios') {
      setVisible(true);
    }

    // Android: beforeinstallprompt を待つ
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', handler);

    const appInstalled = () => setVisible(false);
    window.addEventListener('appinstalled', appInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', appInstalled);
    };
  }, []);

  const openInSafari = useCallback(() => {
    const url = new URL(location.href);
    url.searchParams.set('openExternalBrowser', '1');
    // デバッグパラメータは引き継がない
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
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setVisible(false);
    setDeferredPrompt(null);
  }, [nonSafari, platform, deferredPrompt, openInSafari]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setIosGuideOpen(false);
  }, []);

  const closeIosGuide = useCallback(() => {
    setIosGuideOpen(false);
  }, []);

  return { visible, platform, nonSafari, iosGuideOpen, handleInstall, dismiss, closeIosGuide };
}
