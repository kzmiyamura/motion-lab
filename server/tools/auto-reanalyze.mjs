#!/usr/bin/env node
/**
 * 解析パイプラインに変更がコミットされたら、最新の動画1本を自動で再解析する見張り役。
 * pm2 で "motion-lab-autoreanalyze" として常駐させる（server/README.md 参照）。
 *
 * 5分ごとに、パイプライン関連ファイル（PIPELINE_PATHSPECS）に触れた最新コミットを調べ、
 * 前回解析したコミットから変わっていて、以下をすべて満たしたときだけ再解析 API を叩く:
 *   - そのコミットから20分以上経っている（連続コミットを1回にまとめるため）
 *   - 前回の自動再解析から2時間以上経っている
 *   - 解析ジョブ（queued/running）・回転解析が動いていない
 *   - 空き物理メモリが 1.5GB 以上ある
 * 条件を満たさなければ lastSkipReason に理由を残して次の周期でやり直す。
 *
 * jobWorker.ts / claudeRunner.ts / presets.ts はサーバー起動時に読み込まれるので、
 * それらがサーバーの起動より後にコミットされていたら、先に pm2 restart motion-lab-server する。
 *
 * 状態は server/storage/auto-reanalyze.json。初回は現在のコミットを記録するだけで再解析しない。
 *
 * Usage（server/ で）: node tools/auto-reanalyze.mjs [--once]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const STATE_PATH = path.join(SERVER_DIR, 'storage/auto-reanalyze.json');
const SPECS_DIR = path.join(SERVER_DIR, 'storage/specs');
const DB_PATH = path.join(SERVER_DIR, 'data/motionlab.db');

// .env はファイルから読む（トークンをコマンドラインやログに出さない）
const env = existsSync(path.join(SERVER_DIR, '.env'))
  ? dotenv.parse(readFileSync(path.join(SERVER_DIR, '.env')))
  : {};
const API_BASE = `http://localhost:${env.PORT || 4000}`;
const API_WRITE_TOKEN = env.API_WRITE_TOKEN ?? '';

const TICK_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 20 * 60 * 1000;
const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MIN_FREE_MEM = 1.5 * 1024 ** 3;
const SERVER_PM2_NAME = 'motion-lab-server';

/** 解析結果に効くファイル。評価・計測・試作スクリプトと正解表・テストは除く */
const PIPELINE_PATHSPECS = [
  'server/analysis',
  ':(exclude,glob)server/analysis/eval_*.py',
  ':(exclude,glob)server/analysis/measure_*.py',
  ':(exclude,glob)server/analysis/prototype_*.py',
  ':(exclude)server/analysis/ground_truth',
  ':(exclude)server/analysis/__pycache__',
  ':(exclude)server/analysis/tests',
  'server/prompts',
  'server/src/jobWorker.ts',
  'server/src/claudeRunner.ts',
  'server/src/presets.ts',
];
/** サーバー起動時に読み込まれる（変わったらサーバーの再起動が要る）ファイル */
const SERVER_LOADED_PATHSPECS = ['server/src/jobWorker.ts', 'server/src/claudeRunner.ts', 'server/src/presets.ts'];

const log = msg => console.log(`[autoReanalyze] ${new Date().toISOString()} ${msg}`);

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/** pathspec に触れた最新コミット { hash, time(ms) }。無ければ null */
function latestCommit(pathspecs) {
  const out = execFileSync('git', ['-C', REPO_DIR, 'log', '-1', '--format=%H %ct', '--', ...pathspecs], { encoding: 'utf-8' }).trim();
  if (!out) return null;
  const [hash, ct] = out.split(' ');
  return { hash, time: Number(ct) * 1000 };
}

/** pm2 経由のコマンド（Windows の pm2.cmd は shell 経由でないと起動できない） */
function pm2(args) {
  return execFileSync('pm2', args, { encoding: 'utf-8', shell: true, maxBuffer: 32 * 1024 * 1024 });
}

/** motion-lab-server の起動時刻（ms）。取れなければ null */
function serverStartedAt() {
  try {
    const list = JSON.parse(pm2(['jlist']));
    const p = list.find(x => x.name === SERVER_PM2_NAME);
    return p?.pm2_env?.pm_uptime ?? null;
  } catch {
    return null;
  }
}

function openDb() {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

/** 解析が動いている/待っているなら理由の文字列、空いていれば null */
function busyReason(db) {
  const jobs = db.prepare("SELECT status, COUNT(*) AS n FROM analysis_jobs WHERE status IN ('queued', 'running') GROUP BY status").all();
  if (jobs.length > 0) return `解析ジョブが動いている（${jobs.map(j => `${j.status}=${j.n}`).join(', ')}）`;
  const rot = db.prepare("SELECT COUNT(*) AS n FROM rotation_analysis WHERE status = 'processing'").get();
  if (rot.n > 0) return '回転解析が動いている';
  return null;
}

/** フォルダの指示書が salsa-pair プリセットか */
function hasPairSpec(folderId) {
  const p = path.join(SPECS_DIR, folderId, 'analysis.md');
  if (!existsSync(p)) return false;
  const front = readFileSync(p, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!front && /^preset:\s*salsa-pair\s*$/m.test(front[1]);
}

/** 指示書付きフォルダに入った ready 動画のうち、最も新しくアップロードされたもの */
function latestTargetVideo(db) {
  const rows = db.prepare(
    "SELECT id, title, folder_id FROM videos WHERE status = 'ready' AND folder_id IS NOT NULL ORDER BY created_at DESC",
  ).all();
  return rows.find(r => hasPairSpec(r.folder_id)) ?? null;
}

async function healthOk() {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok && (await res.json()).status === 'ok';
  } catch {
    return false;
  }
}

async function restartServer() {
  log(`restarting ${SERVER_PM2_NAME} (jobWorker/claudeRunner/presets changed)`);
  pm2(['restart', SERVER_PM2_NAME]);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    if (await healthOk()) {
      log('server is back (health ok)');
      return true;
    }
  }
  return false;
}

async function reanalyze(videoId) {
  const headers = API_WRITE_TOKEN ? { Authorization: `Bearer ${API_WRITE_TOKEN}` } : {};
  const res = await fetch(`${API_BASE}/api/videos/${videoId}/reanalyze`, { method: 'POST', headers, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 202 || !body.jobId) throw new Error(`reanalyze ${res.status}: ${body.error ?? ''}`);
  return body.jobId;
}

let lastLoggedSkip = null;

async function tick() {
  const now = Date.now();
  const head = latestCommit(PIPELINE_PATHSPECS);
  if (!head) return;
  let state = readState();
  if (!state) {
    state = { lastAnalyzedCommit: head.hash, lastRunAt: null, lastJobId: null, lastSkipReason: null };
    writeState(state);
    log(`initialized at ${head.hash.slice(0, 8)} (no reanalysis on first run)`);
    return;
  }
  const skip = reason => {
    if (state.lastSkipReason !== reason) writeState({ ...state, lastSkipReason: reason });
    if (lastLoggedSkip !== reason) log(`skip: ${reason}`);
    lastLoggedSkip = reason;
  };

  if (head.hash === state.lastAnalyzedCommit) {
    if (state.lastSkipReason) writeState({ ...state, lastSkipReason: null });
    lastLoggedSkip = null;
    return;
  }
  const ageMin = (now - head.time) / 60000;
  if (now - head.time < DEBOUNCE_MS) return skip(`コミット ${head.hash.slice(0, 8)} から ${ageMin.toFixed(0)} 分（20分待つ）`);
  if (state.lastRunAt && now - Date.parse(state.lastRunAt) < MIN_INTERVAL_MS) return skip('前回の自動再解析から2時間経っていない');
  const free = os.freemem();
  if (free < MIN_FREE_MEM) return skip(`空きメモリ不足（${(free / 1024 ** 3).toFixed(2)}GB < 1.5GB）`);

  const db = openDb();
  let target;
  try {
    const busy = busyReason(db);
    if (busy) return skip(busy);
    target = latestTargetVideo(db);
  } finally {
    db.close();
  }
  if (!target) return skip('指示書付きフォルダに ready の動画が無い');

  // サーバーが読み込み済みのコードより新しい jobWorker/claudeRunner/presets があれば再起動
  const serverCode = latestCommit(SERVER_LOADED_PATHSPECS);
  const startedAt = serverStartedAt();
  if (serverCode && (startedAt == null || serverCode.time > startedAt)) {
    if (!(await restartServer())) return skip('サーバー再起動後に health が戻らない');
    const db2 = openDb();
    try {
      const busy = busyReason(db2); // 再起動で running → queued に戻ったジョブがあれば待つ
      if (busy) return skip(busy);
    } finally {
      db2.close();
    }
  } else if (!(await healthOk())) {
    return skip('サーバーの health が ok でない');
  }

  const jobId = await reanalyze(target.id);
  writeState({
    lastAnalyzedCommit: head.hash,
    lastRunAt: new Date().toISOString(),
    lastJobId: jobId,
    lastSkipReason: null,
    lastVideoId: target.id,
  });
  lastLoggedSkip = null;
  log(`reanalyze queued: commit=${head.hash.slice(0, 8)} video=${target.id.slice(0, 8)}「${target.title}」 job=${jobId}`);
}

let running = false;
async function safeTick() {
  if (running) return;
  running = true;
  try {
    await tick();
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : e}`);
  } finally {
    running = false;
  }
}

if (process.argv.includes('--once')) {
  await safeTick();
} else {
  log(`started (tick=${TICK_MS / 60000}min, state=${path.relative(SERVER_DIR, STATE_PATH)})`);
  await safeTick();
  setInterval(() => { void safeTick(); }, TICK_MS);
}
