import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type {
  RawPoseLog, AnnotatedFrame, AnnotatedPoseLog, AnnotationLabel,
} from '../types/pose';
import { POSE_CONNECTIONS } from '../types/pose';
import { requestDriveWriteToken, getStoredToken } from '../engine/googleAuth';
import { findOrCreateFolder, uploadJsonFile, listFilesInFolder, fetchFileBlob, DriveApiError } from '../engine/googleDrive';
import { buildTrainingData, trainModel, saveModel, loadModel, modelToJson } from '../engine/poseClassifier';
import styles from './AnnotationTool.module.css';

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '') as string;
const DRIVE_FOLDER = 'salsa_annotations';
const TRAINED_KEY  = 'salsa_trained_files';


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

// ── ラベル定義 ────────────────────────────────────────────────────────────
const LABEL_DISPLAY: Record<AnnotationLabel, string> = {
  standard_pos:    '正常',
  swapped_pos:     'ID反転',
  single_leader:   'L単体',
  single_follower: 'F単体',
  overlap_L_front: 'L手前',
  overlap_F_front: 'F手前',
  side_L_right:    'L右・F左',
  side_L_left:     'L左・F右',
  complex_turn:    '回転中',
  ignore_trash:    '破棄',
  skip:            'skip',
};

const LABEL_COLOR: Record<AnnotationLabel, string> = {
  standard_pos:    '#44ff88',
  swapped_pos:     '#ffaa00',
  single_leader:   '#4488ff',
  single_follower: '#ff44cc',
  overlap_L_front: '#ff4466',
  overlap_F_front: '#ff7744',
  side_L_right:    '#44ffee',
  side_L_left:     '#00ccbb',
  complex_turn:    '#ffee44',
  ignore_trash:    '#555',
  skip:            '#333',
};

// キー→ラベルのマッピング
const KEY_LABEL: Record<string, AnnotationLabel> = {
  '2': 'swapped_pos',
  '3': 'single_leader',
  '4': 'single_follower',
  '5': 'overlap_L_front',
  '6': 'overlap_F_front',
  '7': 'side_L_right',
  '9': 'side_L_left',
  '8': 'complex_turn',
  '0': 'ignore_trash',
};

export function AnnotationTool() {
  const navigate  = useNavigate();
  const location  = useLocation();

  // ── ファイル・フレーム状態 ───────────────────────────────────────────────
  const [log, setLog]             = useState<RawPoseLog | null>(null);
  const [fileName, setFileName]   = useState('');
  const [frames, setFrames]       = useState<AnnotatedFrame[]>([]);
  const [idx, setIdx]             = useState(0);

  // ── Google Drive ────────────────────────────────────────────────────────
  const [driveToken,    setDriveToken]    = useState<string | null>(null);
  const [uploadStatus,  setUploadStatus]  = useState<'idle'|'uploading'|'done'|'error'>('idle');

  // ── ML 学習 ──────────────────────────────────────────────────────────────
  type TrainPhase = 'idle' | 'fetching' | 'confirm' | 'training' | 'done' | 'aborted' | 'error';
  const [trainPhase,      setTrainPhase]      = useState<TrainPhase>('idle');
  const [trainableFiles,  setTrainableFiles]  = useState<{ id: string; name: string }[]>([]);
  const [trainFileIdx,    setTrainFileIdx]    = useState(0);  // 処理中ファイル番号
  const [trainEpochPct,   setTrainEpochPct]   = useState(0);  // 0–100
  const [trainLog,        setTrainLog]        = useState('');
  const [trainSummary,    setTrainSummary]    = useState('');
  const [_driveFileCount, setDriveFileCount]  = useState(0);  // Drive の全 JSON 件数（デバッグ用）
  const abortRef = useRef(false);
  const localTrainInputRef = useRef<HTMLInputElement>(null);

  // マウント時に有効なトークンを復元（アプリ更新後も再認証不要）
  useEffect(() => {
    const stored = getStoredToken();
    if (stored) setDriveToken(stored);
  }, []);

  const connectDrive = useCallback(async () => {
    if (!CLIENT_ID) { alert('VITE_GOOGLE_CLIENT_ID が未設定です'); return; }
    try {
      const token = await requestDriveWriteToken(CLIENT_ID);
      setDriveToken(token);
    } catch {
      alert('Google Drive の接続に失敗しました');
    }
  }, []);

  // 学習済みファイル名を localStorage で管理
  const getTrainedSet = (): Set<string> => {
    try { return new Set(JSON.parse(localStorage.getItem(TRAINED_KEY) ?? '[]')); }
    catch { return new Set(); }
  };
  const markTrained = (name: string) => {
    const s = getTrainedSet(); s.add(name);
    localStorage.setItem(TRAINED_KEY, JSON.stringify([...s]));
  };

  const MODEL_DRIVE_FILENAME = 'salsa_role_model.json';

  // 学習済みモデルを IndexedDB + Drive に保存
  const saveModelToDriveIfConnected = useCallback(async (model: import('../engine/poseClassifier').RoleModel) => {
    await saveModel(model);
    if (!driveToken) return;
    try {
      setTrainLog(prev => prev + '\nDrive にモデルをアップロード中…');
      const json = await modelToJson(model);
      const folderId = await findOrCreateFolder(driveToken, DRIVE_FOLDER);
      await uploadJsonFile(driveToken, folderId, MODEL_DRIVE_FILENAME, json);
      setTrainLog(prev => prev + '\nDrive アップロード完了 ✓');
    } catch {
      setTrainLog(prev => prev + '\nDrive アップロード失敗（ローカルには保存済）');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveToken]);

  // ── ローカルファイルから直接学習（Drive未使用 or フォールバック）
  const handleTrainFromLocal = useCallback(async (files: FileList) => {
    abortRef.current = false;
    setTrainPhase('training');
    setTrainEpochPct(0);
    setTrainFileIdx(0);
    let processedCount = 0;
    let totalSamples = 0;

    const fileArray = Array.from(files);
    for (let i = 0; i < fileArray.length; i++) {
      if (abortRef.current) break;
      const file = fileArray[i];
      setTrainLog(`(${i + 1}/${fileArray.length}) ${file.name} を読み込み中…`);
      setTrainFileIdx(i);
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as AnnotatedPoseLog;
        if (parsed.version !== 'salsa_annotated_v1') {
          setTrainLog(`スキップ: ${file.name} (salsa_annotated_v1 形式ではありません)`);
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        const { xs, ys, sampleCount, breakdown } = buildTrainingData([parsed]);
        const bdText = Object.entries(breakdown).map(([k, v]) => `${k}:${v}`).join(' ');
        if (sampleCount < 6) {
          setTrainLog(`サンプル不足(${sampleCount})、スキップ: ${file.name}\n対象ラベル: standard_pos / side_L_right / side_L_left のみ\n検出内訳: ${bdText || 'なし'}`);
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
        setTrainLog(`(${i + 1}/${fileArray.length}) ${file.name} — ${sampleCount}サンプル 学習中…\n内訳: ${bdText}`);
        const model = await trainModel(xs, ys, (epoch, total, loss, acc) => {
          setTrainEpochPct(Math.round((epoch / total) * 100));
          setTrainLog(
            `(${i + 1}/${fileArray.length}) ${file.name}\n` +
            `Epoch ${epoch}/${total}  loss=${loss.toFixed(4)}  acc=${(acc * 100).toFixed(1)}%`
          );
        }, () => abortRef.current);
        await saveModelToDriveIfConnected(model);
        markTrained(file.name);
        processedCount++;
        totalSamples += sampleCount;
      } catch (e) {
        setTrainLog(`エラー(${file.name}): ${e instanceof Error ? e.message : String(e)}`);
        await new Promise(r => setTimeout(r, 800));
      }
    }

    if (abortRef.current) {
      setTrainSummary(`中断 — ${processedCount}/${fileArray.length}件処理（${totalSamples}サンプル）`);
      setTrainPhase('aborted');
    } else {
      setTrainSummary(`完了 — ${processedCount}件処理（計${totalSamples}サンプル）`);
      setTrainPhase('done');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Step1: Drive から未学習ファイルを取得してconfirmモーダルを表示
  const handleTrainOpen = useCallback(async () => {
    if (!driveToken) { alert('先に Google Drive を連携してください（ヘッダーの Drive ボタン）'); return; }
    setTrainPhase('fetching');
    setTrainLog('Drive からファイルを取得中…');
    try {
      const folderId = await findOrCreateFolder(driveToken, DRIVE_FOLDER);
      const files = await listFilesInFolder(driveToken, folderId);
      setDriveFileCount(files.length);
      const trained = getTrainedSet();
      const untrained = files.filter(f =>
        f.name.startsWith('salsa_annotated_v1') && !trained.has(f.name)
      );
      const alreadyTrained = files.filter(f =>
        f.name.startsWith('salsa_annotated_v1') && trained.has(f.name)
      );
      if (untrained.length === 0) {
        const nonAnnotated = files.filter(f => !f.name.startsWith('salsa_annotated_v1'));
        let msg = `Drive に ${files.length} 件のファイルがあります。\n`;
        if (alreadyTrained.length > 0) msg += `学習済み: ${alreadyTrained.length} 件\n`;
        if (nonAnnotated.length > 0) msg += `annotated_v1 以外(学習対象外): ${nonAnnotated.length} 件\n`;
        msg += '\n未学習の salsa_annotated_v1_*.json がありません。\nAnnotation 画面で Export してください。';
        setTrainLog(msg);
        setTrainPhase('done');
        setTrainSummary('新規ファイルなし');
        return;
      }
      setTrainableFiles(untrained);
      setTrainPhase('confirm');
    } catch (e) {
      setTrainLog(`取得失敗: ${e instanceof Error ? e.message : String(e)}`);
      setTrainPhase('error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveToken]);

  // ── Step2: 学習実行（ファイルごとに逐次処理）
  const handleTrainStart = useCallback(async () => {
    if (!driveToken) return;
    abortRef.current = false;
    setTrainPhase('training');
    setTrainEpochPct(0);

    await loadModel(); // 将来の incremental learning 用に読み込んでおく（現状未使用）
    let processedCount = 0;
    let totalSamples = 0;

    for (let i = 0; i < trainableFiles.length; i++) {
      if (abortRef.current) break;
      const file = trainableFiles[i];
      setTrainFileIdx(i);
      setTrainLog(`(${i + 1}/${trainableFiles.length}) ${file.name} を読み込み中…`);

      try {
        const blob = await fetchFileBlob(driveToken, file.id);
        const text = await blob.text();
        const parsed = JSON.parse(text) as AnnotatedPoseLog;
        if (parsed.version !== 'salsa_annotated_v1') { markTrained(file.name); continue; }

        const { xs, ys, sampleCount } = buildTrainingData([parsed]);
        if (sampleCount < 6) {
          setTrainLog(`(${i + 1}/${trainableFiles.length}) ${file.name} — サンプル不足(${sampleCount})、スキップ`);
          markTrained(file.name);
          await new Promise(r => setTimeout(r, 400));
          continue;
        }

        setTrainLog(`(${i + 1}/${trainableFiles.length}) ${file.name} — ${sampleCount}サンプル 学習中…`);
        setTrainEpochPct(0);

        // TODO: 既存モデルの重みを引き継ぐ incremental learning は将来対応
        // 現状は全サンプルを集約して再学習
        const model = await trainModel(xs, ys, (epoch, total, loss, acc) => {
          setTrainEpochPct(Math.round((epoch / total) * 100));
          setTrainLog(
            `(${i + 1}/${trainableFiles.length}) ${file.name}\n` +
            `Epoch ${epoch}/${total}  loss=${loss.toFixed(4)}  acc=${(acc * 100).toFixed(1)}%`
          );
        }, () => abortRef.current);

        await saveModelToDriveIfConnected(model);
        markTrained(file.name);
        processedCount++;
        totalSamples += sampleCount;
      } catch (e) {
        setTrainLog(`エラー(${file.name}): ${e instanceof Error ? e.message : String(e)}`);
        await new Promise(r => setTimeout(r, 800));
      }
    }

    if (abortRef.current) {
      setTrainSummary(`中断 — ${processedCount}/${trainableFiles.length}件処理（${totalSamples}サンプル）`);
      setTrainPhase('aborted');
    } else {
      setTrainSummary(`完了 — ${processedCount}件処理（計${totalSamples}サンプル）`);
      setTrainPhase('done');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveToken, trainableFiles]);

  // ── Video overlay ────────────────────────────────────────────────────────
  const [videoUrl, setVideoUrl]     = useState<string | null>(null);
  const [videoName, setVideoName]   = useState('');
  const videoRef        = useRef<HTMLVideoElement>(null);
  const videoInputRef   = useRef<HTMLInputElement>(null);

  // ── Canvas ───────────────────────────────────────────────────────────────
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const touchStartX  = useRef<number | null>(null);
  const seekCleanup  = useRef<(() => void) | null>(null);
  // 動画のネイティブ解像度（アスペクト比補正用）
  const [canvasDims, setCanvasDims] = useState<{ w: number; h: number }>({ w: 480, h: 640 });

  // ── 動画読み込み ────────────────────────────────────────────────────────
  const handleVideoLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(file));
    setVideoName(file.name);
    e.target.value = '';
  }, [videoUrl]);

  // videoUrl 変更時に iOS でも確実にロードを開始させる
  useEffect(() => {
    if (videoRef.current && videoUrl) {
      videoRef.current.load();
    }
  }, [videoUrl]);

  // ── ログ適用ヘルパー ────────────────────────────────────────────────────
  const applyLog = useCallback((parsed: RawPoseLog) => {
    setLog(parsed);
    setFileName(parsed.videoName);
    setFrames(parsed.frames.map(f => ({ ...f, label: 'skip' as AnnotationLabel })));
    setIdx(0);
    // videoWidth/videoHeight が記録されていればキャンバスサイズを合わせる
    if (parsed.videoWidth && parsed.videoHeight) {
      const W = 480;
      const H = Math.round(W * parsed.videoHeight / parsed.videoWidth);
      setCanvasDims({ w: W, h: H });
    }
  }, []);

  // ── ファイル読み込み ────────────────────────────────────────────────────
  const handleFileLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as RawPoseLog;
        if (parsed.version !== 'salsa_raw_v2') {
          alert('salsa_raw_v2 形式のファイルを選択してください');
          return;
        }
        applyLog(parsed);
      } catch {
        alert('JSONの解析に失敗しました');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [applyLog]);

  // ── FilePlayer からの引き継ぎ（navigation state）─────────────────────────
  useEffect(() => {
    const state = location.state as { rawLog?: RawPoseLog; videoUrl?: string; videoName?: string } | null;
    if (!state?.rawLog) return;
    const parsed = state.rawLog;
    if (parsed.version !== 'salsa_raw_v2') return;
    applyLog(parsed);
    if (state.videoUrl) {
      setVideoUrl(state.videoUrl);
      setVideoName(state.videoName ?? parsed.videoName);
    }
    window.history.replaceState({}, '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Canvas 描画（骨格 + 動画シーク）────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const frame = frames[idx];
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cw = canvas.width, ch = canvas.height;

    // 前のシークリスナーをキャンセル
    seekCleanup.current?.();
    seekCleanup.current = null;

    const drawOverlays = () => {
      frame.poses.forEach((pose, pi) => {
        drawSkeleton(ctx, pose.landmarks, cw, ch, COLORS[pi % COLORS.length]);
      });
      const lbl = frame.label;
      if (lbl !== 'skip') {
        ctx.font = 'bold 14px monospace';
        ctx.fillStyle = LABEL_COLOR[lbl];
        ctx.fillText(LABEL_DISPLAY[lbl], 8, 20);
      }
    };

    const video = videoRef.current;
    if (video && videoUrl) {
      let cancelled = false;

      const paint = () => {
        if (cancelled) return;
        ctx.drawImage(video, 0, 0, cw, ch);
        drawOverlays();
      };

      let seekTimer: ReturnType<typeof setTimeout> | null = null;

      const onSeeked = () => {
        if (seekTimer !== null) clearTimeout(seekTimer);
        video.removeEventListener('seeked', onSeeked);
        paint();
      };

      // iOS では seeked が発火しないことがあるため 2 秒後に強制描画
      const scheduleFallback = () => {
        seekTimer = setTimeout(() => {
          video.removeEventListener('seeked', onSeeked);
          paint();
        }, 2000);
      };

      seekCleanup.current = () => {
        cancelled = true;
        if (seekTimer !== null) clearTimeout(seekTimer);
        video.removeEventListener('seeked', onSeeked);
      };

      // 動画がメタデータを読み込んでいない場合はロード待ち
      if (video.readyState === 0) {
        const onLoaded = () => {
          video.removeEventListener('loadedmetadata', onLoaded);
          if (cancelled) return;
          video.addEventListener('seeked', onSeeked);
          scheduleFallback();
          video.currentTime = frame.t;
        };
        video.addEventListener('loadedmetadata', onLoaded);
        seekCleanup.current = () => {
          cancelled = true;
          if (seekTimer !== null) clearTimeout(seekTimer);
          video.removeEventListener('loadedmetadata', onLoaded);
          video.removeEventListener('seeked', onSeeked);
        };
      } else if (Math.abs(video.currentTime - frame.t) < 0.016) {
        // すでに正しい位置にいる（1フレーム以内）
        paint();
      } else {
        video.addEventListener('seeked', onSeeked);
        scheduleFallback();
        video.currentTime = frame.t;
      }
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, cw, ch);
      drawOverlays();
    }

    return () => {
      seekCleanup.current?.();
      seekCleanup.current = null;
    };
  }, [idx, videoUrl, frames]);

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

  // ── スワイプナビ（スマホ用）───────────────────────────────────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) > 48) dx < 0 ? goTo(1) : goTo(-1);
  }, [goTo]);

  // ── キーボード操作 ───────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;

      const label = KEY_LABEL[e.key];
      if (label) { applyLabel(label); return; }

      switch (e.key) {
        case ' ': case 'ArrowRight': goTo(1);  e.preventDefault(); break;
        case 'ArrowLeft':            goTo(-1); break;
        case 'Backspace':            goTo(-1); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [applyLabel, goTo]);

  // ── エクスポート ─────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!log || frames.length === 0) return;
    // swapped_pos → poses を入れ替えて standard_pos に変換
    const exportFrames = frames.map(f => {
      if (f.label === 'swapped_pos' && f.poses.length >= 2) {
        return { ...f, label: 'standard_pos' as AnnotationLabel, poses: [f.poses[1], f.poses[0]] };
      }
      return f;
    });
    const labeled = exportFrames.filter(f => f.label !== 'skip');
    const output: AnnotatedPoseLog = {
      version: 'salsa_annotated_v1',
      sourceFile: fileName,
      annotatedAt: new Date().toISOString(),
      totalFrames: frames.length,
      labeledFrames: labeled.length,
      frames: exportFrames,
    };
    const json = JSON.stringify(output, null, 2);
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `salsa_annotated_v1_${ts}.json`;

    // ローカルダウンロード
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Drive アップロード（連携済みの場合）
    if (driveToken) {
      setUploadStatus('uploading');
      try {
        const folderId = await findOrCreateFolder(driveToken, DRIVE_FOLDER);
        await uploadJsonFile(driveToken, folderId, filename, json);
        setUploadStatus('done');
        setTimeout(() => setUploadStatus('idle'), 3000);
      } catch (e) {
        setUploadStatus('error');
        if (e instanceof DriveApiError && e.status === 401) setDriveToken(null);
      }
    }
  }, [log, frames, fileName, driveToken]);

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
        <button
          className={styles.backBtn}
          onClick={async () => {
            if (labeled === 0) { navigate('/'); return; }
            const choice = window.confirm(
              `ラベル済み ${labeled} フレームがあります。\n\nOK → エクスポートしてから戻る\nキャンセル → 保存せずに戻る`
            );
            if (choice) { await handleExport(); }
            navigate('/');
          }}
        >← Back</button>
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
          {CLIENT_ID && (
            <button
              className={`${styles.loadBtn} ${driveToken ? styles.loadBtnActive : ''}`}
              onClick={connectDrive}
              title={driveToken ? `Drive 連携済み — ${DRIVE_FOLDER}/` : 'Google Drive に接続してエクスポートを自動保存'}
            >
              {driveToken ? 'Drive ✓' : 'Drive'}
            </button>
          )}
          <button
            className={styles.exportBtn}
            onClick={handleExport}
            disabled={labeled === 0}
            title={`${labeled} フレームをエクスポート${driveToken ? ' + Drive へアップロード' : ''}`}
          >
            {uploadStatus === 'uploading' ? '↑ Drive...' :
             uploadStatus === 'done'      ? '✓ Done'    :
             uploadStatus === 'error'     ? '✗ Error'   :
             `Export (${labeled})`}
          </button>
          {/* Train ボタン */}
          <button
            className={styles.loadBtn}
            style={{ color: '#cc88ff', borderColor: '#664488' }}
            onClick={driveToken ? handleTrainOpen : () => localTrainInputRef.current?.click()}
            title={driveToken ? 'Drive の未学習アノテーション JSON を取得して ML モデルを学習' : 'ローカルの salsa_annotated_v1_*.json を選択して学習'}
          >
            {trainPhase === 'done' ? 'Train ✓' : trainPhase === 'error' ? 'Train ✗' : 'Train'}
          </button>
          <input
            ref={localTrainInputRef}
            type="file" accept=".json" multiple style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.length) { handleTrainFromLocal(e.target.files); e.target.value = ''; } }}
          />
        </div>
      </header>

      {/* ── ソースファイル名 ── */}
      {fileName && (
        <div className={styles.fileInfo}>
          📂 {fileName} — {frames.length} frames ({log?.samplingMs}ms)
          {driveToken && <span className={styles.fileInfoDrive}> ☁ Drive: {DRIVE_FOLDER}/</span>}
        </div>
      )}

      {/* ── 隠し動画要素（display:none は iOS で preload が効かないため visually-hidden にする）── */}
      {videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          style={{
            position: 'absolute',
            width: '1px',
            height: '1px',
            opacity: 0,
            pointerEvents: 'none',
            top: 0,
            left: 0,
          }}
          preload="auto"
          playsInline
          muted
          onLoadedMetadata={() => {
            // メタデータロード完了 → 現在の idx で描画を再トリガー
            setIdx(i => i);
          }}
        />
      )}

      {/* ── キャンバスエリア（flex:1 で残り全高を使う）── */}
      <div className={styles.canvasArea}>
        <div
          className={styles.canvasWrap}
          style={{ aspectRatio: `${canvasDims.w} / ${canvasDims.h}` }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <canvas
            ref={canvasRef}
            width={canvasDims.w}
            height={canvasDims.h}
            className={styles.canvas}
          />
          {!log && (
            <div className={styles.placeholder}>
              <p>JSON を読み込んでください</p>
              <p className={styles.placeholderSub}>salsa_raw_v2_*.json</p>
            </div>
          )}
          {/* フレーム情報オーバーレイ */}
          {currentFrame && (
            <div className={styles.frameOverlay}>
              <span>{idx + 1}/{frames.length}</span>
              <span>t={currentFrame.t.toFixed(2)}s</span>
              {currentFrame.label !== 'skip' && (
                <span style={{ color: LABEL_COLOR[currentFrame.label] }}>
                  {LABEL_DISPLAY[currentFrame.label]}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── コントロール（画面下部に固定）── */}
      <div className={styles.controls}>
        {/* プログレスバー */}
        <div className={styles.progressWrap}>
          <div className={styles.progressBar} style={{ width: `${progress}%` }} />
        </div>

        {/* アクションボタン */}
        <div className={styles.actionRow}>
          {(Object.entries(KEY_LABEL) as [string, AnnotationLabel][])
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, label]) => (
              <button
                key={label}
                className={styles.actionBtn}
                onClick={() => applyLabel(label)}
                style={{
                  borderColor: LABEL_COLOR[label],
                  color: LABEL_COLOR[label],
                  background: `${LABEL_COLOR[label]}18`,
                }}
              >
                <span className={styles.key}>{key}</span>
                {LABEL_DISPLAY[label]}
              </button>
            ))}
        </div>

        {/* ナビゲーション + 統計 */}
        <div className={styles.navRow}>
          <button className={styles.navBtn} onClick={() => goTo(-1)} disabled={idx === 0}>← Prev</button>
          <span className={styles.navCount}>
            {frames.length > 0 ? `${idx + 1}/${frames.length}` : '—'}
            {frames.length > 0 && (
              <span className={styles.navStats}>
                {(Object.keys(LABEL_DISPLAY) as AnnotationLabel[])
                  .filter(k => k !== 'skip' && (stats[k] ?? 0) > 0)
                  .map(k => (
                    <span key={k} style={{ color: LABEL_COLOR[k] }}> {LABEL_DISPLAY[k]}:{stats[k]}</span>
                  ))}
              </span>
            )}
          </span>
          <button className={styles.navBtn} onClick={() => goTo(1)} disabled={idx >= frames.length - 1}>Next →</button>
        </div>

        {/* キーボードヘルプ（PCのみ）*/}
        <div className={styles.keyHelp}>
          {(Object.entries(KEY_LABEL) as [string, AnnotationLabel][])
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, lbl]) => (
              <span key={k} style={{ color: LABEL_COLOR[lbl] }}>{k}:{LABEL_DISPLAY[lbl]}</span>
            ))}
          <span>←→/Space:移動</span>
        </div>
      </div>
      {/* ── ML 学習モーダル ── */}
      {trainPhase !== 'idle' && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100,
        }}>
          <div style={{
            background: '#111122', border: '1px solid #446', borderRadius: 12,
            padding: '24px 28px', width: 340, maxWidth: '92vw',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            {/* タイトル */}
            <div style={{ fontWeight: 'bold', color: '#cc88ff', fontSize: 14 }}>
              {trainPhase === 'fetching'  ? '📂 Drive を確認中…'  :
               trainPhase === 'confirm'   ? `📋 未学習ファイル ${trainableFiles.length}件` :
               trainPhase === 'training'  ? '🤖 学習中'            :
               trainPhase === 'done'      ? '✅ 完了'               :
               trainPhase === 'aborted'   ? '⏹ 中断しました'       :
                                           '❌ エラー'}
            </div>

            {/* confirm: ファイルリスト */}
            {trainPhase === 'confirm' && (
              <div style={{
                maxHeight: 160, overflowY: 'auto',
                background: '#0a0a18', borderRadius: 6, padding: '6px 8px',
                fontSize: 11, color: '#88aacc', fontFamily: 'monospace',
              }}>
                {trainableFiles.map(f => (
                  <div key={f.id} style={{ padding: '2px 0', borderBottom: '1px solid #1a1a2a' }}>
                    {f.name}
                  </div>
                ))}
              </div>
            )}

            {/* training: エポック進捗バー */}
            {trainPhase === 'training' && (
              <>
                <div style={{ background: '#222', borderRadius: 4, height: 6 }}>
                  <div style={{
                    height: '100%', borderRadius: 4,
                    background: 'linear-gradient(90deg,#8844ff,#cc44ff)',
                    width: `${trainEpochPct}%`, transition: 'width 0.3s',
                  }} />
                </div>
                {/* ファイル進捗 */}
                <div style={{ background: '#222', borderRadius: 4, height: 3 }}>
                  <div style={{
                    height: '100%', borderRadius: 4, background: '#446688',
                    width: `${Math.round(((trainFileIdx) / Math.max(trainableFiles.length, 1)) * 100)}%`,
                  }} />
                </div>
              </>
            )}

            {/* ログテキスト */}
            <div style={{
              fontSize: 11, color: '#aab', fontFamily: 'monospace',
              whiteSpace: 'pre-wrap', minHeight: 28, lineHeight: 1.5,
            }}>
              {trainPhase === 'done' || trainPhase === 'aborted' ? trainSummary : trainLog}
            </div>

            {/* ボタン */}
            <div style={{ display: 'flex', gap: 8 }}>
              {trainPhase === 'confirm' && (
                <>
                  <button onClick={handleTrainStart} style={{
                    flex: 1, padding: '8px 0', background: '#2a1a4a',
                    border: '1px solid #8844ff', color: '#cc88ff',
                    borderRadius: 6, cursor: 'pointer', fontWeight: 'bold',
                  }}>
                    学習開始
                  </button>
                  <button onClick={() => { setTrainPhase('idle'); setTrainLog(''); }} style={{
                    flex: 1, padding: '8px 0', background: '#222',
                    border: '1px solid #446', color: '#aab', borderRadius: 6, cursor: 'pointer',
                  }}>
                    キャンセル
                  </button>
                </>
              )}
              {trainPhase === 'training' && (
                <button onClick={() => { abortRef.current = true; setTrainLog(prev => prev + '\n中断リクエスト…'); }} style={{
                  flex: 1, padding: '8px 0', background: '#2a0a0a',
                  border: '1px solid #884444', color: '#ff8888',
                  borderRadius: 6, cursor: 'pointer',
                }}>
                  中断
                </button>
              )}
              {(trainPhase === 'done' || trainPhase === 'aborted' || trainPhase === 'error') && (
                <>
                  {/* Drive に対象ファイルなし → ローカル選択フォールバック */}
                  {trainPhase === 'done' && trainSummary === '新規ファイルなし' && (
                    <button
                      onClick={() => { setTrainPhase('idle'); setTrainLog(''); setTrainSummary(''); localTrainInputRef.current?.click(); }}
                      style={{
                        width: '100%', padding: '8px 0', background: '#1a2a1a',
                        border: '1px solid #446633', color: '#88cc88',
                        borderRadius: 6, cursor: 'pointer', marginBottom: 4,
                      }}
                    >
                      📂 端末のファイルを選択して学習
                    </button>
                  )}
                  <button onClick={() => { setTrainPhase('idle'); setTrainLog(''); setTrainSummary(''); }} style={{
                    flex: 1, padding: '8px 0', background: '#222',
                    border: '1px solid #446', color: '#aab', borderRadius: 6, cursor: 'pointer',
                  }}>
                    閉じる
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm('学習済み履歴をリセットしますか？\n次回Train時にすべてのファイルが再度対象になります。')) {
                        localStorage.removeItem(TRAINED_KEY);
                        setTrainPhase('idle'); setTrainLog(''); setTrainSummary('');
                      }
                    }}
                    style={{
                      flex: 1, padding: '8px 0', background: '#1a0a0a',
                      border: '1px solid #663333', color: '#cc6666', borderRadius: 6, cursor: 'pointer',
                      fontSize: 11,
                    }}
                  >
                    履歴リセット
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
