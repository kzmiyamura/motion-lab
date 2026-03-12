import { useCallback } from 'react';
import { BPM_CATEGORIES, getActiveCategoryId } from '../engine/bpmCategories';
import { BACHATA_PATTERNS } from '../engine/bachataPatterns';
import { type Genre, BPM_RANGE } from '../hooks/useAudioEngine';
import styles from './ControlPanel.module.css';

type Props = {
  isPlaying: boolean;
  bpm: number;
  onStart: () => void;
  onStop: () => void;
  onBpmChange: (bpm: number) => void;
  onFileLoad: (file: File) => void;
  masterVolume: number;
  onMasterVolumeChange: (v: number) => void;
  backgroundPlay: boolean;
  onBackgroundPlayChange: (v: boolean) => void;
  congaMuted: boolean;
  onCongaMuteToggle: () => void;
  cowbellMuted: boolean;
  onCowbellMuteToggle: () => void;
  randomFlipMode: boolean;
  onRandomFlipModeChange: (v: boolean) => void;
  loudness: boolean;
  onLoudnessChange: (v: boolean) => void;
  genre: Genre;
  bongoMuted: boolean;
  onBongoMuteToggle: () => void;
  guiraMuted: boolean;
  onGuiraMuteToggle: () => void;
  bachataComplexity: number;
  onBachataComplexityChange: (v: number) => void;
};

export function ControlPanel({
  isPlaying,
  bpm,
  onStart,
  onStop,
  onBpmChange,
  onFileLoad,
  masterVolume,
  onMasterVolumeChange,
  backgroundPlay,
  onBackgroundPlayChange,
  congaMuted,
  onCongaMuteToggle,
  cowbellMuted,
  onCowbellMuteToggle,
  randomFlipMode,
  onRandomFlipModeChange,
  loudness,
  onLoudnessChange,
  genre,
  bongoMuted,
  onBongoMuteToggle,
  guiraMuted,
  onGuiraMuteToggle,
  bachataComplexity,
  onBachataComplexityChange,
}: Props) {
  const activeCategoryId = getActiveCategoryId(bpm);

  const handleSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onBpmChange(Number(e.target.value));
    },
    [onBpmChange]
  );

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileLoad(file);
    },
    [onFileLoad]
  );

  return (
    <div className={styles.panel}>

      {/* ── BPM カテゴリ選択（Salsa モードのみ：Bachata では BPM レンジが異なるため非表示） ── */}
      {genre === 'salsa' && (
        <>
          <div className={styles.categoryGrid}>
            {BPM_CATEGORIES.map(cat => {
              const isActive = activeCategoryId === cat.id;
              const rangeLabel = cat.range[1] === Infinity
                ? `${cat.range[0]}+`
                : `${cat.range[0]}–${cat.range[1]}`;

              return (
                <button
                  key={cat.id}
                  className={`${styles.catBtn} ${isActive ? styles.catBtnActive : ''}`}
                  onClick={() => onBpmChange(cat.defaultBpm)}
                  title={cat.feel}
                >
                  <span className={styles.catLabel}>{cat.label}</span>
                  <span className={styles.catSublabel}>{cat.sublabel}</span>
                  <span className={styles.catRange}>{rangeLabel}</span>
                </button>
              );
            })}
          </div>

          {activeCategoryId && (
            <p className={styles.feelText}>
              {BPM_CATEGORIES.find(c => c.id === activeCategoryId)!.feel}
            </p>
          )}
        </>
      )}

      {/* ── VOL スライダー ── */}
      <div className={styles.bpmRow}>
        <label className={styles.label} htmlFor="vol-slider">VOL</label>
        <input
          id="vol-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(masterVolume * 100)}
          onChange={(e) => onMasterVolumeChange(Number(e.target.value) / 100)}
          className={styles.slider}
        />
        <span className={styles.bpmValue}>{Math.round(masterVolume * 100)}%</span>
      </div>

      {/* ── BPM スライダー（ジャンル別レンジ） ── */}
      <div className={styles.bpmRow}>
        <label className={styles.label} htmlFor="bpm-slider">BPM</label>
        <input
          id="bpm-slider"
          aria-label="BPM"
          type="range"
          min={BPM_RANGE[genre].min}
          max={BPM_RANGE[genre].max}
          value={bpm}
          onChange={handleSlider}
          className={styles.slider}
        />
        <span className={styles.bpmValue}>{bpm}</span>
      </div>

      {/* ── 再生 / 停止 ── */}
      <div className={styles.buttonRow}>
        <button
          className={`${styles.btn} ${isPlaying ? styles.btnStop : styles.btnStart}`}
          onClick={isPlaying ? onStop : onStart}
          aria-label={isPlaying ? 'Stop metronome' : 'Start metronome'}
        >
          {isPlaying ? 'Stop' : 'Start'}
        </button>
      </div>

      <div className={styles.fileRow}>
        <label className={styles.fileLabel}>
          Load click sound (WAV/MP3)
          <input
            type="file"
            accept="audio/*"
            onChange={handleFile}
            className={styles.fileInput}
          />
        </label>
      </div>

      {genre === 'salsa' && (
        <>
          {/* ── Tumbao (Conga) Master Mute ── */}
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>
              Tumbao（コンガ）
              <span className={styles.settingsSub}>
                {congaMuted ? 'Open + Slap + Heel ミュート中' : 'Open + Slap + Heel 再生中'}
              </span>
            </span>
            <button
              role="switch"
              aria-checked={!congaMuted}
              aria-label="Tumbao master mute"
              className={`${styles.toggle} ${!congaMuted ? styles.toggleOn : ''}`}
              onClick={onCongaMuteToggle}
            >
              <span className={styles.toggleThumb} />
            </button>
          </div>

          {/* ── Campana Master Mute ── */}
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>
              Campana（カウベル）
              <span className={styles.settingsSub}>
                {cowbellMuted ? 'Low + High ミュート中' : 'Low + High 再生中'}
              </span>
            </span>
            <button
              role="switch"
              aria-checked={!cowbellMuted}
              aria-label="Campana master mute"
              className={`${styles.toggle} ${!cowbellMuted ? styles.toggleOn : ''}`}
              onClick={onCowbellMuteToggle}
            >
              <span className={styles.toggleThumb} />
            </button>
          </div>

          {/* ── Random Flip Mode ── */}
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>
              Random Flip Mode
              <span className={styles.settingsSub}>
                {randomFlipMode ? '自動でクラーベを反転' : '手動フリップのみ'}
              </span>
            </span>
            <button
              role="switch"
              aria-checked={randomFlipMode}
              aria-label="Random Flip Mode"
              className={`${styles.toggle} ${randomFlipMode ? styles.toggleOn : ''}`}
              onClick={() => onRandomFlipModeChange(!randomFlipMode)}
            >
              <span className={styles.toggleThumb} />
            </button>
          </div>
        </>
      )}

      {genre === 'bachata' && (
        <>
          {/* ── Complexity スライダー ── */}
          {(() => {
            const pattern = BACHATA_PATTERNS[bachataComplexity];
            return (
              <div className={styles.complexitySection}>
                <div className={styles.complexityHeader}>
                  <span className={styles.complexityTitle}>Complexity</span>
                  <span className={styles.complexityBadge}>
                    {pattern.complexity} — {pattern.name}
                  </span>
                </div>
                <input
                  aria-label="Bachata Complexity"
                  type="range"
                  min={0}
                  max={BACHATA_PATTERNS.length - 1}
                  step={1}
                  value={bachataComplexity}
                  onChange={(e) => onBachataComplexityChange(Number(e.target.value))}
                  className={styles.complexitySlider}
                />
                <div className={styles.complexityDesc}>
                  {pattern.nameJa}
                </div>
              </div>
            );
          })()}

          {/* ── Bongo Master Mute ── */}
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>
              Bongo
              <span className={styles.settingsSub}>
                {bongoMuted ? 'Low + High ミュート中' : 'Low + High 再生中'}
              </span>
            </span>
            <button
              role="switch"
              aria-checked={!bongoMuted}
              aria-label="Bongo master mute"
              className={`${styles.toggle} ${!bongoMuted ? styles.toggleOn : ''}`}
              onClick={onBongoMuteToggle}
            >
              <span className={styles.toggleThumb} />
            </button>
          </div>

          {/* ── Güira Master Mute ── */}
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>
              Güira
              <span className={styles.settingsSub}>
                {guiraMuted ? 'ミュート中' : '再生中'}
              </span>
            </span>
            <button
              role="switch"
              aria-checked={!guiraMuted}
              aria-label="Güira master mute"
              className={`${styles.toggle} ${!guiraMuted ? styles.toggleOn : ''}`}
              onClick={onGuiraMuteToggle}
            >
              <span className={styles.toggleThumb} />
            </button>
          </div>
        </>
      )}

      {/* ── LOUDNESS ── */}
      <div className={styles.settingsRow}>
        <span className={styles.settingsLabel}>
          LOUDNESS
          <span className={styles.settingsSub}>
            {loudness ? 'コンプレッサー ON（音量最大化）' : 'コンプレッサー OFF'}
          </span>
        </span>
        <button
          role="switch"
          aria-checked={loudness}
          aria-label="LOUDNESS"
          className={`${styles.toggle} ${loudness ? styles.toggleOn : ''}`}
          onClick={() => onLoudnessChange(!loudness)}
        >
          <span className={styles.toggleThumb} />
        </button>
      </div>

      {/* ── 設定 ── */}
      <div className={styles.settingsRow}>
        <span className={styles.settingsLabel}>
          バックグラウンド再生
          <span className={styles.settingsSub}>
            {backgroundPlay ? 'タブを離れても継続' : '非表示時に自動停止'}
          </span>
        </span>
        <button
          role="switch"
          aria-checked={backgroundPlay}
          aria-label="バックグラウンド再生"
          className={`${styles.toggle} ${backgroundPlay ? styles.toggleOn : ''}`}
          onClick={() => onBackgroundPlayChange(!backgroundPlay)}
        >
          <span className={styles.toggleThumb} />
        </button>
      </div>
    </div>
  );
}
