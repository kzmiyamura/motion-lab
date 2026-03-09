import { useEffect, useRef, useState, useCallback } from 'react';
import { audioEngine, type BeatCallback, type TrackId } from '../engine/AudioEngine';
import { toEngineSteps, type ClavePattern } from '../engine/salsaPatterns';
import { storage } from '../engine/storage';
import { useWakeLock } from './useWakeLock';
import { useMediaSession } from './useMediaSession';

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);
  useWakeLock(isPlaying);
  useMediaSession(isPlaying);
  // BPM: localStorage から復元。なければデフォルト 180（ミディアム）
  const [bpm, setBpmState] = useState<number>(() => {
    const saved = storage.getBpm();
    audioEngine.bpm = saved;
    return saved;
  });
  const [currentBeat, setCurrentBeat] = useState(-1);

  // トラックのミュート状態: localStorage から復元してエンジンにも反映
  const [mutedTracks, setMutedTracks] = useState<Set<TrackId>>(() => {
    const saved = storage.getMutedTracks() as TrackId[];
    const muted = new Set<TrackId>(saved);
    for (const id of muted) audioEngine.setTrackMuted(id, true);
    return muted;
  });

  const beatHandlerRef = useRef<BeatCallback | null>(null);
  useEffect(() => {
    beatHandlerRef.current = ({ beat }) => setCurrentBeat(beat);
  });

  useEffect(() => {
    const unsubscribe = audioEngine.onBeat((b) => beatHandlerRef.current?.(b));
    return () => { unsubscribe(); };
  }, []);

  // バックグラウンドでサンプルをプリロード（失敗時はシンセにフォールバック）
  useEffect(() => {
    audioEngine.loadSamples().catch(() => { /* 合成音にフォールバック済み */ });
  }, []);

  const start = useCallback(() => {
    audioEngine.start();
    setIsPlaying(true);
  }, []);

  const stop = useCallback(() => {
    audioEngine.stop();
    setIsPlaying(false);
    setCurrentBeat(-1);
  }, []);

  const setBpm = useCallback((value: number) => {
    audioEngine.bpm = value;
    setBpmState(value);
    storage.setBpm(value);
  }, []);

  /** Salsa Clave パターンを Clave トラックに適用 */
  const applyClavePattern = useCallback((pattern: ClavePattern) => {
    const steps = toEngineSteps(pattern.beatPositions);
    audioEngine.setTrackPattern('clave', steps);
  }, []);

  const toggleTrackMute = useCallback((id: TrackId) => {
    const nowMuted = audioEngine.toggleTrackMute(id);
    setMutedTracks(prev => {
      const next = new Set(prev);
      if (nowMuted) next.add(id);
      else next.delete(id);
      storage.setMutedTracks([...next]); // 保存
      return next;
    });
  }, []);

  const loadAudioFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    await audioEngine.loadBuffer(arrayBuffer);
  }, []);

  return {
    isPlaying, bpm, setBpm,
    currentBeat,
    mutedTracks, toggleTrackMute,
    applyClavePattern,
    start, stop,
    loadAudioFile,
  };
}
