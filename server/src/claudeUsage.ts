/**
 * Claude CLI のトークン使用量の記録。
 * `claude -p --output-format json` の最終出力（エンベロープ）に入っている usage / total_cost_usd /
 * num_turns / duration_ms / modelUsage を取り出し、ジョブの out/claude-usage.json に段階ごとに追記する。
 * どの関数も例外を投げない（使用量の記録でジョブを失敗させない）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ClaudeStep = 'anchor' | 'main' | 'turnJudge' | (string & {});

export interface ClaudeUsageStep {
  step: ClaudeStep;
  models: string[];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  at: string;
}

export interface ClaudeUsageTotal {
  models: string[];
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  calls: number;
}

export interface ClaudeUsageFile {
  steps: ClaudeUsageStep[];
  total: ClaudeUsageTotal;
}

export const CLAUDE_USAGE_FILE = 'claude-usage.json';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** stdout 全体（--output-format json のエンベロープ）から使用量を取り出す。読めなければ null */
export function extractClaudeUsage(stdout: string, step: ClaudeStep, at: Date = new Date()): ClaudeUsageStep | null {
  let env: unknown;
  try {
    env = JSON.parse(stdout);
  } catch {
    // 出力の前後に余計な行が付いた場合に備え、最後の { ... } を拾い直す
    const s = stdout.indexOf('{');
    const e = stdout.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { env = JSON.parse(stdout.slice(s, e + 1)); } catch { return null; }
  }
  // 古い形式（配列）の場合は末尾の result 要素を使う
  if (Array.isArray(env)) env = [...env].reverse().find(x => x && typeof x === 'object' && (x as { type?: string }).type === 'result');
  if (!env || typeof env !== 'object') return null;
  const o = env as Record<string, unknown>;
  const u = (o.usage && typeof o.usage === 'object' ? o.usage : null) as Record<string, unknown> | null;
  const modelUsage = o.modelUsage && typeof o.modelUsage === 'object' ? Object.keys(o.modelUsage as object) : [];
  if (!u && o.total_cost_usd == null && modelUsage.length === 0) return null;
  return {
    step,
    models: modelUsage,
    input_tokens: num(u?.input_tokens),
    output_tokens: num(u?.output_tokens),
    cache_creation_input_tokens: num(u?.cache_creation_input_tokens),
    cache_read_input_tokens: num(u?.cache_read_input_tokens),
    total_cost_usd: num(o.total_cost_usd),
    num_turns: num(o.num_turns),
    duration_ms: num(o.duration_ms),
    at: at.toISOString(),
  };
}

export function sumClaudeUsage(steps: ClaudeUsageStep[]): ClaudeUsageTotal {
  const t: ClaudeUsageTotal = {
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
  t.total_cost_usd = Math.round(t.total_cost_usd * 1e6) / 1e6;
  return t;
}

/** pm2 ログ用の 1 行 */
export function formatUsageLine(jobId: string, s: ClaudeUsageStep): string {
  const cost = s.total_cost_usd == null ? '?' : s.total_cost_usd.toFixed(4);
  return `[claudeUsage] job=${jobId.slice(0, 8)} step=${s.step} out=${s.output_tokens ?? '?'} ` +
    `cacheW=${s.cache_creation_input_tokens ?? '?'} cacheR=${s.cache_read_input_tokens ?? '?'} ` +
    `turns=${s.num_turns ?? '?'} cost=$${cost}`;
}

/** out/claude-usage.json を読む（無い・壊れていれば null） */
export function readClaudeUsageFile(outDir: string): ClaudeUsageFile | null {
  try {
    const p = path.join(outDir, CLAUDE_USAGE_FILE);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf-8')) as ClaudeUsageFile;
    return Array.isArray(j.steps) ? j : null;
  } catch {
    return null;
  }
}

/** 1 回分を out/claude-usage.json に追記し、total を再計算して pm2 ログに 1 行出す。失敗しても握りつぶす */
export function recordClaudeUsage(outDir: string, jobId: string, step: ClaudeUsageStep): void {
  try {
    mkdirSync(outDir, { recursive: true });
    const steps = [...(readClaudeUsageFile(outDir)?.steps ?? []), step];
    const file: ClaudeUsageFile = { steps, total: sumClaudeUsage(steps) };
    writeFileSync(path.join(outDir, CLAUDE_USAGE_FILE), JSON.stringify(file, null, 2), 'utf-8');
    console.log(formatUsageLine(jobId, step));
  } catch (e) {
    console.warn(`[claudeUsage] record failed: ${(e as Error).message}`);
  }
}

/** stdout から取り出して記録する便利関数（取れなければ何もしない） */
export function recordClaudeUsageFromStdout(outDir: string, jobId: string, step: ClaudeStep, stdout: string): void {
  try {
    const s = extractClaudeUsage(stdout, step);
    if (s) recordClaudeUsage(outDir, jobId, s);
  } catch { /* noop */ }
}

/**
 * Claude Code がセッションログを置くプロジェクトディレクトリ名: 作業ディレクトリのパスの
 * `:` `\` `/` を `-` に置き換えた形（例 C--Users-admin-...-jobs-<jobId>）
 */
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

/** ジョブ API 用: total だけ返す（ファイルが無ければ null） */
export function readClaudeUsageTotal(jobDir: string): ClaudeUsageTotal | null {
  return readClaudeUsageFile(path.join(jobDir, 'out'))?.total ?? null;
}
