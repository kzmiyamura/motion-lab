import styles from './ModeSwitcher.module.css';

type Props = {
  mode: 'audio' | 'video';
  onChange: (mode: 'audio' | 'video') => void;
};

export function ModeSwitcher({ mode, onChange }: Props) {
  return (
    <div className={styles.wrapper}>
      <button
        className={`${styles.btn} ${mode === 'audio' ? styles.btnActive : ''}`}
        onClick={() => onChange('audio')}
      >
        🎵 音声
      </button>
      <button
        className={`${styles.btn} ${mode === 'video' ? styles.btnActive : ''}`}
        onClick={() => onChange('video')}
      >
        🎬 動画
      </button>
    </div>
  );
}
