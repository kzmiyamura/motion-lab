import { useEffect, useRef, useState, useCallback } from 'react';
import { audioEngine, type BeatCallback, type TrackId } from '../engine/AudioEngine';
import { toEngineSteps, type ClavePattern } from '../engine/salsaPatterns';
import { storage } from '../engine/storage';

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);
  // BPM: localStorage から復元。なければデフォルト 180（ミディアム）
  const [bpm, setBpmState] = useState<number>(() => {
    const saved = storage.getBpm();
    audioEngine.bpm = saved;
    return saved;
  });
  const [currentBeat, setCurrentBeat] = useState(-1);

  // トラックのミュート状態を React state で管理
  const [mutedTracks, setMutedTracks] = useState<Set<TrackId>>(new Set());

  const beatHandlerRef = useRef<BeatCallback | null>(null);
  useEffect(() => {
    beatHandlerRef.current = ({ beat }) => setCurrentBeat(beat);
  });

  useEffect(() => {
    const unsubscribe = audioEngine.onBeat((b) => beatHandlerRef.current?.(b));
    return () => { unsubscribe(); };
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
