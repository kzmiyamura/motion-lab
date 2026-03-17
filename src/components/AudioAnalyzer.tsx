import { useState, useRef, useCallback, useEffect } from 'react';
import { detectBpm } from '../engine/bpmDetector';
import { analysisStorage } from '../engine/analysisStorage';
import styles from './AudioAnalyzer.module.css';

const APP_URL = 'https://motion-lab-apa.pages.dev';
const RECORD_SEC = 10;

type Props = {
  bpm: number;
  youtubeId: string | null;
  offset: number;
  onBpmChange: (bpm: number) => void;
};

type CaptureMode = 'mic' | 'tab';

function buildShareUrl(bpm: number, youtubeId: string | null, offset: number): string {
  const p = new URLSearchParams({ bpm: String(bpm) });
  if (youtubeId) p.set('vid', youtubeId);
  if (offset !== 0) p.set('offset', String(offset));
  return `${APP_URL}/?${p.toString()}`;
}

export function AudioAnalyzer({ bpm, youtubeId, offset, onBpmChange }: Props) {
  const [mode, setMode] = useState<CaptureMode>('mic');
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0); // 0–100
  const [detectedBpm, setDetectedBpm] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const captureCtxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const supportsDisplayMedia = typeof navigator !== 'undefined' && 'getDisplayMedia' in navigator.mediaDevices;

  // Generate QR code whenever shareUrl changes
  useEffect(() => {
    if (!shareUrl) { setQrDataUrl(null); return; }
    import('qrcode').then(QRCode => {
      QRCode.toDataURL(shareUrl, { width: 200, margin: 2 })
        .then(url => setQrDataUrl(url))
        .catch(() => setQrDataUrl(null));
    }).catch(() => setQrDataUrl(null));
  }, [shareUrl]);

  const stopCapture = useCallback(() => {
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (progressIntervalRef.current !== null) { clearInterval(progressIntervalRef.current); progressIntervalRef.current = null; }
    if (captureCtxRef.current) { captureCtxRef.current.close().catch(() => {}); captureCtxRef.current = null; }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    setDetectedBpm(null);
    setQrDataUrl(null);
    setShareUrl(null);
    setProgress(0);
    stopCapture();

    let stream: MediaStream;
    try {
      if (mode === 'tab') {
        stream = await (navigator.mediaDevices as unknown as { getDisplayMedia: (opts: unknown) => Promise<MediaStream> }).getDisplayMedia({
          audio: true,
          video: { width: 1, height: 1 },
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch {
      setError('マイク/タブ音声へのアクセスが拒否されました');
      return;
    }

    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      setError('音声トラックが取得できませんでした。タブ共有時は「音声を共有」を有効にしてください。');
      return;
    }

    // Use Web Audio API directly — avoids MediaRecorder encode/decode issues
    const ctx = new AudioContext();
    captureCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const bufferSize = 4096;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
    const collected: Float32Array[] = [];
    let totalSamples = 0;
    const targetSamples = ctx.sampleRate * RECORD_SEC;

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (totalSamples >= targetSamples) return;
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
      collected.push(chunk);
      totalSamples += chunk.length;
    };

    source.connect(processor);
    processor.connect(ctx.destination);
    setRecording(true);

    // Progress bar
    const startTime = Date.now();
    progressIntervalRef.current = setInterval(() => {
      setProgress(Math.min(99, ((Date.now() - startTime) / (RECORD_SEC * 1000)) * 100));
    }, 200);

    // Stop after RECORD_SEC
    timerRef.current = setTimeout(() => {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach(t => t.stop());
      if (progressIntervalRef.current !== null) clearInterval(progressIntervalRef.current);

      try {
        const combined = new Float32Array(totalSamples);
        let off = 0;
        for (const c of collected) { combined.set(c, off); off += c.length; }
        const audioBuffer = ctx.createBuffer(1, totalSamples, ctx.sampleRate);
        audioBuffer.copyToChannel(combined, 0);
        ctx.close().catch(() => {});
        captureCtxRef.current = null;

        const detected = detectBpm(audioBuffer);
        setDetectedBpm(detected);
        const url = buildShareUrl(detected, youtubeId, offset);
        setShareUrl(url);
        if (youtubeId) {
          analysisStorage.save(youtubeId, { bpm: detected, offset, analyzedAt: Date.now() });
        }
      } catch (e) {
        setError('BPM検出に失敗しました: ' + String(e));
      }
      setRecording(false);
      setProgress(100);
    }, RECORD_SEC * 1000);
  }, [mode, youtubeId, offset, stopCapture]);

  const applyBpm = useCallback(() => {
    if (detectedBpm !== null) onBpmChange(detectedBpm);
  }, [detectedBpm, onBpmChange]);

  // Cleanup on unmount
  useEffect(() => () => stopCapture(), [stopCapture]);

  // Keep bpm in sync for share URL rebuilding
  void bpm;

  return (
    <div className={styles.wrapper}>
      {/* Mode selector */}
      <div className={styles.modeRow}>
        <button
          className={`${styles.modeBtn} ${mode === 'mic' ? styles.modeBtnActive : ''}`}
          onClick={() => setMode('mic')}
          disabled={recording}
        >
          マイク
        </button>
        {supportsDisplayMedia && (
          <button
            className={`${styles.modeBtn} ${mode === 'tab' ? styles.modeBtnActive : ''}`}
            onClick={() => setMode('tab')}
            disabled={recording}
          >
            タブ音声
          </button>
        )}
        <span className={styles.hint}>
          {mode === 'tab' ? '共有ダイアログで「タブ」を選択し音声共有をONに' : '端末のマイクで周囲の音を録音'}
        </span>
      </div>

      {/* Record button + progress */}
      <button
        className={`${styles.recordBtn} ${recording ? styles.recordBtnActive : ''}`}
        onClick={startRecording}
        disabled={recording}
      >
        {recording ? `録音中… ${Math.floor(progress)}%` : `▶ 録音開始（${RECORD_SEC}秒）`}
      </button>

      {recording && (
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {/* Result */}
      {detectedBpm !== null && (
        <div className={styles.result}>
          <span className={styles.resultBpm}>{detectedBpm}</span>
          <span className={styles.resultUnit}>BPM 検出</span>
          <button className={styles.applyBtn} onClick={applyBpm}>
            ← 適用
          </button>
        </div>
      )}

      {/* QR code + share URL */}
      {shareUrl && (
        <div className={styles.shareBlock}>
          {qrDataUrl && (
            <img src={qrDataUrl} alt="QR code" className={styles.qrImg} />
          )}
          <div className={styles.shareUrlRow}>
            <span className={styles.shareUrlLabel}>共有URL</span>
            <input
              className={styles.shareUrlInput}
              readOnly
              value={shareUrl}
              onFocus={e => e.target.select()}
            />
            <button
              className={styles.copyBtn}
              onClick={() => navigator.clipboard?.writeText(shareUrl)}
            >
              コピー
            </button>
          </div>
          <p className={styles.shareHint}>
            iPhoneでQRコードをスキャンするとBPMと動画が自動設定されます
          </p>
        </div>
      )}
    </div>
  );
}
