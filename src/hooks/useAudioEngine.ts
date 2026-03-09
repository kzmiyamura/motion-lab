import { useEffect, useRef, useState, useCallback } from 'react';
import { audioEngine, type BeatCallback } from '../engine/AudioEngine';
import { PRESETS, type PresetName, type TotalSteps } from '../engine/presets';
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
  const [totalSteps, setTotalStepsState] = useState<TotalSteps>(16);
  const [checkedSteps, setCheckedSteps] = useState<Set<number>>(
    new Set(PRESETS['Standard'].pattern)
  );
  const [preset, setPresetState] = useState<PresetName>('Standard');

  const beatHandlerRef = useRef<BeatCallback | null>(null);
  useEffect(() => {
    beatHandlerRef.current = ({ beat }) => setCurrentBeat(beat);
  });

  useEffect(() => {
    const unsubscribe = audioEngine.onBeat((b) => beatHandlerRef.current?.(b));
    return () => { unsubscribe(); };
  }, []);

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
    storage.setBpm(value);       // 保存
  }, []);

  const setTotalSteps = useCallback((steps: TotalSteps) => {
    audioEngine.beatsPerBar = steps;
    audioEngine.subdivision = 1;
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

  const applyClavePattern = useCallback((pattern: ClavePattern) => {
    const steps = toEngineSteps(pattern.beatPositions);
    audioEngine.beatsPerBar = 16;
    audioEngine.subdivision = 2;
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
