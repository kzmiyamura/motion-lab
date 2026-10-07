/**
 * 間違えている区間だけを AI に解析し直させる（全体の再解析は 1 回でキャッシュ読み約 55 万トークン。数秒の区間なら桁が違う）。
 *
 * Usage（server/ で）:
 *   npx tsx tools/reanalyze-segment.ts --job <jobId> --from <秒> --to <秒> [--model sonnet|opus] [--apply]
 *     [--tag <名前>] [--images overview,detail] [--step 0.2] [--dstep 0.3] [--max-turns 8] [--dry]
 *   --dry   … claude を呼ばず、digest と画像だけ作ってプロンプトの大きさを出す
 *   --apply … 答えで result.json の該当行を置き換える（既定は out/segment-<from>-<to>.json に書くだけ。result.json.bak を残す）
 * 保存先は MOTION_LAB_STORAGE（既定 server/storage）、DB は MOTION_LAB_DB（既定 <storage>/../data/motionlab.db）。
 * 正解は一切入れない（CV の計算値・今のカード・指示書の手の判定ルールだけ）。トークンは claudeUsage と同じ形で結果 JSON に残す。
 * レート制限に当たったら exit 3。
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { buildClaudeArgs, makeWorkdir, removeWorkdir } from '../src/claudeRunner.js';
import { extractClaudeUsage } from '../src/claudeUsage.js';
import { applySegmentRows, buildSegmentDigest, buildSegmentPrompt, extractHandRules, parseSegmentAnswer } from '../src/segmentDigest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_DIR, '.env'), quiet: true });
const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const STORAGE = process.env.MOTION_LAB_STORAGE ?? path.join(SERVER_DIR, 'storage');
const DB_PATH = process.env.MOTION_LAB_DB ?? path.join(STORAGE, '..', 'data', 'motionlab.db');

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const flag = (k: string) => args.includes(`--${k}`);

const IMAGE_NOTES: Record<string, string> = {
  'seg_overview.jpg': '区間全体の一覧（2人の外接矩形で切り取り。左上の数字が秒）',
  'seg_detail_1.jpg': '2人の上半身の拡大（3x2。左上の数字が秒）。手のつなぎ・腕の形・頭に手をかける動きを読む',
  'seg_detail_2.jpg': '同上の続き',
  'seg_detail_3.jpg': '同上の続き',
};

async function main(): Promise<number> {
  const jobId = opt('job');
  const from = Number(opt('from')), to = Number(opt('to'));
  if (!jobId || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    console.error('Usage: reanalyze-segment.ts --job <jobId> --from <秒> --to <秒> [--model sonnet|opus] [--apply]');
    return 1;
  }
  const model = opt('model') ?? null;
  const tag = opt('tag');
  const jobDir = path.join(STORAGE, 'analysis-jobs', jobId);
  const outDir = path.join(jobDir, 'out');
  const runName = `segment-${from}-${to}${tag ? `.${tag}` : ''}`;
  const runDir = path.join(outDir, 'segment-runs', runName);
  mkdirSync(runDir, { recursive: true });

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare('SELECT v.id AS vid, v.original_filename AS fn FROM analysis_jobs j JOIN videos v ON v.id = j.video_id WHERE j.id = ?')
    .get(jobId) as { vid: string; fn: string } | undefined;
  if (!row) throw new Error(`job not found: ${jobId}`);
  const video = path.join(STORAGE, 'originals', `${row.vid}${path.extname(row.fn) || '.mp4'}`);
  const tracksPath = path.join(outDir, 'measurements.tracks.json');

  // 1. 区間専用の画像
  const want = (opt('images') ?? 'overview,detail').split(',');
  const imgArgs = [path.join(SERVER_DIR, 'analysis', 'make_segment_images.py'), video, runDir, `--from=${from}`, `--to=${to}`,
    `--tracks=${tracksPath}`, `--detail-to=${to + Number(opt('look', '0'))}`, `--step=${opt('step', '0.2')}`, `--dstep=${opt('dstep', '0.3')}`];
  if (!want.includes('overview')) imgArgs.push('--no-overview');
  if (!want.includes('detail')) imgArgs.push('--no-detail');
  const py = spawnSync(PYTHON_BIN, imgArgs, { encoding: 'utf-8', env: { ...process.env, PYTHONUTF8: '1', OMP_NUM_THREADS: '4' } });
  if (py.status !== 0) throw new Error(`make_segment_images failed: ${py.stderr}`);
  const meta = JSON.parse(readFileSync(path.join(runDir, 'seg_meta.json'), 'utf-8')) as { width: number; height: number; cuts: number[]; files: string[] };

  // 2. 区間ダイジェスト（純粋関数）
  const tracks = JSON.parse(readFileSync(tracksPath, 'utf-8'));
  const measurements = JSON.parse(readFileSync(path.join(outDir, 'measurements.json'), 'utf-8')) as { summary?: { events?: unknown[] } };
  const resultPath = path.join(outDir, 'result.json');
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf-8')) : null;
  const digest = buildSegmentDigest({
    tracks, result, summaryEvents: (measurements.summary?.events ?? null) as Record<string, unknown>[] | null,
    from, to, aspect: meta.width / meta.height, cuts: meta.cuts, drop: (opt('drop') ?? '').split(',').filter(Boolean),
  });
  const specMd = readFileSync(opt('spec') ?? path.join(jobDir, 'spec.md'), 'utf-8');
  const prompt = buildSegmentPrompt(digest, {
    handRules: extractHandRules(specMd),
    images: meta.files.map(f => ({ file: f, note: IMAGE_NOTES[f] ?? '' })),
  });
  writeFileSync(path.join(runDir, 'digest.json'), JSON.stringify(digest, null, 1), 'utf-8');
  writeFileSync(path.join(runDir, 'prompt.txt'), prompt, 'utf-8');
  console.log(`[segment] digest ${JSON.stringify(digest).length} 文字 / prompt ${prompt.length} 文字 / images ${meta.files.join(',')} / cuts ${meta.cuts.join(',') || '-'}`);
  if (flag('dry')) return 0;

  // 3. claude（Read だけ許可。作業場所は一時ディレクトリ。本番の out/ は触らない）
  const work = makeWorkdir(`segment-${jobId.slice(0, 8)}`);
  for (const f of meta.files) copyFileSync(path.join(runDir, f), path.join(work, f));
  const started = Date.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, buildClaudeArgs('turnJudge', opt('max-turns', '8')!, model), {
      cwd: work, env: { ...process.env }, shell: process.platform === 'win32',
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.stdin.on('error', () => { /* noop */ });
    proc.stdin.write(prompt);
    proc.stdin.end();
    proc.on('error', reject);
    proc.on('exit', code => (code === 0 || out ? resolve(out) : reject(new Error(`claude exit ${code}: ${err.slice(-500)}`))));
  }).finally(() => removeWorkdir(work));
  const usage = extractClaudeUsage(stdout, 'segment', new Date(), model);
  let resultText = '';
  try { resultText = (JSON.parse(stdout) as { result?: string }).result ?? ''; } catch { /* noop */ }
  if (/rate limit|usage limit|overloaded/i.test(resultText) && !parseSegmentAnswer(resultText)) {
    console.error(`[segment] rate limited: ${resultText.slice(0, 200)}`);
    return 3;
  }
  const answer = parseSegmentAnswer(resultText);
  const record = {
    job: jobId, from, to, model, tag: tag ?? null, elapsedMs: Date.now() - started,
    rows: answer?.rows ?? null, basis: answer?.basis ?? null, raw: answer ? undefined : resultText.slice(0, 2000),
    usage, images: meta.files, applied: false,
  };

  // 4. --apply のときだけ result.json を置き換える（bak を残す）
  if (flag('apply') && answer && result) {
    copyFileSync(resultPath, `${resultPath}.bak`);
    writeFileSync(resultPath, JSON.stringify(applySegmentRows(result, from, to, answer.rows), null, 2), 'utf-8');
    record.applied = true;
  }
  const outFile = path.join(outDir, `${runName}.json`);
  writeFileSync(outFile, JSON.stringify(record, null, 2), 'utf-8');
  console.log(`[segment] wrote ${outFile}`);
  if (usage) {
    console.log(`[segment] usage out=${usage.output_tokens} cacheW=${usage.cache_creation_input_tokens} cacheR=${usage.cache_read_input_tokens} in=${usage.input_tokens} turns=${usage.num_turns}`);
  }
  console.log(JSON.stringify(answer?.rows ?? resultText.slice(0, 500), null, 1));
  return answer ? 0 : 2;
}

main().then(c => process.exit(c)).catch(e => { console.error(`[segment] ${(e as Error).message}`); process.exit(1); });
