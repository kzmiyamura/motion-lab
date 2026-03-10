import styles from './SamplesStatus.module.css';

type Props = {
  samplesReady: boolean;
  samplesOffline: boolean;
};

export function SamplesStatus({ samplesReady, samplesOffline }: Props) {
  if (samplesReady) return null; // all good, stay silent

  if (samplesOffline) {
    return (
      <div className={`${styles.bar} ${styles.offline}`}>
        <span className={styles.icon}>⚠️</span>
        <span className={styles.text}>
          音声ファイルを読み込めませんでした。シンセ音で動作しています（オフライン環境）。
        </span>
      </div>
    );
  }

  // loading
  return (
    <div className={`${styles.bar} ${styles.loading}`}>
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.text}>音声ファイルを読み込み中…</span>
    </div>
  );
}
