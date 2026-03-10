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
  // アプリ内ブラウザ
  if (/Line\//i.test(ua) || /Instagram/i.test(ua) || /FBAN|FBAV/i.test(ua)) return true;
  // iOS 上の Chrome / Firefox / Edge / その他 Chromium 系
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
  const platform = detectPlatform();
  return platform === 'ios' || platform === 'android';
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
    if (!isMobile() || isStandalone()) return;

    const p = detectPlatform();
    const notSafari = detectNonSafariBrowser();
    setPlatform(p);
    setNonSafari(notSafari);

    if (notSafari) {
      // Safari 以外（Chrome iOS / LINE など）: Safari で開くよう誘導
      setVisible(true);
      return;
    }

    if (p === 'ios') {
      setVisible(true);
    }

    // Android: wait for beforeinstallprompt
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
    // LINE: ?openExternalBrowser=1 を付けると Safari で直接開く
    const url = new URL(location.href);
    url.searchParams.set('openExternalBrowser', '1');
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
