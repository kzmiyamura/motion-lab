import { useState, useCallback, useEffect } from 'react';
import { useAudioEngine } from './hooks/useAudioEngine';
import { ControlPanel } from './components/ControlPanel';
import { RhythmMachine } from './components/RhythmMachine';
import { ClaveBeatGrid } from './components/ClaveBeatGrid';
import { ClavePatternSelector } from './components/ClavePatternSelector';
import { CLAVE_PATTERNS, type ClavePattern } from './engine/salsaPatterns';
import { storage } from './engine/storage';
import styles from './App.module.css';

function App() {
  const {
    isPlaying, bpm, setBpm,
    currentBeat,
    mutedTracks, toggleTrackMute,
    congaMuted,   toggleCongaMute,
    cowbellMuted, toggleCowbellMute,
    backgroundPlay, setBackgroundPlay,
    applyClavePattern,
    start, stop,
    loadAudioFile,
  } = useAudioEngine();

  // パターン: localStorage から復元。なければ Son Clave 2-3
  const [selectedPattern, setSelectedPattern] = useState<ClavePattern>(() => {
    const savedId = storage.getPatternId();
    return CLAVE_PATTERNS.find(p => p.id === savedId) ?? CLAVE_PATTERNS[0];
  });

  // マウント時に保存済みパターンをエンジンに適用
  useEffect(() => {
    applyClavePattern(selectedPattern);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePatternSelect = useCallback((pattern: ClavePattern) => {
    setSelectedPattern(pattern);
    applyClavePattern(pattern);
    storage.setPatternId(pattern.id);
  }, [applyClavePattern]);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>MotionLab</h1>
        <p className={styles.subtitle}>High-Precision Dance Training & Motion Analysis</p>
      </header>

      {/* ── Salsa Clave ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Salsa Clave</h2>

        <ClavePatternSelector
          selectedId={selectedPattern.id}
          onSelect={handlePatternSelect}
        />

        <ClaveBeatGrid beatPositions={selectedPattern.beatPositions} />
      </section>

      {/* ── Rhythm Machine ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Rhythm Machine</h2>

        <RhythmMachine
          currentBeat={currentBeat}
          mutedTracks={mutedTracks}
          onToggleMute={toggleTrackMute}
        />

        <ControlPanel
          isPlaying={isPlaying}
          bpm={bpm}
          onStart={start}
          onStop={stop}
          onBpmChange={setBpm}
          onFileLoad={loadAudioFile}
          backgroundPlay={backgroundPlay}
          onBackgroundPlayChange={setBackgroundPlay}
          congaMuted={congaMuted}
          onCongaMuteToggle={toggleCongaMute}
          cowbellMuted={cowbellMuted}
          onCowbellMuteToggle={toggleCowbellMute}
        />
      </section>
    </main>
  );
}

export default App;
