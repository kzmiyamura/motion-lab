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

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);

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

  const stopStream = useCallback((stream: MediaStream) => {
    stream.getTracks().forEach(t => t.stop());
  }, []);

  const handleRecordingStop = useCallback(async (stream: MediaStream) => {
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    chunksRef.current = [];
    stopStream(stream);
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const ctx = new AudioContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      await ctx.close();
      const detected = detectBpm(audioBuffer);
      setDetectedBpm(detected);
      const url = buildShareUrl(detected, youtubeId, offset);
      setShareUrl(url);
      // Save to localStorage if we have a youtubeId
      if (youtubeId) {
        analysisStorage.save(youtubeId, { bpm: detected, offset, analyzedAt: Date.now() });
      }
    } catch (e) {
      setError('BPM検出に失敗しました: ' + String(e));
    }
    setRecording(false);
    setProgress(100);
  }, [youtubeId, offset, stopStream]);

  const startRecording = useCallback(async () => {
    setError(null);
    setDetectedBpm(null);
    setQrDataUrl(null);
    setShareUrl(null);
    setProgress(0);
    progressRef.current = 0;

    let stream: MediaStream;
    try {
      if (mode === 'tab') {
        stream = await (navigator.mediaDevices as unknown as { getDisplayMedia: (opts: unknown) => Promise<MediaStream> }).getDisplayMedia({
          audio: true,
          video: { width: 1, height: 1 }, // Chrome requires video
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch {
      setError('マイク/タブ音声へのアクセスが拒否されました');
      return;
    }

    // Check we have an audio track
    if (!stream.getAudioTracks().length) {
      stopStream(stream);
      setError('音声トラックが取得できませんでした。タブ共有時は「音声を共有」を有効にしてください。');
      return;
    }

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => handleRecordingStop(stream);
    recorder.start(100);
    setRecording(true);

    // Progress timer
    const intervalMs = 200;
    timerRef.current = setInterval(() => {
      progressRef.current += (intervalMs / (RECORD_SEC * 1000)) * 100;
      setProgress(Math.min(99, progressRef.current));
      if (progressRef.current >= 100) {
        if (timerRef.current !== null) clearInterval(timerRef.current);
      }
    }, intervalMs);

    setTimeout(() => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    }, RECORD_SEC * 1000);
  }, [mode, handleRecordingStop, stopStream]);

  const applyBpm = useCallback(() => {
    if (detectedBpm !== null) onBpmChange(detectedBpm);
  }, [detectedBpm, onBpmChange]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    };
  }, []);

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
