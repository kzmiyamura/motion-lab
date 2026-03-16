import { useAudioEngine } from './hooks/useAudioEngine';
import { ControlPanel } from './components/ControlPanel';
import { RhythmMachine } from './components/RhythmMachine';
import { ClaveBeatGrid } from './components/ClaveBeatGrid';
import { ClavePatternSelector } from './components/ClavePatternSelector';
import { FlipIndicator } from './components/FlipIndicator';
import { SamplesStatus } from './components/SamplesStatus';
import { InstallPrompt } from './components/InstallPrompt';
import { UpdateToast } from './components/UpdateToast';
import { YouTubeControl } from './components/YouTubeControl';
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
    bongoMuted,   toggleBongoMute,
    guiraMuted,   toggleGuiraMute,
    backgroundPlay, setBackgroundPlay,
    loudness, setLoudness,
    genre, setGenre,
    bachataComplexity, setBachataComplexity,
    bachataSection, setBachataSection,
    samplesReady, samplesOffline,
    start, stop,
    adjustBeatOffset,
    loadAudioFile,
    reverbType, setReverb, isReverbLoading,
    reverbWetLevel, setReverbWetLevel,
  } = useAudioEngine();

  return (
    <>
    <UpdateToast />
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>MotionLab</h1>
        <p className={styles.subtitle}>High-Precision Dance Training & Motion Analysis</p>

        {/* ── ジャンルセレクター ── */}
        <div className={styles.genreSelector}>
          <button
            className={`${styles.genreBtn} ${genre === 'salsa' ? styles.genreBtnActive : ''}`}
            onClick={() => setGenre('salsa')}
          >
            💃 Salsa
          </button>
          <button
            className={`${styles.genreBtn} ${genre === 'bachata' ? styles.genreBtnActive : ''}`}
            onClick={() => setGenre('bachata')}
          >
            🌹 Bachata
          </button>
        </div>
      </header>

      <InstallPrompt />
      <SamplesStatus samplesReady={samplesReady} samplesOffline={samplesOffline} />

      {/* ── Salsa Clave（Salsa モードのみ） ── */}
      {genre === 'salsa' && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Salsa Clave</h2>

          <ClavePatternSelector
            selectedId={selectedPattern.id}
            onSelect={handlePatternSelect}
          />

          <ClaveBeatGrid beatPositions={selectedPattern.beatPositions} />

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
      )}

      {/* ── Bachata 説明（Bachata モードのみ） ── */}
      {genre === 'bachata' && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Bachata Rhythm</h2>
          <div className={styles.bachataInfo}>
            <p className={styles.bachataDesc}>
              バチャータは <strong>4拍子 × 2</strong> の8カウントが基本。<br />
              <strong>Beat 4</strong> と <strong>Beat 8</strong> にアクセント（タップ / 腰の動き）が来ます。<br />
              Bongo・Güira・Bass の3層でリズムを構成します。
            </p>
            <div className={styles.bachataBeats}>
              {[1,2,3,4,5,6,7,8].map(b => {
                // Beat 4 = step 6, Beat 8 = step 14
                const step = (b - 1) * 2;
                const isAccent = b === 4 || b === 8;
                const isLive = currentBeat === step;
                return (
                  <div
                    key={b}
                    className={[
                      styles.bachataBeat,
                      isAccent ? styles.bachataBeatAccent : '',
                      isLive && isAccent ? styles.bachataBeatLive : '',
                      isLive && !isAccent ? styles.bachataBeatCurrent : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {b}
                    {isAccent && <span className={styles.bachataTap}>tap</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── セクション・セレクター ── */}
          <div className={styles.bachataSectionSelector}>
            <span className={styles.bachataSectionLabel}>Section</span>
            <div className={styles.bachataSectionBtns}>
              {([
                { id: 'derecho', label: 'Derecho', sub: 'ストレート' },
                { id: 'majao',   label: 'Majao',   sub: '激しい刻み' },
                { id: 'mambo',   label: 'Mambo',   sub: 'シンコペーション' },
              ] as const).map(({ id, label, sub }) => (
                <button
                  key={id}
                  className={`${styles.bachataSectionBtn} ${bachataSection === id ? styles.bachataSectionBtnActive : ''}`}
                  onClick={() => setBachataSection(id)}
                  title={sub}
                >
                  <span className={styles.bachataSectionBtnLabel}>{label}</span>
                  <span className={styles.bachataSectionBtnSub}>{sub}</span>
                </button>
              ))}
            </div>
            {bachataSection && (
              <p className={styles.bachataSectionDesc}>
                {bachataSection === 'derecho' && 'Beat 1–3 を抑え、Beat 4 & 8 のボンゴを強調。ヒップムーブのタイミングを掴もう。'}
                {bachataSection === 'majao' && 'ゲインを均一に上げ、Güira を16分音符の激しいパターンへ切替。'}
                {bachataSection === 'mambo' && '裏拍主体の複合シーケンス。アドリブやパートナーとのサイン交換で使用。'}
              </p>
            )}
          </div>
        </section>
      )}

      {/* ── Rhythm Machine ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Rhythm Machine</h2>

        <RhythmMachine
          genre={genre}
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
          loudness={loudness}
          onLoudnessChange={setLoudness}
          genre={genre}
          bongoMuted={bongoMuted}
          onBongoMuteToggle={toggleBongoMute}
          guiraMuted={guiraMuted}
          onGuiraMuteToggle={toggleGuiraMute}
          bachataComplexity={bachataComplexity}
          onBachataComplexityChange={setBachataComplexity}
          reverbType={reverbType}
          onReverbChange={setReverb}
          isReverbLoading={isReverbLoading}
          reverbWetLevel={reverbWetLevel}
          onReverbWetLevelChange={setReverbWetLevel}
        />
      </section>

      {/* ── YouTube Sync ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>YouTube Sync</h2>
        <YouTubeControl
          isPlaying={isPlaying}
          bpm={bpm}
          onBpmChange={setBpm}
          onStart={start}
          onStop={stop}
          onAdjustOffset={adjustBeatOffset}
        />
      </section>

      {/* ── Footer with Version ── */}
      <footer className={styles.footer}>
        <p className={styles.version}>v{__APP_VERSION__}</p>
      </footer>
    </main>
    </>
  );
}

export default App;
// test: Haiku mode activated
