// 既存ジョブ用: ~/.claude/projects/<作業ディレクトリをエンコードした名前>/*.jsonl の usage を合計し、
// storage/analysis-jobs/<jobId>/out/claude-usage.json を作る。
//   node tools/backfill-claude-usage.mjs <jobId> [<jobId> ...] [--dry-run] [--force]
// assistant メッセージの message.usage を message.id ごとに 1 回だけ数える（同じ message が
// ストリーミングで複数行に分かれて出るため）。jsonl に total_cost_usd は無いので cost は null。
// 1 ファイル = 1 回の claude 呼び出し（セッション）= 1 step。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.resolve(__dirname, '../storage/analysis-jobs');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** 作業ディレクトリのパスの `:` `\` `/` を `-` に置き換える */
export function encodeProjectDirName(cwd) {
  return cwd.replace(/[:\\/]/g, '-');
}

/** Claude Code 本体は英数字以外すべてを `-` にするので、`_` や `.` を含むパス用の候補 */
export function encodeProjectDirNameLoose(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** jsonl のテキストから使用量を合計する。message.id ごとに最後の usage を 1 回だけ数える */
export function sumJsonlUsage(text) {
  const byId = new Map();
  let anon = 0;
  let firstTs = null;
  let lastTs = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { firstTs ??= o.timestamp; lastTs = o.timestamp; }
    if (o.type !== 'assistant' || !o.message?.usage) continue;
    const id = o.message.id ?? `anon-${anon++}`;
    byId.set(id, { usage: o.message.usage, model: o.message.model });
  }
  const s = {
    models: [], input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    total_cost_usd: null, num_turns: byId.size, duration_ms: null, at: lastTs ?? null,
  };
  for (const { usage: u, model } of byId.values()) {
    s.input_tokens += n(u.input_tokens);
    s.output_tokens += n(u.output_tokens);
    s.cache_creation_input_tokens += n(u.cache_creation_input_tokens);
    s.cache_read_input_tokens += n(u.cache_read_input_tokens);
    if (model && model !== '<synthetic>' && !s.models.includes(model)) s.models.push(model);
  }
  if (firstTs && lastTs) {
    const d = Date.parse(lastTs) - Date.parse(firstTs);
    if (Number.isFinite(d)) s.duration_ms = d;
  }
  return s;
}

export function sumSteps(steps) {
  const t = {
    models: [], input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    total_cost_usd: 0, num_turns: 0, duration_ms: 0, calls: steps.length,
  };
  for (const s of steps) {
    t.input_tokens += s.input_tokens ?? 0;
    t.output_tokens += s.output_tokens ?? 0;
    t.cache_creation_input_tokens += s.cache_creation_input_tokens ?? 0;
    t.cache_read_input_tokens += s.cache_read_input_tokens ?? 0;
    t.total_cost_usd += s.total_cost_usd ?? 0;
    t.num_turns += s.num_turns ?? 0;
    t.duration_ms += s.duration_ms ?? 0;
    for (const m of s.models) if (!t.models.includes(m)) t.models.push(m);
  }
  return t;
}

function findProjectDir(cwd) {
  for (const name of [encodeProjectDirName(cwd), encodeProjectDirNameLoose(cwd)]) {
    const p = path.join(PROJECTS_DIR, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function stepsFromDir(dir, step) {
  const out = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    const full = path.join(dir, f);
    const s = sumJsonlUsage(readFileSync(full, 'utf-8'));
    if (s.num_turns === 0) continue;
    out.push({ step, ...s, at: s.at ?? statSync(full).mtime.toISOString() });
  }
  return out;
}

/** ジョブ 1 件ぶんの claude-usage.json の中身を作る。jsonl が全く無ければ null */
export function buildJobUsage(jobId, jobsDir = JOBS_DIR) {
  const jobDir = path.join(jobsDir, jobId);
  const steps = [];
  const targets = [
    [jobDir, 'main'],
    [path.join(jobDir, 'out', 'anchor'), 'anchor'],
    [path.join(jobDir, 'out', 'turn_judge'), 'turnJudge'],
  ];
  for (const [cwd, step] of targets) {
    const dir = findProjectDir(cwd);
    if (dir) steps.push(...stepsFromDir(dir, step));
  }
  if (steps.length === 0) return null;
  steps.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { steps, total: sumSteps(steps) };
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const force = args.includes('--force');
  const ids = args.filter(a => !a.startsWith('--'));
  if (ids.length === 0) {
    console.error('usage: node tools/backfill-claude-usage.mjs <jobId> [...] [--dry-run] [--force]');
    process.exit(2);
  }
  for (const id of ids) {
    const outDir = path.join(JOBS_DIR, id, 'out');
    const dest = path.join(outDir, 'claude-usage.json');
    if (!existsSync(path.join(JOBS_DIR, id))) { console.warn(`[backfill] ${id}: job dir not found`); continue; }
    const usage = buildJobUsage(id);
    if (!usage) { console.warn(`[backfill] ${id}: no jsonl found under ${PROJECTS_DIR}`); continue; }
    const t = usage.total;
    console.log(`[backfill] job=${id.slice(0, 8)} calls=${t.calls} out=${t.output_tokens} cacheW=${t.cache_creation_input_tokens} cacheR=${t.cache_read_input_tokens} turns=${t.num_turns}`);
    for (const s of usage.steps) {
      console.log(`  ${s.step.padEnd(9)} out=${s.output_tokens} cacheW=${s.cache_creation_input_tokens} cacheR=${s.cache_read_input_tokens} turns=${s.num_turns} at=${s.at}`);
    }
    if (dry) continue;
    if (existsSync(dest) && !force) { console.warn(`  skip: ${dest} exists (--force to overwrite)`); continue; }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(dest, JSON.stringify(usage, null, 2), 'utf-8');
    console.log(`  wrote ${dest}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
