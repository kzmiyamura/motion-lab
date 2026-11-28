/**
 * measurements.json に summary.handLeadIn を書き足す（jobWorker が normalize の前にやるのと同じ。claude は呼ばない）。
 * Usage（server/ で）: npx tsx tools/write-hand-leadin.ts <measurements.json>
 */
import { readFileSync } from 'node:fs';
import { writeHandLeadIn } from '../src/handLeadIn.js';

const p = process.argv[2];
if (!p) { console.error('usage: tsx tools/write-hand-leadin.ts <measurements.json>'); process.exit(2); }
const r = writeHandLeadIn(p);
const li = (JSON.parse(readFileSync(p, 'utf-8')).summary ?? {}).handLeadIn;
console.log(JSON.stringify({ ...r, handLeadIn: li ?? null }));
