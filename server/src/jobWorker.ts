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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimNextJob, getVideo, markJobDone, markJobError, recoverStaleRunningJobs,
  type AnalysisJobRow,
} from './db.js';
import { isAnalysisRunning } from './analysisJob.js';
import { PRESETS, type JobContext } from './presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const JOBS_DIR = path.resolve(__dirname, '../storage/analysis-jobs');

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
  };

  // 3. CVパス実行（直列）
  try {
    for (const step of preset.cvSteps) {
      const scriptPath = path.resolve(__dirname, '../analysis', step.script);
      await runPython([scriptPath, ...step.args(ctx)], signal);
    }
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

  // 5. 完了（P0/P1: CV結果 or ダミーで done）
  const measurements = existsSync(ctx.measurementsPath)
    ? readFileSync(ctx.measurementsPath, 'utf-8')
    : null;
  const resultJson = JSON.stringify({
    pipeline: 'p0-plumbing',
    preset: job.preset,
    cvSteps: preset.cvSteps.length,
    hasMeasurements: measurements !== null,
  });
  const reportMd = [
    `# 解析レポート（配管テスト）`,
    ``,
    `- ジョブID: ${job.id}`,
    `- preset: ${job.preset}`,
    `- 実行したCVステップ数: ${preset.cvSteps.length}`,
    ``,
    measurements !== null
      ? `CV計測は完了しています（measurements.json あり）。LLM判断は P2 で有効化されます。`
      : `このジョブはパイプライン配管の疎通確認です。CV解析（P1）・LLM判断（P2）は未配線です。`,
  ].join('\n');
  markJobDone(job.id, resultJson, reportMd);
  console.log(`[jobWorker] job ${job.id} done`);
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
