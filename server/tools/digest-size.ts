/**
 * digest.json の大きさの内訳を数える（Read の 1 回あたりの上限を超えていないかの確認用。claude は使わない）。
 * Usage（server/ で）: npx tsx tools/digest-size.ts <out ディレクトリ（measurements.json と keyframes/ がある所）>
 * トークンは文字数 ÷ 2.2 の目安（日本語・JSON が混ざるので概算）。digest は一時ディレクトリに書く（元は触らない）。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDigest } from '../src/digest.js';

type Json = Record<string, unknown>;
const outDir = process.argv[2];
if (!outDir) { console.error('usage: tsx tools/digest-size.ts <outDir>'); process.exit(2); }
const tmp = mkdtempSync(path.join(os.tmpdir(), 'digest-size-'));
const dst = writeDigest(path.resolve(outDir), { pythonBin: 'python' }, tmp);
if (!dst) { console.error('digest を作れなかった'); process.exit(1); }
const text = readFileSync(dst, 'utf-8');
const d = JSON.parse(text) as Json;
const lines = text.split('\n');
const tok = (n: number) => Math.round(n / 2.2);
console.log(`digest: ${text.length} chars ≈ ${tok(text.length)} tokens, ${lines.length} lines, longest line ${Math.max(...lines.map(l => l.length))} chars`);
for (const [k, v] of Object.entries(d)) console.log(`  ${k.padEnd(18)} ${String(JSON.stringify(v).length).padStart(7)} chars ≈ ${String(tok(JSON.stringify(v).length)).padStart(6)} tokens`);
for (const key of Object.keys(d)) {
  const v = d[key];
  if (!Array.isArray(v) || !v.length || typeof v[0] !== 'object') continue;
  const by: Record<string, number> = {};
  for (const x of v as Json[]) for (const [f, val] of Object.entries(x)) by[f] = (by[f] ?? 0) + JSON.stringify(val).length;
  console.log(`  [${key}] ${v.length} 件:`, Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f}=${n}`).join(' '));
}
