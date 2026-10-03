#!/usr/bin/env node
/**
 * 完了済み解析ジョブのレポートに、場面ごとの連続コマ画像（make_report_frames.py）を付け直す。
 *
 * 見出しの書き方の揺れ（- **00:08–00:09 …** / ### 0:16 … 等）で画像が1枚も付かなかった
 * 過去のレポートを救済するためのもの。Claude は呼ばない（report.md を読み直して画像行を差し込むだけ）。
 *
 * jobWorker の最終レポート = withSceneFrames(report.md) + debugVideoSection(jobId) なので、
 * DB に保存済みの report_md から末尾の「## 動画」節（debugVideoSection が付けたもの）を切り出して
 * そのまま付け直す。保存済み本文が report.md 由来でない（CVのみレポート等）ジョブは触らない。
 *
 * メモリの少ない実機向けに1件ずつ直列で処理する。
 *
 * Usage（server/ で）:
 *   node tools/backfill-report-frames.mjs [--dry-run] [<jobId> ...]
 *   node tools/backfill-report-frames.mjs --move-frames [--dry-run] [<jobId> ...]
 *     … レポートは触らず、振付シート用の技ごとの画像（out/move_frames/）だけを作る
 *   jobId 省略時は status=done の全ジョブ
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_DIR, '.env'), quiet: true });

const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3';
const JOBS_DIR = path.join(SERVER_DIR, 'storage/analysis-jobs');
const ORIGINALS_DIR = path.join(SERVER_DIR, 'storage/originals');
const SCRIPT = path.join(SERVER_DIR, 'analysis/make_report_frames.py');
const IMAGE_LINE_RE = /^!\[[^\]]*\]\([^)]*\/report_frames\/[^)]*\)\s*$/;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const moveFrames = args.includes('--move-frames');
const MOVE_SCRIPT = path.join(SERVER_DIR, 'analysis/make_move_frames.py');
const onlyIds = args.filter(a => !a.startsWith('--'));

const db = new DatabaseSync(path.join(SERVER_DIR, 'data/motionlab.db'));

/** jobWorker.debugVideoSection が付けた末尾の「## 動画」節を切り出す（無ければ tail = ''） */
function splitTail(jobId, stored) {
  const idx = stored.lastIndexOf('\n\n## 動画\n\n');
  if (idx >= 0) {
    const tail = stored.slice(idx);
    if (tail.includes(`/analysis-output/${jobId}/out/`) && /(debug_roi|skeleton)\.mp4/.test(tail)) {
      return { body: stored.slice(0, idx), tail };
    }
  }
  return { body: stored, tail: '' };
}

/** 画像行を除いた本文（比較用。行末空白も無視） */
function textOnly(md) {
  return md.split('\n').filter(l => !IMAGE_LINE_RE.test(l.trim())).map(l => l.trimEnd()).join('\n').trimEnd();
}

function resolveVideoPath(videoId) {
  const row = db.prepare('SELECT original_filename FROM videos WHERE id = ?').get(videoId);
  if (!row) return null;
  const ext = path.extname(row.original_filename) || '.mp4';
  const p = path.join(ORIGINALS_DIR, `${videoId}${ext}`);
  return existsSync(p) ? p : null;
}

function countWithFrames() {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM analysis_jobs WHERE status = 'done' AND report_md LIKE '%/report_frames/%'",
  ).get().n;
}

const jobs = db.prepare(
  "SELECT id, video_id, report_md FROM analysis_jobs WHERE status = 'done' ORDER BY created_at",
).all().filter(j => onlyIds.length === 0 || onlyIds.includes(j.id));

if (moveFrames) {
  backfillMoveFrames(jobs);
  process.exit(0);
}

/**
 * --move-frames: result.json に routine.moves がある完了ジョブに、振付シート用の技ごとの
 * 連続コマ画像（out/move_frames/）を作る。DB もレポートも書き換えない
 */
function backfillMoveFrames(targets) {
  const t = { made: 0, skipped: 0, failed: 0 };
  for (const job of targets) {
    const tag = `[backfill:move] ${job.id.slice(0, 8)}`;
    const outDir = path.join(JOBS_DIR, job.id, 'out');
    const resultPath = path.join(outDir, 'result.json');
    let moves = 0;
    try {
      moves = JSON.parse(readFileSync(resultPath, 'utf-8'))?.routine?.moves?.length ?? 0;
    } catch { /* result.json が無い・壊れている */ }
    const videoPath = resolveVideoPath(job.video_id);
    if (moves === 0 || !videoPath) {
      console.log(`${tag} skip: ${moves === 0 ? 'routine.moves が無い' : '元動画が無い'}`);
      t.skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`${tag} would make ${moves} move frames`);
      t.made++;
      continue;
    }
    const r = spawnSync(PYTHON_BIN, [
      MOVE_SCRIPT, videoPath,
      path.join(outDir, 'measurements.tracks.json'), resultPath,
      path.join(outDir, 'measurements.json'),
      path.join(outDir, 'move_frames'),
      `/analysis-output/${job.id}/out/move_frames`,
    ], { encoding: 'utf-8' });
    const note = (r.stderr || r.error?.message || '').trim().split('\n').pop();
    if (r.status !== 0) {
      console.log(`${tag} failed: ${(r.stderr || r.error?.message || '').trim().slice(-300)}`);
      t.failed++;
    } else {
      console.log(`${tag} ${note}`);
      t.made++;
    }
  }
  console.log(`[backfill:move] ${dryRun ? '(dry-run) ' : ''}jobs=${targets.length} made=${t.made} skipped=${t.skipped} failed=${t.failed}`);
}

const before = countWithFrames();
const tally = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

for (const job of jobs) {
  const tag = `[backfill] ${job.id.slice(0, 8)}`;
  const outDir = path.join(JOBS_DIR, job.id, 'out');
  const reportPath = path.join(outDir, 'report.md');
  const tracksPath = path.join(outDir, 'measurements.tracks.json');
  const videoPath = resolveVideoPath(job.video_id);
  if (!existsSync(reportPath) || !existsSync(tracksPath) || !videoPath) {
    console.log(`${tag} skip: ${!existsSync(reportPath) ? 'report.md' : !existsSync(tracksPath) ? 'tracks.json' : '元動画'} が無い`);
    tally.skipped++;
    continue;
  }
  const stored = job.report_md ?? '';
  const { body, tail } = splitTail(job.id, stored);
  if (textOnly(body) !== textOnly(readFileSync(reportPath, 'utf-8'))) {
    console.log(`${tag} skip: 保存済みレポートが report.md 由来ではない`);
    tally.skipped++;
    continue;
  }

  const tmpPath = path.join(outDir, 'report.backfill.md');
  const r = spawnSync(PYTHON_BIN, [
    SCRIPT, videoPath, tracksPath, reportPath,
    path.join(outDir, 'report_frames'),
    `/analysis-output/${job.id}/out/report_frames`,
    tmpPath,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    console.log(`${tag} failed: ${(r.stderr || r.error?.message || '').trim().slice(-300)}`);
    rmSync(tmpPath, { force: true });
    tally.failed++;
    continue;
  }
  const newReport = readFileSync(tmpPath, 'utf-8');
  const newMd = newReport + tail;
  const note = (r.stderr || '').trim().split('\n').pop();
  if (newMd === stored) {
    console.log(`${tag} unchanged (${note})`);
    rmSync(tmpPath, { force: true });
    tally.unchanged++;
    continue;
  }
  if (dryRun) {
    console.log(`${tag} would update (${note})`);
    rmSync(tmpPath, { force: true });
  } else {
    renameSync(tmpPath, reportPath);
    db.prepare('UPDATE analysis_jobs SET report_md = ? WHERE id = ?').run(newMd, job.id);
    console.log(`${tag} updated (${note})`);
  }
  tally.updated++;
}

console.log(
  `[backfill] ${dryRun ? '(dry-run) ' : ''}jobs=${jobs.length} updated=${tally.updated} unchanged=${tally.unchanged} `
  + `skipped=${tally.skipped} failed=${tally.failed} / report_frames 入りレポート ${before} → ${countWithFrames()}`,
);
