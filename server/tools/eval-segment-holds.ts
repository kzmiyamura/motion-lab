/**
 * 区間再解析の手の正答率: 正解表（analysis/ground_truth/*.json の holds）の各時刻を区間 [t-half, t+half] にして
 * reanalyze-segment を回し、「既存（report.original.md か report.md の見出し）」と「区間再解析」の手を正解と比べる。
 * 正解はプロンプトに入れない（採点だけ）。
 *
 * Usage（server/ で）:
 *   npx tsx tools/eval-segment-holds.ts --tag <名前> [--half 1.5] [--only <正解表名>] [--dry-baseline] [-- <reanalyze-segment に渡す引数>]
 *   --dry-baseline … claude を回さず既存の正答率だけ出す
 * 結果は標準出力の表と、<scratch>/eval-<tag>.json（--out）に出す。トークンは合計も出す。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHands, type ParsedHands } from '../src/segmentDigest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const STORAGE = process.env.MOTION_LAB_STORAGE ?? path.join(SERVER_DIR, 'storage');
const GT_DIR = path.join(SERVER_DIR, 'analysis', 'ground_truth');

const args = process.argv.slice(2);
const dd = args.indexOf('--');
const own = dd >= 0 ? args.slice(0, dd) : args;
const pass = dd >= 0 ? args.slice(dd + 1) : [];
const opt = (k: string, d?: string) => { const i = own.indexOf(`--${k}`); return i >= 0 ? own[i + 1] : d; };
const tag = opt('tag', 'eval')!;
const half = Number(opt('half', '1.5'));
const only = opt('only');
const dry = own.includes('--dry-baseline');

interface GtHold { t: number; leader: 'L' | 'R' | 'both'; follower: 'L' | 'R' | 'both' | null }

function baselineHands(job: string, t: number): string | null {
  const out = path.join(STORAGE, 'analysis-jobs', job, 'out');
  const f = ['report.original.md', 'report.md'].map(n => path.join(out, n)).find(existsSync);
  if (!f) return null;
  let best: { s: number; line: string } | null = null;
  for (const ln of readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = /^\*\*(\d+):(\d+(?:\.\d+)?)[^*]*\*\*/.exec(ln.trim());
    if (!m) continue;
    const s = Number(m[1]) * 60 + Number(m[2]);
    if (s <= t + 0.3 && (!best || s >= best.s)) best = { s, line: ln };
  }
  return best ? best.line : null;
}

function score(p: ParsedHands, gt: GtHold) {
  const man = p.man === gt.leader || (gt.leader === 'both' && p.man === 'both');
  const full = man && (gt.follower === null || p.woman === gt.follower);
  return { man, full };
}

interface Row { name: string; gt: GtHold; baseline?: string | null; baseMan?: boolean; baseFull?: boolean; seg?: string; segMan?: boolean; segFull?: boolean; tokens?: Usage }
interface Usage { out: number; cacheW: number; cacheR: number; turns: number }

const rows: Row[] = [];
const total: Usage = { out: 0, cacheW: 0, cacheR: 0, turns: 0 };
for (const f of readdirSync(GT_DIR).filter(x => x.endsWith('.json')).sort()) {
  const name = f.replace(/\.json$/, '');
  if (only && name !== only) continue;
  const gt = JSON.parse(readFileSync(path.join(GT_DIR, f), 'utf-8')) as { job?: string; holds?: GtHold[] };
  if (!gt.job || !gt.holds?.length) continue;
  for (const h of gt.holds) {
    const row: Row = { name, gt: h };
    const base = baselineHands(gt.job, h.t);
    row.baseline = base;
    if (base) { const s = score(parseHands(base), h); row.baseMan = s.man; row.baseFull = s.full; }
    if (!dry) {
      const from = Math.max(0, Math.round((h.t - half) * 10) / 10), to = Math.round((h.t + half) * 10) / 10;
      const r = spawnSync('npx', ['tsx', 'tools/reanalyze-segment.ts', '--job', gt.job, '--from', String(from), '--to', String(to),
        '--model', 'sonnet', '--tag', tag, '--look', '1.5', ...pass], { cwd: SERVER_DIR, encoding: 'utf-8', shell: true, env: { ...process.env } });
      const outFile = path.join(STORAGE, 'analysis-jobs', gt.job, 'out', `segment-${from}-${to}.${tag}.json`);
      if (existsSync(outFile)) {
        const rec = JSON.parse(readFileSync(outFile, 'utf-8')) as { rows: Array<{ start: number; hands: string; name: string }> | null; usage: { output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; num_turns: number } | null };
        const rs = rec.rows ?? [];
        const pick = [...rs].filter(x => x.start <= h.t + 0.3).pop() ?? rs[0];
        if (pick) {
          row.seg = `${pick.hands} / ${pick.name}`;
          const s = score(parseHands(pick.hands), h); row.segMan = s.man; row.segFull = s.full;
        }
        if (rec.usage) {
          row.tokens = { out: rec.usage.output_tokens, cacheW: rec.usage.cache_creation_input_tokens, cacheR: rec.usage.cache_read_input_tokens, turns: rec.usage.num_turns };
          total.out += row.tokens.out; total.cacheW += row.tokens.cacheW; total.cacheR += row.tokens.cacheR; total.turns += row.tokens.turns;
        }
      } else console.error(`[eval] ${name} t=${h.t} 失敗: ${(r.stderr ?? '').slice(-200)}`);
    }
    rows.push(row);
    console.log(`${name} t=${h.t} GT=${h.leader}/${h.follower ?? '-'} | 既存: ${row.baseline ? (row.baseMan ? '男○' : '男×') + (row.baseFull ? '全○' : '全×') : '-'} | 再解析: ${row.seg ?? '-'} ${row.seg ? (row.segMan ? '男○' : '男×') + (row.segFull ? '全○' : '全×') : ''}`);
  }
}
const cnt = (f: (r: Row) => boolean | undefined, g: (r: Row) => boolean) => `${rows.filter(r => g(r) && f(r)).length}/${rows.filter(g).length}`;
console.log(`既存   男の手 ${cnt(r => r.baseMan, r => r.baseline != null)}  男女 ${cnt(r => r.baseFull, r => r.baseline != null)}`);
if (!dry) {
  console.log(`再解析 男の手 ${cnt(r => r.segMan, r => r.seg != null)}  男女 ${cnt(r => r.segFull, r => r.seg != null)}`);
  console.log(`再解析（既存がある行だけ） 男の手 ${cnt(r => r.segMan, r => r.baseline != null && r.seg != null)}  男女 ${cnt(r => r.segFull, r => r.baseline != null && r.seg != null)}`);
  console.log(`トークン合計 out=${total.out} cacheW=${total.cacheW} cacheR=${total.cacheR} turns=${total.turns} / ${rows.filter(r => r.tokens).length} 回`);
}
const outPath = opt('out');
if (outPath) writeFileSync(outPath, JSON.stringify({ tag, half, pass, rows, total }, null, 1), 'utf-8');
