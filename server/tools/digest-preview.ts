/**
 * 既存ジョブの out から digest.json（handHints 込み）を作って大きさと最初の技の手のヒントを出す。claude は呼ばない。
 *
 * Usage（server/ で）: npx tsx tools/digest-preview.ts <jobの out ディレクトリ> <出力ディレクトリ> [何件目まで表示]
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeDigest } from '../src/digest.js';

const [outDir, dst, nStr] = process.argv.slice(2);
if (!outDir || !dst) {
  console.error('usage: tsx tools/digest-preview.ts <job out dir> <dst dir> [n]');
  process.exit(2);
}
mkdirSync(dst, { recursive: true });
const p = writeDigest(path.resolve(outDir), { pythonBin: 'PY' }, path.resolve(dst));
if (!p) { console.error('digest を作れませんでした'); process.exit(1); }
const text = readFileSync(p, 'utf-8');
const d = JSON.parse(text) as { events: Array<Record<string, unknown>> };
const withHints = d.events.filter(e => e.handHints).length;
console.log(`digest ${text.length} 文字 / events ${d.events.length} / handHints 付き ${withHints}`);
for (const e of d.events.slice(0, Number(nStr ?? 4))) console.log(JSON.stringify({ t: e.t, type: e.type, handHints: e.handHints ?? null }));
