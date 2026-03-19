import { useEffect, useRef, useCallback } from 'react';

/**
 * 再生中に画面スリープ（省電力モード）を抑制する
 * Wake Lock API 非対応環境では無音で無効化される
 *
 * @param active  true のとき Wake Lock を要求し、false で解放する
 */
export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const activeRef   = useRef(active);
  activeRef.current = active;

  const acquire = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    if (sentinelRef.current) return; // 既に保持中
    try {
      sentinelRef.current = await navigator.wakeLock.request('screen');
      // ブラウザ側で自動解放されたとき（タブ非表示など）参照をクリア
      sentinelRef.current.addEventListener('release', () => {
        sentinelRef.current = null;
      });
    } catch {
      /* 非対応 or 権限拒否 — 無視 */
    }
  }, []);

  const release = useCallback(() => {
    sentinelRef.current?.release().catch(() => {});
    sentinelRef.current = null;
  }, []);

  // active が変わったとき取得 / 解放
  useEffect(() => {
    if (active) {
      acquire();
    } else {
      release();
    }
    return release; // アンマウント時も解放
  }, [active, acquire, release]);

  // タブが前面に戻ったとき再取得（非表示で自動解放されるため）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && activeRef.current) {
        acquire();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [acquire]);
}
