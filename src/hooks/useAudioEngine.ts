import { useEffect, useRef, useState, useCallback } from 'react';
import { audioEngine, type BeatCallback } from '../engine/AudioEngine';

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpmState] = useState(audioEngine.bpm);
  const [currentBeat, setCurrentBeat] = useState(-1);

  // Keep latest beat callback stable without re-subscribing
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
  }, []);

  const loadAudioFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    await audioEngine.loadBuffer(arrayBuffer);
  }, []);

  return { isPlaying, bpm, setBpm, currentBeat, start, stop, loadAudioFile };
}
