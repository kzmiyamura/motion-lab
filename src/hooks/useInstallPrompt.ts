import { useEffect, useState, useCallback } from 'react';

type Platform = 'android' | 'ios' | 'other';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'other';
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari sets this when launched from home screen
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
  // Show only on mobile, not in standalone mode
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform>('other');
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (!isMobile() || isStandalone()) return;

    const p = detectPlatform();
    setPlatform(p);

    if (p === 'ios') {
      // iOS: always show banner (no beforeinstallprompt)
      setVisible(true);
    }

    // Android: wait for beforeinstallprompt
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Hide if installed
    const appInstalled = () => setVisible(false);
    window.addEventListener('appinstalled', appInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', appInstalled);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    if (platform === 'ios') {
      setIosGuideOpen(true);
      return;
    }
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setVisible(false);
    setDeferredPrompt(null);
  }, [platform, deferredPrompt]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setIosGuideOpen(false);
  }, []);

  const closeIosGuide = useCallback(() => {
    setIosGuideOpen(false);
  }, []);

  return { visible, platform, iosGuideOpen, handleInstall, dismiss, closeIosGuide };
}
