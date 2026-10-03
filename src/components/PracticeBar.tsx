import { SPEEDS, type PracticePrefs, type Speed } from '../engine/practice';
import styles from './PracticeBar.module.css';

type ControlsProps = {
  prefs: PracticePrefs;
  onPrefs: (patch: Partial<PracticePrefs>) => void;
  playing: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
  loop: boolean;
  onLoop: (v: boolean) => void;
  /** 動画が流れているときだけ「動画の音」を出す */
  hasVideo: boolean;
  voiceAvailable: boolean;
};

/** 練習プレイヤーの下の操作列: 再生/停止・頭から・速さ・ループ・クリック・声・動画の音 */
export function PracticeControls({
  prefs, onPrefs, playing, onPlayPause, onRestart, loop, onLoop, hasVideo, voiceAvailable,
}: ControlsProps) {
  return (
    <div className={styles.controls} role="toolbar" aria-label="練習の操作">
      <button type="button" className={`${styles.btn} ${styles.play}`} onClick={onPlayPause} aria-label={playing ? '一時停止' : '再生'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button type="button" className={styles.btn} onClick={onRestart} aria-label="頭から（カウントイン付き）">⏮</button>
      <span className={styles.group} role="group" aria-label="速さ">
        {SPEEDS.map((s: Speed) => (
          <button
            key={s}
            type="button"
            className={`${styles.btn} ${prefs.speed === s ? styles.on : ''}`}
            aria-pressed={prefs.speed === s}
            onClick={() => onPrefs({ speed: s })}
          >
            {s}×
          </button>
        ))}
      </span>
      <button type="button" className={`${styles.btn} ${loop ? styles.on : ''}`} aria-pressed={loop} onClick={() => onLoop(!loop)} aria-label="ループ">
        🔁
      </button>
      <button type="button" className={`${styles.btn} ${prefs.clicks ? styles.on : ''}`} aria-pressed={prefs.clicks} onClick={() => onPrefs({ clicks: !prefs.clicks })}>
        クリック
      </button>
      {voiceAvailable && (
        <button type="button" className={`${styles.btn} ${prefs.voice ? styles.on : ''}`} aria-pressed={prefs.voice} onClick={() => onPrefs({ voice: !prefs.voice })}
          title="声で数える（端末によって少し遅れます）">
          声
        </button>
      )}
      {hasVideo && (
        <button type="button" className={`${styles.btn} ${prefs.videoSound ? styles.on : ''}`} aria-pressed={prefs.videoSound} onClick={() => onPrefs({ videoSound: !prefs.videoSound })}>
          {prefs.videoSound ? '🔊 動画' : '🔇 動画'}
        </button>
      )}
    </div>
  );
}

type ToolbarProps = {
  onRunThrough: () => void;
  /** 範囲を選んでいる途中: null = 選んでいない、-1 = 始めのカード待ち、それ以外 = 始めの行 no */
  pickingFromNo: number | null;
  onStartPick: () => void;
  onCancelPick: () => void;
  hasVideo: boolean;
};

/** 振付シートの上の「通し練習」「範囲ループ」 */
export function PracticeToolbar({ onRunThrough, pickingFromNo, onStartPick, onCancelPick, hasVideo }: ToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarRow}>
        <button type="button" className={styles.main} onClick={onRunThrough}>▶ 通し練習</button>
        {pickingFromNo === null
          ? <button type="button" className={styles.sub} onClick={onStartPick}>⟷ 範囲ループ</button>
          : <button type="button" className={styles.sub} onClick={onCancelPick}>✕ 範囲選択をやめる</button>}
      </div>
      {pickingFromNo !== null && (
        <p className={styles.pickTip} role="status">
          {pickingFromNo < 0 ? '始めのカードを押してください' : `#${pickingFromNo} から。終わりのカードを押してください`}
        </p>
      )}
      {pickingFromNo === null && (
        <p className={styles.hint}>
          {hasVideo ? 'カードを押すとその技をスローで繰り返し。長押しで範囲ループの始めに' : '動画なしでも、カウントの音とカードの光で通しの練習ができます。長押しで範囲ループ'}
        </p>
      )}
    </div>
  );
}
