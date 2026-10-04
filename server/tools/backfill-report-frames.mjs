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
 *   node tools/backfill-report-frames.mjs --move-frames --normalize [<jobId> ...]
 *     … 先に routine を normalize_routine.py で整え（result.json と DB の result_json を更新）、それから画像を作る
 *   node tools/backfill-report-frames.mjs --move-frames --refine --normalize [<jobId> ...]
 *     … さらにその前に refine_events.py で入れ替わり・ターンの前後を 25〜30fps で取り直す
 *       （measurements.json / tracks.json の events を書き換える。取り直し済み（summary.eventRefine あり）なら飛ばす。
 *       YOLO を回すので重い。1 件ずつ）
 *   node tools/backfill-report-frames.mjs --move-frames --update-events --normalize [<jobId> ...]
 *     … 先に update_events.py で技イベントを tracks.json から今の analyze_pair で作り直す（ターンの区間は全フレームで
 *       YOLO をかけ直す = ジョブと同じ。measurements.json / tracks.json の events を書き換え、元は summary.eventsPrev に残す）。
 *       --retime を足すと先にコマの時刻を動画のタイムスタンプ（PTS）に付け直す（以前の解析はコマ番号 / fps。README 26）。
 *       --retrack を足すと先に人物 ID を今の外見追跡（assign_appearance_ids）で付け直す（動画を読み直して色ヒストグラムを作る。YOLO なし）
 *       --beats を足すとその後に音声のビート格子とカウント 1（beatGrid.downbeat、analyze_beats.py）を作り直す
 *       （ジョブの audio.wav は消えているので ffmpeg で取り直す。イベントの後に回すのはカウント 1 が踊りの手がかりも使うため）
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
const normalize = args.includes('--normalize');
const NORMALIZE_SCRIPT = path.join(SERVER_DIR, 'analysis/normalize_routine.py');
const refine = args.includes('--refine');
const updateEvents = args.includes('--update-events');
const retrackIds = args.includes('--retrack');   // --update-events と一緒に: 人物 ID を今の外見追跡で付け直す
const retime = args.includes('--retime');        // --update-events と一緒に: コマの時刻を動画の PTS に付け直す（README 26）
const UPDATE_EVENTS_SCRIPT = path.join(SERVER_DIR, 'analysis/update_events.py');
const redoBeats = args.includes('--beats');      // 音声のビート格子とカウント 1（beatGrid.downbeat）を今の analyze_beats で作り直す
const BEATS_SCRIPT = path.join(SERVER_DIR, 'analysis/analyze_beats.py');
const FFMPEG_BIN = process.env.FFMPEG_PATH ?? path.join(SERVER_DIR, 'node_modules/ffmpeg-static/ffmpeg.exe');
const REFINE_SCRIPT = path.join(SERVER_DIR, 'analysis/refine_events.py');
const MODEL_PATH = process.env.YOLO_MODEL_PATH ?? path.join(SERVER_DIR, 'models/yolov8s-pose.pt');
const REFINE_BUDGET_SEC = Number(process.env.REFINE_BUDGET_SEC ?? 240);
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
      console.log(`${tag} would ${updateEvents ? 'update events, ' : ''}${refine ? 'refine events, ' : ''}${normalize ? 'normalize routine and ' : ''}make ${moves} move frames`);
      t.made++;
      continue;
    }
    if (updateEvents) {
      // 技イベントを tracks.json から今の analyze_pair で作り直す（ターンの区間は全フレームで取り直す = ジョブと同じ）
      const u = spawnSync(PYTHON_BIN, [UPDATE_EVENTS_SCRIPT, path.join(outDir, 'measurements.json'),
        `--video=${videoPath}`, `--model=${MODEL_PATH}`, ...(retime ? ['--retime'] : []), ...(retrackIds ? ['--retrack'] : [])], { encoding: 'utf-8' });
      const last = (u.stderr || u.error?.message || '').trim().split('\n').pop();
      if (u.status !== 0) {
        console.log(`${tag} update events failed: ${last}`);
        t.failed++;
        continue;
      }
      console.log(`${tag} ${last}`);
    }
    if (redoBeats) {
      // jobWorker と同じ: 音声を WAV にして analyze_beats.py（格子・カウント 1・各イベントの count）。失敗しても続ける
      const wav = path.join(outDir, 'audio.wav');
      const f = spawnSync(FFMPEG_BIN, ['-y', '-loglevel', 'error', '-i', videoPath, '-ac', '1', '-ar', '22050', '-af', 'aresample=async=1:first_pts=0', wav], { encoding: 'utf-8' });
      if (f.status !== 0) {
        console.log(`${tag} beats skipped: ffmpeg ${(f.stderr || f.error?.message || '').trim().slice(-200)}`);
      } else {
        const b = spawnSync(PYTHON_BIN, [BEATS_SCRIPT, wav, path.join(outDir, 'measurements.json')], { encoding: 'utf-8' });
        console.log(`${tag} ${b.status !== 0 ? 'beats failed: ' : ''}${(b.stderr || b.error?.message || '').trim().split('\n').slice(-2).join(' | ')}`);
      }
      rmSync(wav, { force: true });
    }
    if (refine) {
      const measPath = path.join(outDir, 'measurements.json');
      let refined = false;
      try {
        refined = Boolean(JSON.parse(readFileSync(measPath, 'utf-8'))?.summary?.eventRefine);
      } catch { /* measurements.json が無い・壊れている */ }
      if (refined) {
        console.log(`${tag} refine: already refined`);
      } else {
        const r = spawnSync(PYTHON_BIN, [REFINE_SCRIPT, videoPath, MODEL_PATH, measPath, `--budget-sec=${REFINE_BUDGET_SEC}`],
          { encoding: 'utf-8' });
        const last = (r.stderr || r.error?.message || '').trim().split('\n').pop();
        // 取り直しに失敗しても 10fps の値のまま続ける（jobWorker と同じ）
        console.log(`${tag} refine${r.status !== 0 ? ' failed' : ''}: ${last}`);
      }
    }
    if (normalize) {
      // jobWorker と同じ後処理（8カウントの格子に寄せる・まとめる・steps を付ける）。DB の result_json も揃える
      const n = spawnSync(PYTHON_BIN, [NORMALIZE_SCRIPT, resultPath, path.join(outDir, 'measurements.json')], { encoding: 'utf-8' });
      if (n.status !== 0) {
        console.log(`${tag} normalize failed: ${(n.stderr || n.error?.message || '').trim().slice(-300)}`);
        t.failed++;
        continue;
      }
      db.prepare('UPDATE analysis_jobs SET result_json = ? WHERE id = ?').run(readFileSync(resultPath, 'utf-8'), job.id);
      console.log(`${tag} ${(n.stderr || '').trim().split('\n').pop()}`);
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
