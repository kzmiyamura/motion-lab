import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  RawPoseLog, AnnotatedFrame, AnnotatedPoseLog, AnnotationLabel,
} from '../types/pose';
import { POSE_CONNECTIONS } from '../types/pose';
import styles from './AnnotationTool.module.css';

// ── ビデオフレームをキャンバスに描画（seekedイベント待ち）────────────────
function drawVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  targetTime: number,
  onDrawn: () => void,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const onSeeked = () => {
    video.removeEventListener('seeked', onSeeked);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onDrawn();
  };
  if (Math.abs(video.currentTime - targetTime) < 0.01) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onDrawn();
  } else {
    video.addEventListener('seeked', onSeeked);
    video.currentTime = targetTime;
  }
}

// ── 描画カラー ────────────────────────────────────────────────────────────
const COLORS = ['#4488ff', '#ff44cc', '#44ffaa', '#ffaa00'] as const;

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: { x: number; y: number; visibility?: number }[],
  cw: number, ch: number,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = 2;
  ctx.globalAlpha = 0.9;

  // 接続線
  for (const [s, e] of POSE_CONNECTIONS) {
    const a = landmarks[s], b = landmarks[e];
    if (!a || !b) continue;
    if ((a.visibility ?? 1) < 0.3 || (b.visibility ?? 1) < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * cw, a.y * ch);
    ctx.lineTo(b.x * cw, b.y * ch);
    ctx.stroke();
  }
  // 関節点
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < 0.3) continue;
    ctx.beginPath();
    ctx.arc(lm.x * cw, lm.y * ch, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ── ラベル表示名 ──────────────────────────────────────────────────────────
const LABEL_DISPLAY: Record<AnnotationLabel, string> = {
  ok: 'OK',
  swap: 'SWAP',
  single: 'SINGLE',
  overlap_leader_front: 'OVL:L-front',
  overlap_follower_front: 'OVL:F-front',
  skip: 'SKIP',
};

const LABEL_COLOR: Record<AnnotationLabel, string> = {
  ok: '#44ff88',
  swap: '#ffaa00',
  single: '#88aaff',
  overlap_leader_front: '#ff6688',
  overlap_follower_front: '#ff6688',
  skip: '#666',
};

export function AnnotationTool() {
  const navigate = useNavigate();

  // ── ファイル・フレーム状態 ───────────────────────────────────────────────
  const [log, setLog]             = useState<RawPoseLog | null>(null);
  const [fileName, setFileName]   = useState('');
  const [frames, setFrames]       = useState<AnnotatedFrame[]>([]);
  const [idx, setIdx]             = useState(0);
  const [overlapModal, setOverlapModal] = useState(false);

  // ── Video overlay ────────────────────────────────────────────────────────
  const [videoUrl, setVideoUrl]     = useState<string | null>(null);
  const [videoName, setVideoName]   = useState('');
  const videoRef        = useRef<HTMLVideoElement>(null);
  const videoInputRef   = useRef<HTMLInputElement>(null);

  // ── Canvas ───────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── 動画読み込み ────────────────────────────────────────────────────────
  const handleVideoLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(file));
    setVideoName(file.name);
    e.target.value = '';
  }, [videoUrl]);

  // ── ファイル読み込み ────────────────────────────────────────────────────
  const handleFileLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as RawPoseLog;
        if (parsed.version !== 'salsa_raw_v2') {
          alert('salsa_raw_v2 形式のファイルを選択してください');
          return;
        }
        setLog(parsed);
        setFrames(parsed.frames.map(f => ({ ...f, label: 'skip' as AnnotationLabel })));
        setIdx(0);
      } catch {
        alert('JSONの解析に失敗しました');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  // ── Canvas 描画 ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const frame = frames[idx];
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = canvas.width;
    const ch = canvas.height;

    const drawOverlays = () => {
      // 骨格描画
      frame.poses.forEach((pose, pi) => {
        drawSkeleton(ctx, pose.landmarks, cw, ch, COLORS[pi % COLORS.length]);
      });
      // 現フレームのラベルを左上に表示
      const lbl = frame.label;
      if (lbl !== 'skip') {
        ctx.font = 'bold 14px monospace';
        ctx.fillStyle = LABEL_COLOR[lbl];
        ctx.fillText(LABEL_DISPLAY[lbl], 8, 20);
      }
    };

    const video = videoRef.current;
    if (video && videoUrl) {
      drawVideoFrame(video, canvas, frame.t, drawOverlays);
    } else {
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, cw, ch);
      drawOverlays();
    }
  }, [frames, idx, videoUrl]);

  // ── ラベル付け ──────────────────────────────────────────────────────────
  const applyLabel = useCallback((label: AnnotationLabel) => {
    if (frames.length === 0) return;
    setFrames(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], label };
      return next;
    });
    // 次フレームへ自動進行
    setIdx(i => Math.min(i + 1, frames.length - 1));
  }, [frames.length, idx]);

  const goTo = useCallback((delta: number) => {
    setIdx(i => Math.max(0, Math.min(i + delta, frames.length - 1)));
  }, [frames.length]);

  // ── キーボード操作 ───────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;

      if (overlapModal) {
        if (e.key === 'l' || e.key === 'L') { applyLabel('overlap_leader_front'); setOverlapModal(false); }
        if (e.key === 'f' || e.key === 'F') { applyLabel('overlap_follower_front'); setOverlapModal(false); }
        if (e.key === 'Escape') setOverlapModal(false);
        return;
      }

      switch (e.key) {
        case '1': applyLabel('ok');     break;
        case '2': applyLabel('swap');   break;
        case '3': applyLabel('single'); break;
        case '4': setOverlapModal(true); break;
        case ' ': case 'ArrowRight': goTo(1);  e.preventDefault(); break;
        case 'ArrowLeft':            goTo(-1); break;
        case 'Backspace':            goTo(-1); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [overlapModal, applyLabel, goTo]);

  // ── エクスポート ─────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (!log || frames.length === 0) return;
    const labeled = frames.filter(f => f.label !== 'skip');
    const output: AnnotatedPoseLog = {
      version: 'salsa_annotated_v1',
      sourceFile: fileName,
      annotatedAt: new Date().toISOString(),
      totalFrames: frames.length,
      labeledFrames: labeled.length,
      frames,
    };
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href     = url;
    a.download = `salsa_annotated_v1_${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [log, frames, fileName]);

  // ── 統計 ────────────────────────────────────────────────────────────────
  const stats = frames.reduce((acc, f) => {
    acc[f.label] = (acc[f.label] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const labeled = frames.length - (stats['skip'] ?? frames.length);

  const currentFrame: AnnotatedFrame | undefined = frames[idx];
  const progress = frames.length > 0 ? ((idx + 1) / frames.length) * 100 : 0;

  return (
    <div className={styles.root}>
      {/* ── ヘッダー ── */}
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate('/')}>← Back</button>
        <h1 className={styles.title}>Salsa Pose Annotator</h1>
        <div className={styles.headerActions}>
          <label className={styles.loadBtn}>
            Load JSON
            <input type="file" accept=".json" onChange={handleFileLoad} hidden />
          </label>
          <button
            className={`${styles.loadBtn} ${videoUrl ? styles.loadBtnActive : ''}`}
            onClick={() => videoInputRef.current?.click()}
            title={videoName || '動画を読み込む'}
          >
            {videoUrl ? 'Video ✓' : 'Load Video'}
          </button>
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.avi,.mkv,.webm,.m4v"
            onChange={handleVideoLoad}
            style={{ display: 'none' }}
          />
          <button
            className={styles.exportBtn}
            onClick={handleExport}
            disabled={labeled === 0}
            title={`${labeled} フレームをエクスポート`}
          >
            Export ({labeled})
          </button>
        </div>
      </header>

      {/* ── ソースファイル名 ── */}
      {fileName && <div className={styles.fileInfo}>📂 {fileName} — {frames.length} frames ({log?.samplingMs}ms)</div>}

      {/* ── 隠し動画要素 ── */}
      {videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          style={{ display: 'none' }}
          preload="auto"
          playsInline
          muted
        />
      )}

      {/* ── キャンバス ── */}
      <div className={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          width={480}
          height={640}
          className={styles.canvas}
        />
        {!log && (
          <div className={styles.placeholder}>
            <p>JSON を読み込んでください</p>
            <p className={styles.placeholderSub}>salsa_raw_v2_*.json</p>
          </div>
        )}
        {overlapModal && (
          <div className={styles.overlapModal}>
            <div className={styles.overlapBox}>
              <p className={styles.overlapTitle}>Who is in FRONT?</p>
              <div className={styles.overlapBtns}>
                <button
                  className={`${styles.overlapBtn} ${styles.overlapBtnLeader}`}
                  onClick={() => { applyLabel('overlap_leader_front'); setOverlapModal(false); }}
                >
                  L — Leader
                </button>
                <button
                  className={`${styles.overlapBtn} ${styles.overlapBtnFollower}`}
                  onClick={() => { applyLabel('overlap_follower_front'); setOverlapModal(false); }}
                >
                  F — Follower
                </button>
              </div>
              <p className={styles.overlapHint}>Esc でキャンセル</p>
            </div>
          </div>
        )}
      </div>

      {/* ── フレーム情報 ── */}
      {currentFrame && (
        <div className={styles.frameInfo}>
          <span>Frame {idx + 1} / {frames.length}</span>
          <span>t = {currentFrame.t.toFixed(2)}s</span>
          <span>{currentFrame.poses.length} pose{currentFrame.poses.length !== 1 ? 's' : ''}</span>
          {currentFrame.label !== 'skip' && (
            <span style={{ color: LABEL_COLOR[currentFrame.label] }}>
              {LABEL_DISPLAY[currentFrame.label]}
            </span>
          )}
        </div>
      )}

      {/* ── プログレスバー ── */}
      <div className={styles.progressWrap}>
        <div className={styles.progressBar} style={{ width: `${progress}%` }} />
      </div>

      {/* ── アクションボタン ── */}
      <div className={styles.actionRow}>
        <button className={`${styles.actionBtn} ${styles.ok}`}       onClick={() => applyLabel('ok')}>
          <span className={styles.key}>1</span> OK
        </button>
        <button className={`${styles.actionBtn} ${styles.swap}`}     onClick={() => applyLabel('swap')}>
          <span className={styles.key}>2</span> SWAP
        </button>
        <button className={`${styles.actionBtn} ${styles.single}`}   onClick={() => applyLabel('single')}>
          <span className={styles.key}>3</span> SINGLE
        </button>
        <button className={`${styles.actionBtn} ${styles.overlap}`}  onClick={() => setOverlapModal(true)}>
          <span className={styles.key}>4</span> OVERLAP
        </button>
      </div>

      {/* ── ナビゲーション ── */}
      <div className={styles.navRow}>
        <button className={styles.navBtn} onClick={() => goTo(-1)} disabled={idx === 0}>← Prev</button>
        <button className={styles.navBtn} onClick={() => applyLabel('skip')}>Skip →</button>
        <button className={styles.navBtn} onClick={() => goTo(1)} disabled={idx >= frames.length - 1}>Next →</button>
      </div>

      {/* ── 統計 ── */}
      {frames.length > 0 && (
        <div className={styles.stats}>
          {(Object.keys(LABEL_DISPLAY) as AnnotationLabel[])
            .filter(k => k !== 'skip' && (stats[k] ?? 0) > 0)
            .map(k => (
              <span key={k} style={{ color: LABEL_COLOR[k] }}>
                {LABEL_DISPLAY[k]}: {stats[k] ?? 0}
              </span>
            ))}
          <span className={styles.statsSkip}>skip: {stats['skip'] ?? frames.length}</span>
        </div>
      )}

      {/* ── キーボードヘルプ ── */}
      <div className={styles.keyHelp}>
        <span>1:OK</span><span>2:SWAP</span><span>3:SINGLE</span><span>4:OVERLAP</span>
        <span>←→:移動</span><span>Space:次へ</span><span>Esc:キャンセル</span>
      </div>
    </div>
  );
}
