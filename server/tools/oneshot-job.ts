/**
 * 本番の DB・storage に触れず、解析ジョブを 1 本だけ最初から最後まで（アンカー → CV → Claude の main）回す。
 * 比較用の単発実行。結果はこの server/ の storage/analysis-jobs/<jobId>/ と data/motionlab.db に出る
 * （本番サーバーが別の checkout で動いていれば、そちらの result.json は上書きされない）。
 *
 * Usage（server/ で）:
 *   npx tsx tools/oneshot-job.ts --src-server <本番の server ディレクトリ> --from-job <jobId>
 * 手順: 本番 DB を読み取り専用で開き、元ジョブの video・spec_snapshot・preset を取り出す →
 *   この checkout の DB に積む → 元動画を storage/originals にコピー → runJob を 1 回呼ぶ。
 * .env は --src-server のものを読む（トークンは出力しない）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const srcServer = path.resolve(opt('src-server') ?? '');
const fromJob = opt('from-job');
if (!opt('src-server') || !fromJob) {
  console.error('usage: tsx tools/oneshot-job.ts --src-server <server dir> --from-job <jobId>');
  process.exit(2);
}

const envPath = path.join(srcServer, '.env');
if (existsSync(envPath)) {
  for (const [k, v] of Object.entries(dotenv.parse(readFileSync(envPath)))) if (process.env[k] === undefined) process.env[k] = v;
}
// 相対パスの設定は本番側の server/ 基準
if (process.env.YOLO_MODEL_PATH && !path.isAbsolute(process.env.YOLO_MODEL_PATH)) {
  process.env.YOLO_MODEL_PATH = path.resolve(srcServer, process.env.YOLO_MODEL_PATH);
}
if (!process.env.YOLO_MODEL_PATH && existsSync(path.join(srcServer, 'models/yolov8s-pose.pt'))) {
  process.env.YOLO_MODEL_PATH = path.join(srcServer, 'models/yolov8s-pose.pt');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGINALS = path.resolve(here, '../storage/originals');

const src = new DatabaseSync(path.join(srcServer, 'data/motionlab.db'), { readOnly: true });
const job = src.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(fromJob) as Record<string, string> | undefined;
if (!job) { console.error(`元ジョブが見つかりません: ${fromJob}`); process.exit(1); }
const video = src.prepare('SELECT * FROM videos WHERE id = ?').get(job.video_id) as Record<string, string>;
src.close();

const { db, enqueueAnalysisJob, claimNextJob, getJob } = await import('../src/db.js');
const { runJob } = await import('../src/jobWorker.js');

// この checkout の DB に video / folder を写す（外部キーは無いが、getVideo が original_filename を要る）
db.prepare('INSERT OR IGNORE INTO folders (id, name, created_at) VALUES (?, ?, ?)').run(job.folder_id, `oneshot-${job.folder_id}`, new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO videos (id, title, original_filename, status, duration_sec, created_at, updated_at, folder_id)
            VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)`)
  .run(video.id, video.title, video.original_filename, video.duration_sec, video.created_at, video.updated_at, job.folder_id);
mkdirSync(ORIGINALS, { recursive: true });
const ext = path.extname(video.original_filename) || '.mp4';
const dst = path.join(ORIGINALS, `${video.id}${ext}`);
if (!existsSync(dst)) copyFileSync(path.join(srcServer, 'storage/originals', `${video.id}${ext}`), dst);

const id = enqueueAnalysisJob(video.id, job.folder_id, job.preset, job.spec_snapshot);
const claimed = claimNextJob();
if (!claimed || claimed.id !== id) { console.error('ジョブを確保できませんでした'); process.exit(1); }
console.log(`[oneshot] job=${id} preset=${job.preset} video=${video.id} model_main=${process.env.CLAUDE_MODEL_MAIN ?? '(未設定)'}`);
const t0 = Date.now();
await runJob(claimed);
const done = getJob(id);
console.log(`[oneshot] status=${done?.status} elapsed=${Math.round((Date.now() - t0) / 1000)}s${done?.error_message ? ` error=${done.error_message.slice(0, 300)}` : ''}`);
process.exit(done?.status === 'done' ? 0 : 1);
