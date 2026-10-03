import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { loadPrefs, savePrefs, type PracticePrefs } from '../engine/practice';

/** 練習の設定（速さ・クリック・声・動画の音）。端末に覚えておく */
export function usePracticePrefs(): [PracticePrefs, (patch: Partial<PracticePrefs>) => void] {
  const [prefs, setPrefs] = useState<PracticePrefs>(loadPrefs);
  const update = useCallback((patch: Partial<PracticePrefs>) => {
    setPrefs(p => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);
  return [prefs, update];
}

/**
 * 元動画を <video> に読み込む（Safari は HLS をそのまま、それ以外は hls.js を遅延読み込み）。
 * src が null・読み込めない・再生エラーのときは failed = true（呼び出し側はカウントだけの練習に切り替える）
 */
export function useVideoSource(videoRef: RefObject<HTMLVideoElement | null>, src: string | null): boolean {
  const [failed, setFailed] = useState(!src);
  useEffect(() => {
    const video = videoRef.current;
    if (!src) { setFailed(true); return; }
    if (!video) return;
    setFailed(false);
    let destroyed = false;
    let hls: { destroy: () => void } | null = null;
    const onError = () => { if (!destroyed) setFailed(true); };
    video.addEventListener('error', onError);
    const isHls = /\.m3u8(\?|$)/.test(src);
    if (!isHls || video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) { setFailed(true); return; }
        const h = new Hls();
        hls = h;
        h.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) onError(); });
        h.loadSource(src);
        h.attachMedia(video);
      }).catch(onError);
    }
    return () => {
      destroyed = true;
      video.removeEventListener('error', onError);
      hls?.destroy();
      video.removeAttribute('src');
      try { video.load(); } catch { /* jsdom */ }
    };
  }, [videoRef, src]);
  return failed;
}

/** 画面が隠れた（ロック・別アプリ・タブ切替）ときに呼ぶ。ref 経由で常に最新の関数を呼ぶ */
export function useOnHidden(onHidden: () => void): void {
  const ref = useRef(onHidden);
  useLayoutEffect(() => { ref.current = onHidden; });
  useEffect(() => {
    const h = () => { if (document.visibilityState === 'hidden') ref.current(); };
    const ph = () => ref.current();
    document.addEventListener('visibilitychange', h);
    window.addEventListener('pagehide', ph);
    return () => {
      document.removeEventListener('visibilitychange', h);
      window.removeEventListener('pagehide', ph);
    };
  }, []);
}
