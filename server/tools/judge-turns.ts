/**
 * ターンの判定（src/turnJudge.ts）を jobWorker の外から 1 本ずつ回す。claude の呼び出しは動画 1 本につき 1 回。
 *
 * Usage（server/ で）:
 *   npx tsx tools/judge-turns.ts <jobId> [--force]
 *     … 完了済みジョブの out/measurements.json に書き戻す（一覧画像は out/turn_judge/）。判定済みなら --force が無い限り飛ばす
 *   npx tsx tools/judge-turns.ts --video=<mp4> --tracks=<tracks.json> --meas=<measurements.json> --work=<dir> [--out=<json>]
 *     … 評価用（eval_ground_truth.py --events-dir に渡す events を作る）
 * レート制限に当たったら exit 3（それ以上呼ばない）
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { ClaudeRateLimitError } from '../src/claudeRunner.js';
import { hasTurnJudge, judgeTurns } from '../src/turnJudge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_DIR, '.env'), quiet: true });
const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3';

const args = process.argv.slice(2);
const opt = (k: string) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const force = args.includes('--force');

function fromJob(jobId: string) {
  const db = new DatabaseSync(path.join(SERVER_DIR, 'data/motionlab.db'));
  const row = db.prepare(
    'SELECT v.id AS vid, v.original_filename AS fn FROM analysis_jobs j JOIN videos v ON v.id = j.video_id WHERE j.id = ?',
  ).get(jobId) as { vid: string; fn: string } | undefined;
  if (!row) throw new Error(`job not found: ${jobId}`);
  const out = path.join(SERVER_DIR, 'storage/analysis-jobs', jobId, 'out');
  return {
    videoPath: path.join(SERVER_DIR, 'storage/originals', `${row.vid}${path.extname(row.fn) || '.mp4'}`),
    tracksPath: path.join(out, 'measurements.tracks.json'),
    measurementsPath: path.join(out, 'measurements.json'),
    workDir: path.join(out, 'turn_judge'),
  };
}

async function main(): Promise<number> {
  const jobId = args.find(a => !a.startsWith('--'));
  const p = jobId ? fromJob(jobId) : {
    videoPath: opt('video') ?? '', tracksPath: opt('tracks') ?? '', measurementsPath: opt('meas') ?? '', workDir: opt('work') ?? '',
  };
  for (const [k, v] of Object.entries(p)) {
    if (!v || (k !== 'workDir' && !existsSync(v))) {
      console.error(`[judge-turns] missing ${k}: ${v}`);
      return 1;
    }
  }
  if (jobId && !force && hasTurnJudge(p.measurementsPath)) {
    console.log(`[judge-turns] ${jobId.slice(0, 8)} already judged (--force で判定し直す)`);
    return 0;
  }
  mkdirSync(p.workDir, { recursive: true });
  try {
    const r = await judgeTurns({ ...p, pythonBin: PYTHON_BIN, outPath: opt('out'), signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!r) {
      console.log('[judge-turns] no turn to judge (claude not called)');
      return 0;
    }
    console.log(`[judge-turns] asked=${r.asked} images=${(r.bytes / 1e6).toFixed(2)}MB claude=${(r.elapsedMs / 1000).toFixed(1)}s ${r.merged}`);
    return 0;
  } catch (e) {
    if (e instanceof ClaudeRateLimitError) {
      console.error(`[judge-turns] rate limited: ${e.message.slice(0, 500)}`);
      return 3;
    }
    console.error(`[judge-turns] failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

process.exit(await main());
