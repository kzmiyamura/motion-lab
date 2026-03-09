import { useEffect } from 'react';

/**
 * Media Session API フック
 *
 * OS（ロック画面・コントロールセンター）に「音楽再生中」を通知することで
 * バックグラウンドでのオーディオ継続を補助する。
 * 未対応ブラウザでは何もしない。
 */
export function useMediaSession(isPlaying: boolean) {
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (isPlaying) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'MotionLab — Salsa Rhythm',
        artist: 'Dance Training',
        album: 'MotionLab',
      });
      navigator.mediaSession.playbackState = 'playing';
    } else {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, [isPlaying]);

  // アンマウント時にクリア
  useEffect(() => {
    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none';
      }
    };
  }, []);
}
