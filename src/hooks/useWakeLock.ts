import { useEffect, useRef, useCallback } from 'react';

/**
 * 再生中に画面スリープ（省電力モード）を抑制する
 *
 * 2段階フォールバック:
 *   1. Wake Lock API  — iOS 16.4+ / Chrome / Firefox
 *   2. NoSleep 動画   — iOS 16.3 以下のフォールバック
 *      DOM に 1×1 px のミュート動画（canvas captureStream）を流し続けることで
 *      iOS がスクリーンスリープを抑制する挙動を利用する
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

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && activeRef.current) acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [acquire]);

  // ── NoSleep 動画フォールバック (iOS 16.3 以下) ───────────────────────
  // Wake Lock API が使えない環境でのみ有効化する。
  // ミュート + playsinline の動画はユーザージェスチャなしで再生でき、
  // iOS は DOM 上で動画が再生中のとき画面スリープを抑制する。

  const noSleepVideoRef = useRef<HTMLVideoElement | null>(null);

  // マウント時に動画要素を生成（Wake Lock API が使える環境はスキップ）
  useEffect(() => {
    if ('wakeLock' in navigator) return;

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d')?.fillRect(0, 0, 1, 1);

    let stream: MediaStream;
    try {
      // captureStream は TypeScript の標準定義に含まれないため型アサーション
      stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(1);
    } catch {
      return; // captureStream 非対応（Android 旧世代等）は何もしない
    }

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.loop = true;
    video.style.cssText = [
      'position:fixed', 'top:0', 'left:0',
      'width:1px', 'height:1px',
      'opacity:0.01',            // 完全に opacity:0 だと iOS が最適化でスキップする場合がある
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

  // active 変化に連動して再生 / 一時停止
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
