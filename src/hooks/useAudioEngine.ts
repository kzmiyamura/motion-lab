import { useEffect, useRef, useState, useCallback } from 'react';
import { audioEngine, type BeatCallback, type TrackId } from '../engine/AudioEngine';
import { toEngineSteps, type ClavePattern } from '../engine/salsaPatterns';
import { storage } from '../engine/storage';
import { useWakeLock } from './useWakeLock';
import { useSilentAudio } from './useSilentAudio';

/** 現在のスキーマで有効な TrackId 一覧 — 旧データの不正 ID をフィルタするため */
const VALID_TRACK_IDS: readonly TrackId[] = [
  'clave',
  'conga-open', 'conga-slap', 'conga-heel',
  'cowbell-low', 'cowbell-high',
];

const CONGA_IDS:   readonly TrackId[] = ['conga-open', 'conga-slap', 'conga-heel'];
const COWBELL_IDS: readonly TrackId[] = ['cowbell-low', 'cowbell-high'];

export function useAudioEngine() {
  const [isPlaying, setIsPlaying] = useState(false);

  // start/stop を先に定義 → useSilentAudio の action handler に渡すため
  const start = useCallback(() => {
    audioEngine.start();
    setIsPlaying(true);
  }, []);

  const stop = useCallback(() => {
    audioEngine.stop();
    setIsPlaying(false);
    setCurrentBeat(-1);
  }, []);

  // 画面スリープ防止 + 無音ループ + Media Session（3層バックグラウンド対策）
  useWakeLock(isPlaying);
  useSilentAudio(isPlaying, start, stop);

  // BPM: localStorage から復元。なければデフォルト 180（ミディアム）
  const [bpm, setBpmState] = useState<number>(() => {
    const saved = storage.getBpm();
    audioEngine.bpm = saved;
    return saved;
  });
  const [currentBeat, setCurrentBeat] = useState(-1);

  // トラックのミュート状態: localStorage から復元してエンジンにも反映
  // storage モジュール内の migrate() で旧バージョンは自動的にリセット済み
  const [mutedTracks, setMutedTracks] = useState<Set<TrackId>>(() => {
    const saved = storage.getMutedTracks().filter(
      (id): id is TrackId => (VALID_TRACK_IDS as string[]).includes(id),
    );
    const muted = new Set<TrackId>(saved);
    for (const id of muted) audioEngine.setTrackMuted(id, true);
    return muted;
  });

  // バックグラウンド再生スイッチ: localStorage から復元（デフォルト OFF）
  const [backgroundPlay, setBackgroundPlayState] = useState<boolean>(
    () => storage.getBackgroundPlay()
  );
  const backgroundPlayRef = useRef(backgroundPlay);
  backgroundPlayRef.current = backgroundPlay;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

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

  // バックグラウンド制御: スイッチが OFF なら hidden 時に強制停止
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        if (!backgroundPlayRef.current && isPlayingRef.current) {
          audioEngine.stop();
          setIsPlaying(false);
          setCurrentBeat(-1);
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

  const setBpm = useCallback((value: number) => {
    audioEngine.bpm = value;
    setBpmState(value);
    storage.setBpm(value);
  }, []);

  const setBackgroundPlay = useCallback((value: boolean) => {
    setBackgroundPlayState(value);
    storage.setBackgroundPlay(value);
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
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  /** コンガ3トラックを一括 ON/OFF する Master Mute */
  const toggleCongaMute = useCallback(() => {
    setMutedTracks(prev => {
      const mute = !CONGA_IDS.every(id => prev.has(id));
      for (const id of CONGA_IDS) audioEngine.setTrackMuted(id, mute);
      const next = new Set(prev);
      for (const id of CONGA_IDS) {
        if (mute) next.add(id);
        else next.delete(id);
      }
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  /** カウベル2トラックを一括 ON/OFF する Master Mute */
  const toggleCowbellMute = useCallback(() => {
    setMutedTracks(prev => {
      const mute = !COWBELL_IDS.every(id => prev.has(id));
      for (const id of COWBELL_IDS) audioEngine.setTrackMuted(id, mute);
      const next = new Set(prev);
      for (const id of COWBELL_IDS) {
        if (mute) next.add(id);
        else next.delete(id);
      }
      storage.setMutedTracks([...next]);
      return next;
    });
  }, []);

  const loadAudioFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    await audioEngine.loadBuffer(arrayBuffer);
  }, []);

  const congaMuted   = CONGA_IDS.every(id => mutedTracks.has(id));
  const cowbellMuted = COWBELL_IDS.every(id => mutedTracks.has(id));

  return {
    isPlaying, bpm, setBpm,
    currentBeat,
    mutedTracks, toggleTrackMute,
    congaMuted,   toggleCongaMute,
    cowbellMuted, toggleCowbellMute,
    backgroundPlay, setBackgroundPlay,
    applyClavePattern,
    start, stop,
    loadAudioFile,
  };
}
