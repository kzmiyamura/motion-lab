/**
 * フォルダ別MD解析指示書パイプラインの直列ジョブワーカー。
 * docs/folder-analysis-detailed-design.md §5 参照
 *
 * - 15秒ポーリングで queued ジョブを1件ずつ実行（直列）
 * - 既存の回転解析（analysisJob.ts）と相互排他
 * - サーバー起動時に running → queued リカバリ
 * - ジョブ単位タイムアウト（既定60分）
 * - P0: preset の cvSteps が空 & useClaude:false のためダミー完了する（配管の疎通確認用）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPathImport from 'ffmpeg-static';
import {
  claimNextJob, getVideo, markJobDone, markJobError, recoverStaleRunningJobs,
  type AnalysisJobRow,
} from './db.js';
import { isAnalysisRunning } from './analysisJob.js';
import { PRESETS, type JobContext } from './presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const JOBS_DIR = path.resolve(__dirname, '../storage/analysis-jobs');

// converter.ts と同じ理由のキャスト（CJSモジュールのdefault export型解決）
const ffmpegPath = ffmpegPathImport as unknown as string | null;

const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3';
const MODEL_PATH = process.env.POSE_MODEL_PATH
  ?? path.resolve(__dirname, '../models/pose_landmarker_heavy.task');
const POLL_INTERVAL_MS = 15_000;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 60 * 60 * 1000);

let busy = false;

/** ジョブ実行中かどうか（アップロード等の重い処理をブロックする判定に使う） */
export function isJobWorkerBusy(): boolean {
  return busy;
}

export function jobDirOf(jobId: string): string {
  return path.join(JOBS_DIR, jobId);
}

export function startJobWorker(): void {
  const recovered = recoverStaleRunningJobs();
  if (recovered > 0) console.log(`[jobWorker] recovered ${recovered} stale running job(s) -> queued`);
  setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  console.log(`[jobWorker] started (poll=${POLL_INTERVAL_MS}ms, timeout=${JOB_TIMEOUT_MS}ms)`);
}

async function tick(): Promise<void> {
  if (busy || isAnalysisRunning()) return; // 既存の回転解析とも同時実行しない
  const job = claimNextJob();
  if (!job) return;
  busy = true;
  try {
    await runJob(job);
  } catch (e) {
    // runJob 内で捕捉しきれなかった想定外エラーの最終防衛線
    markJobError(job.id, `[WORKER] ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
  }
}

/**
 * ROIデバッグ動画（OpenCV の mp4v はブラウザで再生不可）を H.264 へ変換する。
 * 変換成功時は生ファイルを削除。デバッグ用途なので失敗しても警告のみでジョブは止めない。
 */
async function transcodeDebugVideo(rawPath: string, outPath: string, signal: AbortSignal): Promise<void> {
  if (!existsSync(rawPath) || !ffmpegPath) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, ['-y', '-i', rawPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', outPath], { signal });
      proc.on('error', reject);
      proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    });
    rmSync(rawPath, { force: true });
  } catch (e) {
    console.warn(`[jobWorker] debug video transcode failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Pythonスクリプトを実行して終了を待つ。exit≠0 / タイムアウトで reject */
function runPython(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, args, { signal });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => reject(new Error(`python起動失敗: ${err.message}`)));
    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-2000) || `python exited with code ${code}`));
    });
  });
}

async function runJob(job: AnalysisJobRow): Promise<void> {
  console.log(`[jobWorker] running job ${job.id} (video=${job.video_id}, preset=${job.preset})`);
  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);

  // 1. preset 解決
  const preset = PRESETS[job.preset];
  if (!preset) {
    markJobError(job.id, `[SPEC] 未知の preset です: ${job.preset}`);
    return;
  }

  // 2. 作業ディレクトリ構築
  const jobDir = jobDirOf(job.id);
  const outDir = path.join(jobDir, 'out');
  const keyframesDir = path.join(outDir, 'keyframes');
  mkdirSync(keyframesDir, { recursive: true });
  writeFileSync(path.join(jobDir, 'spec.md'), job.spec_snapshot, 'utf-8');

  const videoPath = resolveVideoPath(job.video_id);
  if (!videoPath) {
    markJobError(job.id, '[WORKER] 元動画ファイルが見つかりません');
    return;
  }

  const ctx: JobContext = {
    jobId: job.id,
    videoPath,
    modelPath: MODEL_PATH,
    jobDir,
    measurementsPath: path.join(outDir, 'measurements.json'),
    debugVideoRawPath: path.join(outDir, 'debug_roi_raw.mp4'),
  };

  // 3. CVパス実行（直列）
  if (preset.cvSteps.length > 0 && !existsSync(MODEL_PATH)) {
    markJobError(job.id, `[CV] pose model not found: ${MODEL_PATH}。server/CLAUDE.md の手順でダウンロードしてください`);
    return;
  }
  try {
    for (const step of preset.cvSteps) {
      const scriptPath = path.resolve(__dirname, '../analysis', step.script);
      await runPython([scriptPath, ...step.args(ctx)], signal);
    }
    // contested 区間があれば各区間の {始点・中間・終点} のキーフレームを書き出す（Claude 裁定用）
    const contested = readContested(ctx.measurementsPath);
    if (contested.length > 0) {
      const times = contested.flatMap(seg => [seg.from, (seg.from + seg.to) / 2, seg.to]);
      const scriptPath = path.resolve(__dirname, '../analysis/extract_keyframes.py');
      await runPython([scriptPath, ctx.videoPath, keyframesDir, ...times.map(t => t.toFixed(2))], signal);
    }
    // ROIデバッグ動画（mp4v）をブラウザ再生可能な H.264 へ変換
    await transcodeDebugVideo(ctx.debugVideoRawPath, path.join(outDir, 'debug_roi.mp4'), signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markJobError(job.id, signal.aborted ? `[TIMEOUT] CVパスがタイムアウトしました` : `[CV] ${msg}`);
    return;
  }

  // 4. Claude 判断（P2 で claudeRunner を配線。P0/P1 は useClaude:false でスキップ）
  if (preset.useClaude) {
    markJobError(job.id, '[CLAUDE] claudeRunner は未実装です（P2 で実装予定）');
    return;
  }

  // 5. 完了（P1: CVサマリでレポート生成。P2 で Claude レポートに置き換わる）
  const { resultJson, reportMd } = buildCvOnlyReport(job, preset.cvSteps.length, ctx.measurementsPath);
  markJobDone(job.id, resultJson, reportMd);
  console.log(`[jobWorker] job ${job.id} done`);
}

interface ContestedSeg { from: number; to: number; reason: string }

interface MeasurementsSummary {
  slot0?: { shrMean: number | null; shrStd: number | null; samples: number; samplesAll?: number };
  slot1?: { shrMean: number | null; shrStd: number | null; samples: number; samplesAll?: number };
  verdictByRule?: {
    leaderExists: boolean;
    separation: number | null;
    highMean: number | null;
    lowMean: number | null;
    confidence: number;
    basis: string;
    leaderAtStart: { side: 'left' | 'right'; t: number } | null;
    highSideConsistency: number | null;
  };
  reliability?: { cleanPairFrames: number; allPairFrames: number; cleanRatio: number };
  contested?: ContestedSeg[];
  contestedDropped?: number;
}

function readContested(measurementsPath: string): ContestedSeg[] {
  try {
    const data = JSON.parse(readFileSync(measurementsPath, 'utf-8')) as { summary?: MeasurementsSummary };
    return data.summary?.contested ?? [];
  } catch {
    return [];
  }
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** CV計測のみのレポート（useClaude:false のプリセット用） */
function buildCvOnlyReport(job: AnalysisJobRow, cvStepCount: number, measurementsPath: string): { resultJson: string; reportMd: string } {
  if (cvStepCount === 0 || !existsSync(measurementsPath)) {
    // 配管テスト（CV未配線プリセット）
    return {
      resultJson: JSON.stringify({ pipeline: 'p0-plumbing', preset: job.preset, cvSteps: cvStepCount, hasMeasurements: false }),
      reportMd: [
        `# 解析レポート（配管テスト）`,
        ``,
        `- ジョブID: ${job.id}`,
        `- preset: ${job.preset}`,
        ``,
        `このジョブはパイプライン配管の疎通確認です。CV解析・LLM判断は未配線です。`,
      ].join('\n'),
    };
  }

  let summary: MeasurementsSummary = {};
  try {
    summary = (JSON.parse(readFileSync(measurementsPath, 'utf-8')) as { summary?: MeasurementsSummary }).summary ?? {};
  } catch { /* 壊れていても素のレポートを出す */ }

  const verdict = summary.verdictByRule;
  const contested = summary.contested ?? [];
  const rel = summary.reliability;
  const noPairs = (rel?.allPairFrames ?? 0) === 0;
  const leaderLabel = noPairs
    ? '判定不可（2人同時に検出できたフレームがありません）'
    : verdict?.leaderExists
      ? `SHRが高い側（分離 ${verdict.separation}、開始時は画面${verdict.leaderAtStart?.side === 'left' ? '左' : '右'}の人物）`
      : '判定できず（拮抗 — SHR分離が閾値未満）';

  const lines = [
    `# 解析レポート（CV計測のみ・LLM判断はP2で有効化）`,
    ``,
    `## サマリ`,
    ``,
    `- **Leader（ルールベースSHR判定）**: ${leaderLabel}`,
    `- 自信度: ${verdict ? Math.round(verdict.confidence * 100) : 0}%`,
    `- SHR: 高い側 ${verdict?.highMean ?? '—'} / 低い側 ${verdict?.lowMean ?? '—'}（フレーム内比較 — 人物追跡に依存しない）`,
    `- 判定母集団: ${verdict?.basis === 'clean' ? `クリーンフレームのみ（${rel?.cleanPairFrames ?? 0}フレーム、オクルージョン除外）` : verdict?.basis === 'all_frames_fallback' ? `全フレーム（クリーン不足のためフォールバック、${rel?.allPairFrames ?? 0}フレーム）` : '—'}`,
    `- クリーン率: ${rel ? Math.round(rel.cleanRatio * 100) : 0}%（低いほどオクルージョンが多くルールベースの信頼度が下がる）`,
    `- 高SHR側の位置一貫性: ${verdict?.highSideConsistency != null ? Math.round(verdict.highSideConsistency * 100) + '%' : '—'}（低い＝交差が多い動画）`,
    ``,
  ];
  if (contested.length > 0) {
    lines.push(`## 判定が難しかった区間（contested）`, ``, `| 区間 | 理由 |`, `|---|---|`);
    for (const seg of contested) {
      lines.push(`| ${fmtTime(seg.from)}〜${fmtTime(seg.to)} | ${seg.reason} |`);
    }
    if (summary.contestedDropped) {
      lines.push(``, `※ 他に ${summary.contestedDropped} 区間が上限超過で省略されています`);
    }
    lines.push(``, `キーフレームは out/keyframes/ に書き出し済み。P2 で Claude が裁定します。`);
  } else if (noPairs) {
    lines.push(`2人を同時に検出できなかったため判定できません。動画にペアが映っているか確認してください。`);
  } else {
    lines.push(`拮抗区間はありませんでした（ルールベース判定のみで確定）。`);
  }

  if (existsSync(path.join(jobDirOf(job.id), 'out/debug_roi.mp4'))) {
    lines.push(``, `## デバッグ動画`, ``,
      `背景マスク（ROI）と検出枠の可視化: [debug_roi.mp4](/analysis-output/${job.id}/out/debug_roi.mp4)`,
      `（金枠=ROI、緑枠=採用ペア、赤枠=除外した背景人物。ROI外はグレーで塗りつぶし）`);
  }

  return {
    resultJson: JSON.stringify({
      pipeline: 'p1-cv',
      preset: job.preset,
      verdictByRule: verdict ?? null,
      reliability: rel ?? null,
      contested,
    }),
    reportMd: lines.join('\n'),
  };
}

/** originals ディレクトリから動画ファイルの実パスを解決する（拡張子はDBの original_filename 由来） */
function resolveVideoPath(videoId: string): string | null {
  // routes/videos.ts と同じ規約: ORIGINALS_DIR/<id><ext>
  const originalsDir = path.resolve(__dirname, '../storage/originals');
  const row = getVideo(videoId);
  if (!row) return null;
  const ext = path.extname(row.original_filename) || '.mp4';
  const p = path.join(originalsDir, `${videoId}${ext}`);
  return existsSync(p) ? p : null;
}
