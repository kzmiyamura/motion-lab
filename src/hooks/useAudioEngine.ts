import { useEffect, useRef, useState, useCallback } from 'react';
import { audioEngine, type BeatCallback, type TrackId } from '../engine/AudioEngine';
import { CLAVE_PATTERNS, CLAVE_FLIP_MAP, toEngineSteps, type ClavePattern } from '../engine/salsaPatterns';
import { BACHATA_PATTERNS } from '../engine/bachataPatterns';
import { storage } from '../engine/storage';
import { useWakeLock } from './useWakeLock';
import { useSilentAudio } from './useSilentAudio';

export type Genre = 'salsa' | 'bachata';

/** 現在のスキーマで有効な TrackId 一覧 */
const VALID_TRACK_IDS: readonly TrackId[] = [
  'clave',
  'conga-open', 'conga-slap', 'conga-heel',
  'cowbell-low', 'cowbell-high',
  'bongo-low', 'bongo-high', 'guira', 'bass',
];

const CONGA_IDS:   readonly TrackId[] = ['conga-open', 'conga-slap', 'conga-heel'];
const COWBELL_IDS: readonly TrackId[] = ['cowbell-low', 'cowbell-high'];
const BONGO_IDS:   readonly TrackId[] = ['bongo-low', 'bongo-high'];

const GENRE_DEFAULT_BPM: Record<Genre, number> = { salsa: 180, bachata: 120 };

// ジャンル切替時のデフォルトミュート
const SALSA_DEFAULT_MUTED:   TrackId[] = [
  'conga-open', 'conga-slap', 'conga-heel', 'cowbell-low', 'cowbell-high',
  'bongo-low', 'bongo-high', 'guira', 'bass',
];
const BACHATA_DEFAULT_MUTED: TrackId[] = [
  'clave', 'conga-open', 'conga-slap', 'conga-heel', 'cowbell-low', 'cowbell-high',
];

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);

  const start = useCallback(() => {
    audioEngine.start().then(() => setIsPlaying(true));
  }, []);

  const stop = useCallback(() => {
    audioEngine.stop(); // engine.stop() already cancels flip
    setIsPlaying(false);
    setCurrentBeat(-1);
    setFlipPending(false);
    flipTargetRef.current = null;
  }, []);

  useWakeLock(isPlaying);
  useSilentAudio(isPlaying, start, stop);

  // BPM
  const [bpm, setBpmState] = useState<number>(() => {
    const saved = storage.getBpm();
    audioEngine.bpm = saved;
    return saved;
  });
  const [currentBeat, setCurrentBeat] = useState(-1);

  // Clave pattern (moved from App.tsx)
  const [selectedPattern, setSelectedPatternState] = useState<ClavePattern>(() => {
    const savedId = storage.getPatternId();
    const pattern = CLAVE_PATTERNS.find(p => p.id === savedId) ?? CLAVE_PATTERNS[0];
    audioEngine.setTrackPattern('clave', toEngineSteps(pattern.beatPositions));
    return pattern;
  });
  const selectedPatternRef = useRef(selectedPattern);
  selectedPatternRef.current = selectedPattern;

  // Muted tracks
  const [mutedTracks, setMutedTracks] = useState<Set<TrackId>>(() => {
    const savedGenre = storage.getGenre();
    const saved = storage.getMutedTracks().filter(
      (id): id is TrackId => (VALID_TRACK_IDS as string[]).includes(id),
    );
    const muted = new Set<TrackId>(saved);
    // 新規追加トラック（保存済みリストにないもの）はデフォルトをジャンル別に適用
    const genreDefaults = savedGenre === 'salsa' ? SALSA_DEFAULT_MUTED : BACHATA_DEFAULT_MUTED;
    for (const id of genreDefaults) {
      if (!saved.includes(id)) muted.add(id);
    }
    for (const id of VALID_TRACK_IDS) {
      audioEngine.setTrackMuted(id, muted.has(id));
    }
    return muted;
  });

  // Genre
  const [genre, setGenreState] = useState<Genre>(() => {
    const g = storage.getGenre();
    document.documentElement.setAttribute('data-genre', g);
    return g;
  });

  // Bachata complexity (0-based index into BACHATA_PATTERNS)
  const DEFAULT_BACHATA_COMPLEXITY = 2; // Doble
  const [bachataComplexity, setBachataComplexityState] = useState(DEFAULT_BACHATA_COMPLEXITY);

  /** Apply a Bachata pattern by its 0-based index and update engine tracks. */
  const applyBachataPattern = useCallback((index: number) => {
    const p = BACHATA_PATTERNS[index];
    if (!p) return;
    audioEngine.setTrackPattern('bongo-low',  new Set(p.bongoLow));
    audioEngine.setTrackPattern('bongo-high', new Set(p.bongoHigh));
    audioEngine.setTrackPattern('guira',      new Set(p.guira));
    audioEngine.setTrackPattern('bass',       new Set(p.bass));
    audioEngine.setTrackArticulation('bongo-low',  p.bongoLowArticulation);
    audioEngine.setTrackArticulation('bongo-high', p.bongoHighArticulation);
  }, []);

  // Apply default pattern once on mount (when genre === 'bachata')
  useEffect(() => {
    if (storage.getGenre() === 'bachata') {
      applyBachataPattern(DEFAULT_BACHATA_COMPLEXITY);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setBachataComplexity = useCallback((index: number) => {
    setBachataComplexityState(index);
    applyBachataPattern(index);
  }, [applyBachataPattern]);

  // Master volume
  const [masterVolume, setMasterVolumeState] = useState<number>(() => {
    const saved = storage.getMasterVolume();
    audioEngine.masterVolume = saved;
    return saved;
  });

  const setMasterVolume = useCallback((value: number) => {
    audioEngine.masterVolume = value;
    setMasterVolumeState(value);
    storage.setMasterVolume(value);
  }, []);

  // Background play
  const [backgroundPlay, setBackgroundPlayState] = useState<boolean>(
    () => storage.getBackgroundPlay()
  );
  const backgroundPlayRef = useRef(backgroundPlay);
  backgroundPlayRef.current = backgroundPlay;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Flip state
  const [flipPending, setFlipPending] = useState(false);
  const [flipTarget, setFlipTarget] = useState<ClavePattern | null>(null);
  const flipTargetRef = useRef<ClavePattern | null>(null);

  // Random flip
  const [randomFlipMode, setRandomFlipModeState] = useState(false);
  const randomFlipModeRef = useRef(false);
  const barCountRef = useRef(0);
  const nextFlipBarRef = useRef(0);

  const beatHandlerRef = useRef<BeatCallback | null>(null);
  useEffect(() => {
    beatHandlerRef.current = ({ beat }) => setCurrentBeat(beat);
  });

  useEffect(() => {
    const unsubscribe = audioEngine.onBeat((b) => beatHandlerRef.current?.(b));
    return () => { unsubscribe(); };
  }, []);

  // サンプル読み込み状態
  const [samplesReady, setSamplesReady] = useState(false);
  const [samplesOffline, setSamplesOffline] = useState(false);

  // サンプルをプリロード — 結果に応じてオフライン通知を出す
  useEffect(() => {
    audioEngine.loadSamples()
      .then(() => {
        setSamplesReady(audioEngine.samplesReady);
        if (!audioEngine.samplesReady) setSamplesOffline(true);
      })
      .catch(() => setSamplesOffline(true));
  }, []);

  // バックグラウンド制御
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        if (!backgroundPlayRef.current && isPlayingRef.current) {
          audioEngine.stop();
          setIsPlaying(false);
          setCurrentBeat(-1);
          setFlipPending(false);
          flipTargetRef.current = null;
        }
      } else if (document.visibilityState === 'visible') {
        if (!audioEngine.isPlaying && isPlayingRef.current) {
          setIsPlaying(false);
          setCurrentBeat(-1);
        }
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // フリップ実行コールバック
  useEffect(() => {
    const unsub = audioEngine.onFlip(() => {
      const target = flipTargetRef.current;
      if (target) {
        setSelectedPatternState(target);
        storage.setPatternId(target.id);
        setFlipTarget(target); // briefly keep for indicator fade
        flipTargetRef.current = null;
      }
      setFlipPending(false);
    });
    return () => { unsub(); };
  }, []);

  // ランダムフリップ: バーカウント + 自動リクエスト
  useEffect(() => {
    const unsub = audioEngine.onBeat(({ beat }) => {
      if (beat !== 0) return;
      barCountRef.current++;
      if (!randomFlipModeRef.current) return;
      if (audioEngine.pendingFlip) return;
      if (barCountRef.current < nextFlipBarRef.current) return;
      // requestFlip (inline to avoid circular ref)
      const pairedId = CLAVE_FLIP_MAP[selectedPatternRef.current.id];
      if (!pairedId) return;
      const target = CLAVE_PATTERNS.find(p => p.id === pairedId);
      if (!target) return;
      flipTargetRef.current = target;
      audioEngine.requestFlip(toEngineSteps(target.beatPositions));
      setFlipPending(true);
      setFlipTarget(target);
      nextFlipBarRef.current = barCountRef.current + 4 + Math.floor(Math.random() * 8);
    });
    return () => { unsub(); };
  }, []);

  const setBpm = useCallback((value: number) => {
    audioEngine.bpm = value;
    setBpmState(value);
    storage.setBpm(value);
  }, []);

  const setBackgroundPlay = useCallback((value: boolean) => {
    setBackgroundPlayState(value);
    storage.setBackgroundPlay(value);
  }, []);

  const handlePatternSelect = useCallback((pattern: ClavePattern) => {
    audioEngine.cancelFlip();
    setSelectedPatternState(pattern);
    audioEngine.setTrackPattern('clave', toEngineSteps(pattern.beatPositions));
    storage.setPatternId(pattern.id);
    setFlipPending(false);
    setFlipTarget(null);
    flipTargetRef.current = null;
  }, []);

  /** Flip Clave: 次のバー境界でクラーベ反転 */
  const requestFlip = useCallback(() => {
    if (!audioEngine.isPlaying) return;
    if (audioEngine.pendingFlip) return;
    const pairedId = CLAVE_FLIP_MAP[selectedPatternRef.current.id];
    if (!pairedId) return;
    const target = CLAVE_PATTERNS.find(p => p.id === pairedId);
    if (!target) return;
    flipTargetRef.current = target;
    audioEngine.requestFlip(toEngineSteps(target.beatPositions));
    setFlipPending(true);
    setFlipTarget(target);
  }, []);

  const setRandomFlipMode = useCallback((value: boolean) => {
    randomFlipModeRef.current = value;
    setRandomFlipModeState(value);
    if (value) {
      barCountRef.current = 0;
      nextFlipBarRef.current = 4 + Math.floor(Math.random() * 8);
    }
  }, []);

  const toggleTrackMute = useCallback((id: TrackId) => {
    const nowMuted = audioEngine.toggleTrackMute(id);
    setMutedTracks(prev => {
      const next = new Set(prev);
      if (nowMuted) next.add(id);
      else next.delete(id);
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  const toggleCongaMute = useCallback(() => {
    setMutedTracks(prev => {
      const mute = !CONGA_IDS.every(id => prev.has(id));
      for (const id of CONGA_IDS) audioEngine.setTrackMuted(id, mute);
      const next = new Set(prev);
      for (const id of CONGA_IDS) {
        if (mute) next.add(id); else next.delete(id);
      }
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  const toggleCowbellMute = useCallback(() => {
    setMutedTracks(prev => {
      const mute = !COWBELL_IDS.every(id => prev.has(id));
      for (const id of COWBELL_IDS) audioEngine.setTrackMuted(id, mute);
      const next = new Set(prev);
      for (const id of COWBELL_IDS) {
        if (mute) next.add(id); else next.delete(id);
      }
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  const toggleBongoMute = useCallback(() => {
    setMutedTracks(prev => {
      const mute = !BONGO_IDS.every(id => prev.has(id));
      for (const id of BONGO_IDS) audioEngine.setTrackMuted(id, mute);
      const next = new Set(prev);
      for (const id of BONGO_IDS) {
        if (mute) next.add(id); else next.delete(id);
      }
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  const toggleGuiraMute = useCallback(() => {
    const nowMuted = audioEngine.toggleTrackMute('guira');
    setMutedTracks(prev => {
      const next = new Set(prev);
      if (nowMuted) next.add('guira'); else next.delete('guira');
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  const setGenre = useCallback((g: Genre) => {
    const muted = g === 'salsa' ? SALSA_DEFAULT_MUTED : BACHATA_DEFAULT_MUTED;
    const mutedSet = new Set<TrackId>(muted);
    for (const id of VALID_TRACK_IDS) {
      audioEngine.setTrackMuted(id, mutedSet.has(id));
    }
    setMutedTracks(mutedSet);
    storage.setMutedTracks([...mutedSet]);
    // BPM をジャンルデフォルトに変更
    const newBpm = GENRE_DEFAULT_BPM[g];
    audioEngine.bpm = newBpm;
    setBpmState(newBpm);
    storage.setBpm(newBpm);
    document.documentElement.setAttribute('data-genre', g);
    setGenreState(g);
    storage.setGenre(g);
    // Bachata に切り替えたときはデフォルトパターンを適用してスライダーをリセット
    if (g === 'bachata') {
      setBachataComplexityState(DEFAULT_BACHATA_COMPLEXITY);
      applyBachataPattern(DEFAULT_BACHATA_COMPLEXITY);
    }
  }, [applyBachataPattern]);

  const loadAudioFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    await audioEngine.loadBuffer(arrayBuffer);
  }, []);

  // Loudness (DynamicsCompressor)
  const [loudness, setLoudnessState] = useState<boolean>(() => {
    const saved = storage.getLoudness();
    audioEngine.loudness = saved;
    return saved;
  });

  const setLoudness = useCallback((value: boolean) => {
    audioEngine.loudness = value;
    setLoudnessState(value);
    storage.setLoudness(value);
  }, []);

  const congaMuted   = CONGA_IDS.every(id => mutedTracks.has(id));
  const cowbellMuted = COWBELL_IDS.every(id => mutedTracks.has(id));
  const bongoMuted   = BONGO_IDS.every(id => mutedTracks.has(id));
  const guiraMuted   = mutedTracks.has('guira');

  return {
    isPlaying, bpm, setBpm,
    masterVolume, setMasterVolume,
    currentBeat,
    selectedPattern, handlePatternSelect,
    flipPending, flipTarget, requestFlip,
    randomFlipMode, setRandomFlipMode,
    mutedTracks, toggleTrackMute,
    congaMuted,   toggleCongaMute,
    cowbellMuted, toggleCowbellMute,
    bongoMuted,   toggleBongoMute,
    guiraMuted,   toggleGuiraMute,
    backgroundPlay, setBackgroundPlay,
    loudness, setLoudness,
    genre, setGenre,
    bachataComplexity, setBachataComplexity,
    samplesReady, samplesOffline,
    start, stop,
    loadAudioFile,
  };
}
