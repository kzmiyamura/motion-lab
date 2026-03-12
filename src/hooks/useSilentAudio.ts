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

  str(0,  'RIFF'); view.setUint32(4, 36 + dataSize, true);
  str(8,  'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, dataSize, true);

  for (let i = 44; i < buf.byteLength; i += 2) {
    // ±2 LSB ≈ -84 dB — 人間には不可聴、iOS audio session を維持する最小レベル
    view.setInt16(i, Math.round((Math.random() - 0.5) * 4), true);
  }

  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * useSilentAudio
 *
 * バックグラウンド再生を維持するための3層防衛:
 *   1. <audio> 要素で無音 WAV をループ再生
 *   2. Media Session API でロック画面コントロール設定
 *   3. visibilitychange → visible 時に AudioContext.resume() を明示呼び出し
 *
 * ⚠️ visibilitychange ハンドラは一度だけ登録し、ref 経由で現在値を参照する。
 *    依存配列に isPlaying を入れて毎回再登録すると「hidden → visible」間の
 *    React コミット遅延でスタールクロージャが残り、停止済みの音声を
 *    誤って resume してしまうため。
 */
export function useSilentAudio(
  isPlaying: boolean,
  onPlay:   () => void,
  onStop:   () => void,
) {
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef  = useRef<string | null>(null);

  // ── 常に最新の値を保持する ref（ハンドラ内のスタールクロージャを防ぐ）──
  const isPlayingRef = useRef(isPlaying);
  const onPlayRef    = useRef(onPlay);
  const onStopRef    = useRef(onStop);
  isPlayingRef.current = isPlaying;
  onPlayRef.current    = onPlay;
  onStopRef.current    = onStop;

  // ── マウント時に audio 要素を生成（一度のみ）───────────────────────────
  useEffect(() => {
    const url  = createSilentWavUrl();
    blobUrlRef.current = url;

    const audio = new Audio(url);
    audio.loop  = true;
    audioRef.current = audio;

    return () => {
      audio.pause();
      URL.revokeObjectURL(url);
      audioRef.current   = null;
      blobUrlRef.current = null;
    };
  }, []);

  // ── isPlaying に連動して再生 / 一時停止 ─────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [isPlaying]);

  // ── Media Session: OS に「再生中」を通知 ─────────────────────────────────
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (isPlaying) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  'MotionLab — Salsa Rhythm',
        artist: 'Dance Training',
        album:  'MotionLab',
      });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('play',  () => onPlayRef.current());
      navigator.mediaSession.setActionHandler('pause', () => onStopRef.current());
      navigator.mediaSession.setActionHandler('stop',  () => onStopRef.current());
    } else {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, [isPlaying]);

  // ── visibilitychange: マウント時に一度だけ登録、ref で最新値を参照 ───────
  // [isPlaying] に依存させると hidden→visible 間の React コミット遅延で
  // 古いクロージャが残り、停止済みエンジンを誤って resume してしまう。
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== 'visible') return;
      // ref で現在値を確認（スタールクロージャ回避）
      if (!isPlayingRef.current) return;
      // audioEngine.isPlaying も確認：
      // React state が true でもエンジンが既に停止していれば何もしない
      if (!audioEngine.isPlaying) return;

      audioRef.current?.play().catch(() => {});
      audioEngine.resumeIfSuspended();
    };

    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []); // 意図的に空 — ref 経由で常に最新値を参照する

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
