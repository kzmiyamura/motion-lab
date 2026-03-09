import { useCallback } from 'react';
import { BPM_CATEGORIES, getActiveCategoryId } from '../engine/bpmCategories';
import styles from './ControlPanel.module.css';

type Props = {
  isPlaying: boolean;
  bpm: number;
  onStart: () => void;
  onStop: () => void;
  onBpmChange: (bpm: number) => void;
  onFileLoad: (file: File) => void;
  backgroundPlay: boolean;
  onBackgroundPlayChange: (v: boolean) => void;
  congaMuted: boolean;
  onCongaMuteToggle: () => void;
  cowbellMuted: boolean;
  onCowbellMuteToggle: () => void;
};

export function ControlPanel({
  isPlaying,
  bpm,
  onStart,
  onStop,
  onBpmChange,
  onFileLoad,
  backgroundPlay,
  onBackgroundPlayChange,
  congaMuted,
  onCongaMuteToggle,
  cowbellMuted,
  onCowbellMuteToggle,
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

      {/* ── BPM カテゴリ選択 ── */}
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

      {/* ── feel テキスト（アクティブカテゴリの説明） ── */}
      {activeCategoryId && (
        <p className={styles.feelText}>
          {BPM_CATEGORIES.find(c => c.id === activeCategoryId)!.feel}
        </p>
      )}

      {/* ── BPM スライダー ── */}
      <div className={styles.bpmRow}>
        <label className={styles.label} htmlFor="bpm-slider">BPM</label>
        <input
          id="bpm-slider"
          type="range"
          min={120}
          max={260}
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
