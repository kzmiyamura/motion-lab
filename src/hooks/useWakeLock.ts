import { useEffect, useRef, useCallback } from 'react';

/**
 * 再生中に画面スリープ（省電力モード）を抑制する
 *
 * 3層防衛:
 *   1. Wake Lock API — iOS 16.4+ / Chrome 強制スリープ防止
 *      5 秒ごとのハートビートで解放後も即再取得
 *   2. Silent audio + Media Session — iOS に「メディア再生中」を明示
 *      iOS は active audio session + MediaSession playing 状態を
 *      「ユーザーがメディアを視聴中」と判断してスリープを抑制する
 *      canvas captureStream は iOS が本物のメディアと認識しないため廃止
 *   3. visibilitychange 再取得 — タブ非表示からの復帰時
 */

/** 0.5 秒の無音 WAV Blob URL を生成（useSilentAudio と同じ手法） */
function createSilentAudioUrl(): string {
  const sr = 8000, samples = sr / 2; // 0.5 秒
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  for (let i = 44; i < buf.byteLength; i += 2)
    v.setInt16(i, Math.round((Math.random() - 0.5) * 4), true); // ±2 LSB ≈ -84 dB
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export function useWakeLock(active: boolean) {
  const sentinelRef  = useRef<WakeLockSentinel | null>(null);
  const activeRef    = useRef(active);
  activeRef.current  = active;

  // ── 1. Wake Lock API ─────────────────────────────────────────────────

  const acquire = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    if (sentinelRef.current) return;
    try {
      sentinelRef.current = await navigator.wakeLock.request('screen');
      sentinelRef.current.addEventListener('release', () => {
        sentinelRef.current = null;
      });
    } catch { /* 非対応 or 権限拒否 */ }
  }, []);

  const release = useCallback(() => {
    sentinelRef.current?.release().catch(() => {});
    sentinelRef.current = null;
  }, []);

  useEffect(() => {
    if (active) { acquire(); } else { release(); }
    return release;
  }, [active, acquire, release]);

  // visibilitychange で復帰時に再取得
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && activeRef.current) acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [acquire]);

  // 5 秒ごとのハートビート（全画面切替等で静かに解放された場合も即再取得）
  useEffect(() => {
    const id = setInterval(() => {
      if (activeRef.current && !sentinelRef.current) acquire();
    }, 5_000);
    return () => clearInterval(id);
  }, [acquire]);

  // ── 2. Silent audio + Media Session ──────────────────────────────────
  // canvas captureStream は iOS が本物のメディアと認識しないため使用しない。
  // 代わりに silent WAV ループ再生 + MediaSession playing 状態を設定し、
  // iOS の「メディア再生中」判定を確実にトリガーする。

  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef     = useRef<string | null>(null);

  // マウント時に audio 要素を生成（一度のみ）
  useEffect(() => {
    const url  = createSilentAudioUrl();
    blobUrlRef.current = url;
    const audio = new Audio(url);
    audio.loop = true;
    silentAudioRef.current = audio;
    return () => {
      audio.pause();
      URL.revokeObjectURL(url);
      silentAudioRef.current = null;
      blobUrlRef.current = null;
    };
  }, []);

  // active に連動して再生 / 停止 + MediaSession 更新
  useEffect(() => {
    const audio = silentAudioRef.current;
    if (!audio) return;

    if (active) {
      audio.play().catch(() => {});
      // iOS に「メディア再生中」を通知
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Motion Lab',
          artist: 'Playing',
        });
        navigator.mediaSession.playbackState = 'playing';
      }
    } else {
      audio.pause();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    }
  }, [active]);
}
