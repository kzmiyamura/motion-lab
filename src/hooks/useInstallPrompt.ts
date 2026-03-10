import { useEffect, useState, useCallback } from 'react';

type Platform = 'android' | 'ios' | 'other';

/** LINE / Instagram / Facebook 等のアプリ内ブラウザかどうか */
function detectInAppBrowser(): boolean {
  const ua = navigator.userAgent;
  return /Line\//i.test(ua) || /Instagram/i.test(ua) || /FBAN|FBAV/i.test(ua);
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
  const [inAppBrowser, setInAppBrowser] = useState(false);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (!isMobile() || isStandalone()) return;

    const p = detectPlatform();
    const inApp = detectInAppBrowser();
    setPlatform(p);
    setInAppBrowser(inApp);

    if (inApp) {
      // アプリ内ブラウザ: Safari で開くよう誘導するバナーを表示
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
    if (inAppBrowser) {
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
  }, [inAppBrowser, platform, deferredPrompt, openInSafari]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setIosGuideOpen(false);
  }, []);

  const closeIosGuide = useCallback(() => {
    setIosGuideOpen(false);
  }, []);

  return { visible, platform, inAppBrowser, iosGuideOpen, handleInstall, dismiss, closeIosGuide };
}
