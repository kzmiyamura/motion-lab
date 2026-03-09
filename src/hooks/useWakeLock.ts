import { useEffect, useRef } from 'react';

/**
 * Screen Wake Lock API フック
 *
 * isPlaying が true の間、画面のスリープを防ぐ。
 * タブ切り替えで自動解除された場合は復帰時に再取得する。
 * 未対応ブラウザでは何もしない（クラッシュしない）。
 */
export function useWakeLock(isPlaying: boolean) {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  // Wake Lock を取得する。失敗してもアプリには影響させない
  async function acquire() {
    if (!('wakeLock' in navigator)) return;
    try {
      lockRef.current = await navigator.wakeLock.request('screen');
    } catch {
      // 省電力モードや権限拒否など — 無視して続行
    }
  }

  // Wake Lock を解放する
  async function release() {
    if (!lockRef.current) return;
    try {
      await lockRef.current.release();
    } catch {
      // already released など — 無視
    } finally {
      lockRef.current = null;
    }
  }

  // isPlaying に連動して取得 / 解放
  useEffect(() => {
    if (isPlaying) {
      acquire();
    } else {
      release();
    }
    // アンマウント時にも確実に解放
    return () => { release(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // タブを離れると OS が自動で Wake Lock を解除するので、
  // 戻ってきたときに再生中なら再取得する
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && isPlaying) {
        acquire();
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);
}
