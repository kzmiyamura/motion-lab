import { useState, useCallback } from 'react';
import { useAudioEngine } from './hooks/useAudioEngine';
import { ControlPanel } from './components/ControlPanel';
import { StepGrid } from './components/StepGrid';
import { ClaveBeatGrid } from './components/ClaveBeatGrid';
import { ClavePatternSelector } from './components/ClavePatternSelector';
import { CLAVE_PATTERNS, type ClavePattern } from './engine/salsaPatterns';
import styles from './App.module.css';

function App() {
  const {
    isPlaying, bpm, setBpm,
    currentBeat, totalSteps,
    checkedSteps, toggleStep,
    applyClavePattern,
    start, stop,
    loadAudioFile,
  } = useAudioEngine();

  const [selectedPattern, setSelectedPattern] = useState<ClavePattern>(CLAVE_PATTERNS[0]);

  // Clave パターン選択 → ビジュアルと音を同時に更新
  const handlePatternSelect = useCallback((pattern: ClavePattern) => {
    setSelectedPattern(pattern);
    applyClavePattern(pattern);
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

      {/* ── Metronome ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Metronome</h2>

        <StepGrid
          totalSteps={totalSteps}
          activeStep={currentBeat}
          checkedSteps={checkedSteps}
          onToggleStep={toggleStep}
        />

        <ControlPanel
          isPlaying={isPlaying}
          bpm={bpm}
          onStart={start}
          onStop={stop}
          onBpmChange={setBpm}
          onFileLoad={loadAudioFile}
        />
      </section>
    </main>
  );
}

export default App;
