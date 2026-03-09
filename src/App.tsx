import { useAudioEngine } from './hooks/useAudioEngine';
import { ControlPanel } from './components/ControlPanel';
import { VisualMetronome } from './components/VisualMetronome';
import styles from './App.module.css';

function App() {
  const { isPlaying, bpm, setBpm, currentBeat, start, stop, loadAudioFile } =
    useAudioEngine();

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>MotionLab</h1>
        <p className={styles.subtitle}>High-Precision Dance Training & Motion Analysis</p>
      </header>

      <section className={styles.metronomeSection}>
        <VisualMetronome
          currentBeat={currentBeat}
          beatsPerBar={4}
          isPlaying={isPlaying}
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
