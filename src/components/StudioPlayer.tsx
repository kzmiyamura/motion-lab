import { useState, useRef, useCallback, useEffect } from 'react';
import { usePoseEstimation, type VizMode } from '../hooks/usePoseEstimation';
import { useWakeLock } from '../hooks/useWakeLock';
import styles from './StudioPlayer.module.css';

type Phase = 'idle' | 'previewing' | 'recording' | 'replay';

function getSupportedMimeType(): string {
  const types = ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
}

function fmtTime(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function StudioPlayer() {
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const setPhaseSync = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);

  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [vizMode, setVizMode] = useState<VizMode>('off');
  const [recSecs, setRecSecs] = useState(0);
  const [isPTT, setIsPTT] = useState(false);
  const [voiceResult, setVoiceResult] = useState<string | null>(null);

  const previewRef = useRef<HTMLVideoElement>(null);
  const replayRef  = useRef<HTMLVideoElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const recorderRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<Blob[]>([]);
  const recTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const blobUrlRef   = useRef<string | null>(null);
  const recSecsRef   = useRef(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  // Wake lock: recording 中 or replay 再生中
  useWakeLock(phase === 'recording' || (phase === 'replay' && isPlaying));

  // Skeleton overlay: replay 中のみ active
  usePoseEstimation(replayRef, canvasRef, phase === 'replay' ? vizMode : 'off');

  // ── playbackRate 同期 ──────────────────────────────────────────────
  useEffect(() => {
    if (replayRef.current) replayRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // ── Camera ────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    setReplayUrl(null);
    setIsPlaying(false);
    setVizMode('off');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play();
      }
      setPhaseSync('previewing');
    } catch {
      alert('カメラへのアクセスが必要です。ブラウザの設定を確認してください。');
    }
  }, [setPhaseSync]);

  // ── Recording ─────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    if (!streamRef.current || phaseRef.current !== 'previewing') return;
    chunksRef.current = [];
    const mimeType = getSupportedMimeType();
    const recorder = new MediaRecorder(streamRef.current, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType || 'video/mp4' });
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setReplayUrl(url);
      setPhaseSync('replay');
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    recSecsRef.current = 0;
    setRecSecs(0);
    recTimerRef.current = setInterval(() => {
      recSecsRef.current += 1;
      setRecSecs(recSecsRef.current);
    }, 1000);
    setPhaseSync('recording');
  }, [setPhaseSync]);

  const stopRecording = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    recorderRef.current?.stop();
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    stopCamera();
  }, [stopCamera]);

  // ── Replay ────────────────────────────────────────────────────────
  const toggleReplay = useCallback(() => {
    const v = replayRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); }
    else { v.pause(); }
  }, []);

  // ── Voice commands ────────────────────────────────────────────────
  const handleVoiceCommand = useCallback((text: string) => {
    setVoiceResult(text);
    setTimeout(() => setVoiceResult(null), 2500);
    const p = phaseRef.current;
    if (/録画|開始/.test(text) && p === 'previewing') { startRecording(); return; }
    if (/終了|停止/.test(text) && p === 'recording')  { stopRecording(); return; }
    if (/リプレイ|再生/.test(text) && p === 'replay') { toggleReplay(); return; }
    if (/スロー|ゆっくり/.test(text))   { setPlaybackRate(0.5); return; }
    if (/通常|いちばい|1倍/.test(text)) { setPlaybackRate(1.0); return; }
    if (/骨格/.test(text)) { setVizMode(v => v === 'off' ? 'full' : 'off'); return; }
  }, [startRecording, stopRecording, toggleReplay]);

  const startPTT = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      for (let i = 0; i < e.results[0].length; i++) {
        handleVoiceCommand(e.results[0][i].transcript);
      }
    };
    rec.onerror = () => {};
    rec.onend = () => setIsPTT(false);
    rec.start();
    recognitionRef.current = rec;
    setIsPTT(true);
  }, [handleVoiceCommand]);

  const stopPTT = useCallback(() => {
    recognitionRef.current?.stop();
    setIsPTT(false);
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopCamera();
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, [stopCamera]);

  const hasSpeech = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  return (
    <div className={styles.root}>

      {/* ── Video area ─────────────────────────────────────────────── */}
      <div className={styles.videoArea}>
        {/* カメラプレビュー */}
        <video
          ref={previewRef}
          className={styles.video}
          style={{ display: phase === 'previewing' || phase === 'recording' ? 'block' : 'none' }}
          playsInline
          muted
        />
        {/* リプレイ */}
        <video
          ref={replayRef}
          className={styles.video}
          style={{ display: phase === 'replay' ? 'block' : 'none' }}
          src={replayUrl ?? undefined}
          playsInline
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />
        {/* 骨格キャンバス */}
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ display: phase === 'replay' && vizMode !== 'off' ? 'block' : 'none' }}
        />
        {/* アイドル時プレースホルダー */}
        {phase === 'idle' && (
          <div className={styles.placeholder}>
            <span className={styles.placeholderIcon}>🎬</span>
            <p>カメラを起動して練習を録画</p>
          </div>
        )}
        {/* 録画中バッジ */}
        {phase === 'recording' && (
          <div className={styles.recBadge}>● REC {fmtTime(recSecs)}</div>
        )}
        {/* 音声認識結果トースト */}
        {voiceResult && (
          <div className={styles.voiceToast}>「{voiceResult}」</div>
        )}
      </div>

      {/* ── Controls ──────────────────────────────────────────────── */}
      <div className={styles.controls}>

        {/* メインアクション */}
        <div className={styles.mainBtns}>
          {phase === 'idle' && (
            <button className={`${styles.bigBtn} ${styles.btnCamera}`} onClick={startCamera}>
              📷 カメラ起動
            </button>
          )}
          {phase === 'previewing' && (
            <button className={`${styles.bigBtn} ${styles.btnRec}`} onClick={startRecording}>
              🔴 録画開始
            </button>
          )}
          {phase === 'recording' && (
            <button className={`${styles.bigBtn} ${styles.btnStop}`} onClick={stopRecording}>
              ⏹ 録画停止
            </button>
          )}
          {phase === 'replay' && (
            <>
              <button className={`${styles.bigBtn} ${styles.btnPlay}`} onClick={toggleReplay}>
                {isPlaying ? '⏸ 一時停止' : '▶ リプレイ'}
              </button>
              <button className={`${styles.bigBtn} ${styles.btnRec}`} onClick={startCamera}>
                🔴 再録画
              </button>
            </>
          )}
        </div>

        {/* 速度 + 骨格（replay 時のみ） */}
        {phase === 'replay' && (
          <div className={styles.subBtns}>
            {([0.5, 1.0, 1.5] as const).map(r => (
              <button
                key={r}
                className={`${styles.speedBtn} ${playbackRate === r ? styles.speedBtnActive : ''}`}
                onClick={() => setPlaybackRate(r)}
              >
                {r}x
              </button>
            ))}
            <button
              className={`${styles.speedBtn} ${vizMode !== 'off' ? styles.speedBtnActive : ''}`}
              onClick={() => setVizMode(v => v === 'off' ? 'full' : 'off')}
            >
              🦴 骨格
            </button>
          </div>
        )}

        {/* Push-to-talk */}
        {phase !== 'idle' && hasSpeech && (
          <button
            className={`${styles.pttBtn} ${isPTT ? styles.pttBtnActive : ''}`}
            onPointerDown={startPTT}
            onPointerUp={stopPTT}
            onPointerLeave={stopPTT}
          >
            🎤 {isPTT ? '認識中...' : '音声コマンド（押しながら話す）'}
          </button>
        )}

        {/* ヒント */}
        {phase !== 'idle' && (
          <p className={styles.hint}>
            {phase === 'previewing' && '「録画」で開始'}
            {phase === 'recording' && '「終了」または「停止」で録画停止'}
            {phase === 'replay' && '「リプレイ」再生 ／ 「スロー」0.5x ／ 「骨格」切替'}
          </p>
        )}
      </div>
    </div>
  );
}
