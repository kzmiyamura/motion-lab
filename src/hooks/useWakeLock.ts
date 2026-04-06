import { useEffect, useRef, useCallback } from 'react';

/**
 * 再生中に画面スリープ（省電力モード）を抑制する
 *
 * 2つのアプローチを同時に使用（どちらかが効けば OK）:
 *   1. Wake Lock API  — iOS 16.4+ / Chrome / Firefox
 *      - visibilitychange で解放後に再取得
 *      - 15 秒ごとのハートビートで静かに解放された場合も再取得
 *   2. NoSleep 動画   — 全デバイス共通（Wake Lock の補強）
 *      DOM に 1×1 px のミュート動画を流し続けることで
 *      iOS が「動画再生中」と認識しスクリーンスリープを抑制する
 *
 * @param active  true のとき Wake Lock を要求し、false で解放する
 */
export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const activeRef   = useRef(active);
  activeRef.current = active;

  // ── Wake Lock API (iOS 16.4+, Chrome, Firefox) ───────────────────────

  const acquire = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    if (sentinelRef.current) return;
    try {
      sentinelRef.current = await navigator.wakeLock.request('screen');
      sentinelRef.current.addEventListener('release', () => {
        sentinelRef.current = null;
      });
    } catch { /* 非対応 or 権限拒否 — 無視 */ }
  }, []);

  const release = useCallback(() => {
    sentinelRef.current?.release().catch(() => {});
    sentinelRef.current = null;
  }, []);

  useEffect(() => {
    if (active) { acquire(); } else { release(); }
    return release;
  }, [active, acquire, release]);

  // タブが前面に戻ったとき再取得（非表示で自動解放されるため）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && activeRef.current) acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [acquire]);

  // 15 秒ごとのハートビート：全画面切替等で静かに解放された場合も再取得する
  // visibilitychange が発火しない状況（theater モード等）をカバー
  useEffect(() => {
    const id = setInterval(() => {
      if (activeRef.current && !sentinelRef.current) acquire();
    }, 15_000);
    return () => clearInterval(id);
  }, [acquire]);

  // ── NoSleep 動画（全デバイス共通・Wake Lock の補強）─────────────────
  // Wake Lock API の有無に関わらず常に使用する。
  // ミュート + playsinline の動画が DOM で再生されている間、
  // iOS は「メディア再生中」として画面スリープを抑制する。

  const noSleepVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d')?.fillRect(0, 0, 1, 1);

    let stream: MediaStream;
    try {
      stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(1);
    } catch {
      return; // captureStream 非対応環境は何もしない
    }

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.loop = true;
    video.style.cssText = [
      'position:fixed', 'top:0', 'left:0',
      'width:1px', 'height:1px',
      'opacity:0.01',         // 完全 opacity:0 だと iOS が最適化でスキップする場合がある
      'pointer-events:none',
      'z-index:-1',
    ].join(';');
    document.body.appendChild(video);
    noSleepVideoRef.current = video;

    return () => {
      video.pause();
      video.srcObject = null;
      video.remove();
      noSleepVideoRef.current = null;
    };
  }, []);

  useEffect(() => {
    const video = noSleepVideoRef.current;
    if (!video) return;
    if (active) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [active]);
}
