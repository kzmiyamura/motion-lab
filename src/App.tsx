import { useAudioEngine } from './hooks/useAudioEngine';
import { ControlPanel } from './components/ControlPanel';
import { StepGrid } from './components/StepGrid';
import { PresetSelector } from './components/PresetSelector';
import styles from './App.module.css';

function App() {
  const {
    isPlaying, bpm, setBpm,
    currentBeat, totalSteps, setTotalSteps,
    checkedSteps, toggleStep,
    preset, applyPreset,
    start, stop,
    loadAudioFile,
  } = useAudioEngine();

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>MotionLab</h1>
        <p className={styles.subtitle}>High-Precision Dance Training & Motion Analysis</p>
      </header>

      <section className={styles.section}>
        <PresetSelector
          totalSteps={totalSteps}
          preset={preset}
          onTotalStepsChange={setTotalSteps}
          onPresetChange={applyPreset}
        />

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
