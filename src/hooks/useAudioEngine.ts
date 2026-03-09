import { useEffect, useRef, useState, useCallback } from 'react';
import { audioEngine, type BeatCallback } from '../engine/AudioEngine';
import { PRESETS, type PresetName, type TotalSteps } from '../engine/presets';
import { toEngineSteps, type ClavePattern } from '../engine/salsaPatterns';

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpmState] = useState(audioEngine.bpm);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [totalSteps, setTotalStepsState] = useState<TotalSteps>(4);
  const [checkedSteps, setCheckedSteps] = useState<Set<number>>(
    new Set(PRESETS['Standard'].pattern)
  );
  const [preset, setPresetState] = useState<PresetName>('Standard');

  // Beat コールバックを最新の状態に保つ（再購読を回避）
  const beatHandlerRef = useRef<BeatCallback | null>(null);
  useEffect(() => {
    beatHandlerRef.current = ({ beat }) => setCurrentBeat(beat);
  });

  useEffect(() => {
    const unsubscribe = audioEngine.onBeat((b) => beatHandlerRef.current?.(b));
    return () => { unsubscribe(); };
  }, []);

  // 初期状態をエンジンに反映
  useEffect(() => {
    audioEngine.setActiveSteps(new Set(PRESETS['Standard'].pattern));
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

  const setTotalSteps = useCallback((steps: TotalSteps) => {
    audioEngine.beatsPerBar = steps;
    audioEngine.subdivision = 1;   // 通常は4分音符
    setTotalStepsState(steps);
    setPresetState('Standard');
    const allSteps = new Set(Array.from({ length: steps }, (_, i) => i));
    setCheckedSteps(allSteps);
    audioEngine.setActiveSteps(allSteps);
  }, []);

  const applyPreset = useCallback((name: PresetName) => {
    const p = PRESETS[name];
    audioEngine.beatsPerBar = p.totalSteps;
    setTotalStepsState(p.totalSteps);
    setPresetState(name);
    const steps = new Set(p.pattern);
    setCheckedSteps(steps);
    audioEngine.setActiveSteps(steps);
  }, []);

  const toggleStep = useCallback((step: number) => {
    setCheckedSteps(prev => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      audioEngine.setActiveSteps(next);
      return next;
    });
    setPresetState('Standard');
  }, []);

  /** Salsa Clave パターンを選んだとき AudioEngine にも反映する (16ステップ = 8分音符) */
  const applyClavePattern = useCallback((pattern: ClavePattern) => {
    const steps = toEngineSteps(pattern.beatPositions);
    audioEngine.beatsPerBar = 16;
    audioEngine.subdivision = 2;   // 1ステップ = 8分音符 (BPM=4分音符基準のまま)
    setTotalStepsState(16);
    setCheckedSteps(steps);
    audioEngine.setActiveSteps(steps);
    setPresetState('Standard');
  }, []);

  const loadAudioFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    await audioEngine.loadBuffer(arrayBuffer);
  }, []);

  return {
    isPlaying, bpm, setBpm,
    currentBeat, totalSteps, setTotalSteps,
    checkedSteps, toggleStep,
    preset, applyPreset,
    applyClavePattern,
    start, stop,
    loadAudioFile,
  };
}
