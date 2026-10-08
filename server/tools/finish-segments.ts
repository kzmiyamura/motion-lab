/**
 * 全体解析（main）の結果で弱いカードだけを、区間再解析（reanalyze-segment）で 1 回ずつ直す「仕上げ」段。既定ではジョブには組み込まない
 * （jobWorker は環境変数 SEGMENT_FINISH=1 のときだけ呼ぶ）。ここは単体実行用。
 *
 * Usage（server/ で）:
 *   npx tsx tools/finish-segments.ts --job <jobId> [--model sonnet] [--dry] [--max 6] [--min-conf 0.5] [--out <result の出力先>]
 *   --dry … 窓だけ出す（claude は呼ばない）
 * 元の out/result.json は書き換えず、--out（既定 out/result.finish.json）にコピーして、そのコピーに適用する。
 * 保存先は MOTION_LAB_STORAGE（既定 server/storage）。窓ごとの結果とトークンを標準出力に出す。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { findWeakWindows } from '../src/segmentFinish.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_DIR, '.env'), quiet: true });
const STORAGE = process.env.MOTION_LAB_STORAGE ?? path.join(SERVER_DIR, 'storage');
const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const jobId = opt('job');
if (!jobId) { console.error('usage: tsx tools/finish-segments.ts --job <jobId> [--model sonnet] [--dry]'); process.exit(2); }

const outDir = path.join(STORAGE, 'analysis-jobs', jobId, 'out');
const resultPath = path.join(outDir, 'result.json');
// --in-place … result.json そのものに適用する（jobWorker の SEGMENT_FINISH=1 が使う。reanalyze-segment が result.json.bak を残す）
const inPlace = args.includes('--in-place');
const copyPath = inPlace ? resultPath : path.resolve(opt('out') ?? path.join(outDir, 'result.finish.json'));
const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
const m = JSON.parse(readFileSync(path.join(outDir, 'measurements.json'), 'utf-8')) as {
  persons?: Array<{ t: number }>; summary?: { holdUnclear?: Array<{ from: number; to: number }> };
};
const tracks = JSON.parse(readFileSync(path.join(outDir, 'measurements.tracks.json'), 'utf-8')) as { holdTimeline?: Array<{ from: number; to: number; estimated?: unknown }> };

const wins = findWeakWindows({
  result, holdUnclear: m.summary?.holdUnclear ?? null, holds: tracks.holdTimeline ?? null,
  firstT: Math.max(0, m.persons?.[0]?.t ?? 0), minConfidence: Number(opt('min-conf', '0.5')), maxWindows: Number(opt('max', '6')),
});
for (const w of wins) console.log(`[finish] 窓 ${w.from}〜${w.to} カード ${w.cards.map(c => c + 1).join(',')} / ${w.reasons.join(' ; ')}`);
console.log(`[finish] 窓 ${wins.length} 個 / ${wins.reduce((s, w) => s + w.to - w.from, 0).toFixed(1)} 秒`);
if (opt('dry') !== undefined || args.includes('--dry') || !wins.length) process.exit(0);

if (!inPlace) copyFileSync(resultPath, copyPath);
const tsx = path.join(SERVER_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const tot = { out: 0, cacheW: 0, cacheR: 0, calls: 0 };
wins.forEach((w, i) => {
  const r = spawnSync(tsx, [path.join(__dirname, 'reanalyze-segment.ts'), '--job', jobId, '--from', String(w.from), '--to', String(w.to),
    '--model', opt('model', 'sonnet')!, '--tag', `finish${i + 1}`, '--apply', '--result', copyPath, '--drop', 'holds'],
  { encoding: 'utf-8', shell: process.platform === 'win32', env: { ...process.env, PYTHON_BIN } });
  const u = /usage out=(\d+) cacheW=(\d+) cacheR=(\d+) in=\d+ turns=(\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  if (u) { tot.out += +u[1]; tot.cacheW += +u[2]; tot.cacheR += +u[3]; tot.calls += 1; }
  console.log(`[finish] 窓${i + 1} ${w.from}〜${w.to} exit=${r.status}${u ? ` out=${u[1]} cacheW=${u[2]} cacheR=${u[3]}` : ''}`);
  if (r.status !== 0) console.log(`[finish]   ${(r.stderr || r.stdout).split(/\r?\n/).slice(-3).join(' | ')}`);
});

// 置き換えたカードには steps が無いので、normalize_routine で埋める
const norm = path.join(SERVER_DIR, 'analysis', 'normalize_routine.py');
if (!inPlace && existsSync(norm)) { // --in-place のときは jobWorker 側が preset の既定で normalize する
  const r = spawnSync(PYTHON_BIN, [norm, copyPath, path.join(outDir, 'measurements.json'), '--default-onbeat=on2'], { encoding: 'utf-8', env: { ...process.env, PYTHONUTF8: '1' } });
  console.log(`[finish] normalize_routine exit=${r.status}`);
}
writeFileSync(path.join(outDir, 'finish-summary.json'), JSON.stringify({ job: jobId, windows: wins, tokens: tot, out: copyPath }, null, 2), 'utf-8');
console.log(`[finish] 完了 → ${copyPath} / 窓 ${tot.calls} 回の claude: out=${tot.out} cacheW=${tot.cacheW} cacheR=${tot.cacheR}`);
