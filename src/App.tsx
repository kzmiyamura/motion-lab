import { useAudioEngine } from './hooks/useAudioEngine';
import { ControlPanel } from './components/ControlPanel';
import { RhythmMachine } from './components/RhythmMachine';
import { ClaveBeatGrid } from './components/ClaveBeatGrid';
import { ClavePatternSelector } from './components/ClavePatternSelector';
import { FlipIndicator } from './components/FlipIndicator';
import { SamplesStatus } from './components/SamplesStatus';
import { InstallPrompt } from './components/InstallPrompt';
import { UpdateToast } from './components/UpdateToast';
import styles from './App.module.css';

function App() {
  const {
    isPlaying, bpm, setBpm,
    masterVolume, setMasterVolume,
    currentBeat,
    selectedPattern, handlePatternSelect,
    flipPending, flipTarget, requestFlip,
    randomFlipMode, setRandomFlipMode,
    mutedTracks, toggleTrackMute,
    congaMuted,   toggleCongaMute,
    cowbellMuted, toggleCowbellMute,
    backgroundPlay, setBackgroundPlay,
    samplesReady, samplesOffline,
    start, stop,
    loadAudioFile,
  } = useAudioEngine();

  return (
    <>
    <UpdateToast />
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>MotionLab</h1>
        <p className={styles.subtitle}>High-Precision Dance Training & Motion Analysis</p>
      </header>

      <InstallPrompt />
      <SamplesStatus samplesReady={samplesReady} samplesOffline={samplesOffline} />

      {/* ── Salsa Clave ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Salsa Clave</h2>

        <ClavePatternSelector
          selectedId={selectedPattern.id}
          onSelect={handlePatternSelect}
        />

        <ClaveBeatGrid beatPositions={selectedPattern.beatPositions} />

        {/* Flip Clave button + 説明 */}
        <div className={styles.flipSection}>
          <p className={styles.flipHelp}>
            <strong>Flip Clave</strong> — サルサの曲中でリズムの向きが切り替わる瞬間を練習するための機能。
            再生中にボタンを押すと、現在の2小節サイクルの終わりにアバニコ（合図音）が鳴り、
            次の1拍目から <em>2-3 ↔ 3-2</em> が反転します。
            Random Flip Mode をオンにすると自動でランダムに反転します。
          </p>
          <div className={styles.flipRow}>
            <button
              className={`${styles.flipBtn} ${flipPending ? styles.flipBtnPending : ''}`}
              onClick={requestFlip}
              disabled={!isPlaying || flipPending}
              title={!isPlaying ? '再生中のみ使用可能' : flipPending ? '反転待機中…' : 'クラーベを次の小節で反転'}
            >
              ⚡ Flip Clave
            </button>
            <FlipIndicator flipPending={flipPending} flipTarget={flipTarget} />
          </div>
        </div>
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
          masterVolume={masterVolume}
          onMasterVolumeChange={setMasterVolume}
          backgroundPlay={backgroundPlay}
          onBackgroundPlayChange={setBackgroundPlay}
          congaMuted={congaMuted}
          onCongaMuteToggle={toggleCongaMute}
          cowbellMuted={cowbellMuted}
          onCowbellMuteToggle={toggleCowbellMute}
          randomFlipMode={randomFlipMode}
          onRandomFlipModeChange={setRandomFlipMode}
        />
      </section>
    </main>
    </>
  );
}

export default App;
