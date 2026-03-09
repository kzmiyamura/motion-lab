import { useCallback } from 'react';
import styles from './ControlPanel.module.css';

type Props = {
  isPlaying: boolean;
  bpm: number;
  onStart: () => void;
  onStop: () => void;
  onBpmChange: (bpm: number) => void;
  onFileLoad: (file: File) => void;
};

export function ControlPanel({
  isPlaying,
  bpm,
  onStart,
  onStop,
  onBpmChange,
  onFileLoad,
}: Props) {
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
      <div className={styles.bpmRow}>
        <label className={styles.label} htmlFor="bpm-slider">
          BPM
        </label>
        <input
          id="bpm-slider"
          type="range"
          min={20}
          max={300}
          value={bpm}
          onChange={handleSlider}
          className={styles.slider}
        />
        <span className={styles.bpmValue}>{bpm}</span>
      </div>

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
    </div>
  );
}
