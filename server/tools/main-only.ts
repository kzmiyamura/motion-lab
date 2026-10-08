/**
 * 既存ジョブの CV 出力（measurements・keyframes）を別ディレクトリに写して、Claude の main ステップだけをもう一度回す。
 * プロンプトを変えたときの比較用（CV に 30 分かけない）。元ジョブの result.json / report.md は上書きしない。
 *
 * Usage（server/ で）:
 *   npx tsx tools/main-only.ts --src-server <本番の server ディレクトリ（.env を読む）> --job <jobId> --tag <名前>
 * 結果: <storage>/analysis-jobs/<jobId>-<tag>/out/{result.json,report.md,claude-usage.json}
 * 元ジョブは MOTION_LAB_STORAGE（既定 server/storage）の analysis-jobs/<jobId>/ にあるものを使う。
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const srcServer = opt('src-server'), jobId = opt('job'), tag = opt('tag') ?? 'main2';
if (!srcServer || !jobId) {
  console.error('usage: tsx tools/main-only.ts --src-server <server dir> --job <jobId> --tag <名前>');
  process.exit(2);
}
const envPath = path.join(path.resolve(srcServer), '.env');
if (existsSync(envPath)) {
  for (const [k, v] of Object.entries(dotenv.parse(readFileSync(envPath)))) if (process.env[k] === undefined) process.env[k] = v;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const STORAGE = process.env.MOTION_LAB_STORAGE ?? path.resolve(here, '../storage');
const srcDir = path.join(STORAGE, 'analysis-jobs', jobId);
const dstDir = path.join(STORAGE, 'analysis-jobs', `${jobId}-${tag}`);
if (!existsSync(path.join(srcDir, 'out', 'measurements.json'))) { console.error(`CV 出力がありません: ${srcDir}`); process.exit(1); }
if (existsSync(dstDir)) { console.error(`すでにあります（別の --tag を使う）: ${dstDir}`); process.exit(1); }

// 動画・前回の成果物・使用量ログは写さない
const SKIP = /\.(mp4|mov)$|^(result\.json|report\.md|report\.original\.md|claude-usage\.json|digest\.json)$/i;
mkdirSync(dstDir, { recursive: true });
cpSync(srcDir, dstDir, { recursive: true, filter: s => !SKIP.test(path.basename(s)) });

const { runClaude } = await import('../src/claudeRunner.js');
const { PRESETS } = await import('../src/presets.js');
const preset = PRESETS['salsa-pair'];
const specPath = path.join(dstDir, 'spec.md');
const spec = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : '';
console.log(`[main-only] ${jobId} -> ${dstDir} model_main=${process.env.CLAUDE_MODEL_MAIN ?? '(未設定)'}`);
const t0 = Date.now();
const r = await runClaude(dstDir, spec, new AbortController().signal, {
  promptFile: preset.promptFile, copySalsaKnowledge: preset.copySalsaKnowledge, digest: true,
});
console.log(`[main-only] done ${Math.round((Date.now() - t0) / 1000)}s result=${r.resultJson ? r.resultJson.length : 'none'} report=${r.reportMd.length}`);
