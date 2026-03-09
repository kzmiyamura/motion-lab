import { useEffect, useRef } from 'react';
import { audioEngine } from '../engine/AudioEngine';

/**
 * 0.4 秒の無音 WAV を PCM で生成し Blob URL を返す。
 *
 * 16-bit signed PCM, 8 kHz, mono — 完全な無音データ。
 * ±1 LSB のディザ（約 -96 dB）を乗せてブラウザの
 * "silence detection → suspend" 最適化を回避する。
 */
function createSilentWavUrl(): string {
  const sampleRate = 8000;
  const numSamples = 3200;           // 0.4 秒
  const dataSize   = numSamples * 2; // 16-bit = 2 bytes/sample
  const buf  = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  const str = (off: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));

  // RIFF/WAVE ヘッダー
  str(0,  'RIFF'); view.setUint32(4, 36 + dataSize, true);
  str(8,  'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);     // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits/sample
  str(36, 'data'); view.setUint32(40, dataSize, true);

  // ±1 LSB ディザ（-96 dB 相当、人間には完全に聴こえない）
  for (let i = 44; i < buf.byteLength; i += 2) {
    view.setInt16(i, Math.round((Math.random() - 0.5) * 2), true);
  }

  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * useSilentAudio
 *
 * バックグラウンド再生を維持するための3層防衛:
 *   1. <audio> 要素で無音 WAV をループ再生
 *      → ブラウザ/OS が「メディア再生中」と認識する
 *   2. navigator.mediaSession の metadata + action handler を設定
 *      → ロック画面・コントロールセンターに再生コントロールを表示
 *   3. visibilitychange → visible 時に AudioContext.resume() を明示呼び出し
 *      → iOS Safari による強制 suspend から復帰
 */
export function useSilentAudio(
  isPlaying: boolean,
  onPlay:   () => void,
  onStop:   () => void,
) {
  const audioRef   = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // ── マウント時に audio 要素を生成 ────────────────────────────────────────
  useEffect(() => {
    const url   = createSilentWavUrl();
    blobUrlRef.current = url;

    const audio = new Audio(url);
    audio.loop  = true;
    // volume はデフォルト(1.0)のまま。WAV データ自体が無音なので出力は 0。
    // volume=0 にするとブラウザが "muted media" と判断し Media Session を
    // 無効化するブラウザがあるため設定しない。
    audioRef.current = audio;

    return () => {
      audio.pause();
      URL.revokeObjectURL(url);
      audioRef.current  = null;
      blobUrlRef.current = null;
    };
  }, []);

  // ── isPlaying に連動して再生/一時停止 ─────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      // ユーザー操作(Start クリック)後なので autoplay ポリシーは通過する
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [isPlaying]);

  // ── Media Session: OS に「再生中」を通知 + ロック画面コントロール設定 ─────
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (isPlaying) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  'MotionLab — Salsa Rhythm',
        artist: 'Dance Training',
        album:  'MotionLab',
      });
      navigator.mediaSession.playbackState = 'playing';

      // ロック画面の再生/停止ボタンと AudioEngine を紐付け
      navigator.mediaSession.setActionHandler('play',  () => onPlay());
      navigator.mediaSession.setActionHandler('pause', () => onStop());
      navigator.mediaSession.setActionHandler('stop',  () => onStop());
    } else {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, [isPlaying, onPlay, onStop]);

  // ── visibilitychange: 復帰時に AudioContext を明示 resume ─────────────────
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isPlaying) return;

      // 1. <audio> が iOS で止まっていれば再開
      audioRef.current?.play().catch(() => {});

      // 2. AudioContext が OS に suspend させられていれば resume
      audioEngine.resumeIfSuspended();
    };

    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [isPlaying]);

  // ── アンマウント時に Media Session をクリア ─────────────────────────────
  useEffect(() => {
    return () => {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.setActionHandler('play',  null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('stop',  null);
    };
  }, []);
}
