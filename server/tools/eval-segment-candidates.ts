/**
 * 区間の自動選択（findCandidates）の評価: 正解表の hold のうち「既存の手が外れている」時刻を、候補の窓がどれだけ拾うか（再現率）と、
 * 候補数・候補の合計秒数（動画の長さに対する割合）を出す。claude は呼ばない。
 *
 * Usage（server/ で）: npx tsx tools/eval-segment-candidates.ts [--job <jobId> --wrong <秒,秒,…>]
 *   引数なし … analysis/ground_truth の全動画。--job … 単独（--wrong で外れている時刻を教える。820f0461 のカード1 は 1.0 等）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHands } from '../src/segmentDigest.js';
import { findCandidates } from '../src/segmentCandidates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const STORAGE = process.env.MOTION_LAB_STORAGE ?? path.join(SERVER_DIR, 'storage');
const GT_DIR = path.join(SERVER_DIR, 'analysis', 'ground_truth');
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null);

function run(job: string, wrong: Array<{ t: number; note: string }>, all: Array<{ t: number; note: string }>, label: string) {
  const out = path.join(STORAGE, 'analysis-jobs', job, 'out');
  const tracks = readJson(path.join(out, 'measurements.tracks.json'));
  if (!tracks) { console.log(`${label}: tracks なし`); return null; }
  const m = readJson(path.join(out, 'measurements.json')) as { summary?: { events?: unknown[]; holdUnclear?: Array<{ from: number; to: number }> } } | null;
  const dur = tracks.frames.length ? tracks.frames[tracks.frames.length - 1].t : 0;
  const cands = findCandidates({
    tracks, result: readJson(path.join(out, 'result.json')),
    summaryEvents: (m?.summary?.events ?? null) as Record<string, unknown>[] | null, holdUnclear: m?.summary?.holdUnclear ?? null, duration: dur,
  });
  const secs = cands.reduce((s, c) => s + (c.to - c.from), 0);
  const caught = (t: number) => cands.some(c => t >= c.from - 0.3 && t <= c.to + 0.3);
  const w = wrong.filter(x => caught(x.t)).length, a = all.filter(x => caught(x.t)).length;
  console.log(`${label}: 候補 ${cands.length} 窓 / ${secs.toFixed(1)} 秒（動画 ${dur.toFixed(1)} 秒の ${Math.round((secs / Math.max(dur, 1)) * 100)}%） ` +
    `外れの再現 ${w}/${wrong.length}  正解表の全 hold を含む ${a}/${all.length}`);
  for (const x of wrong) console.log(`   外れ t=${x.t} ${caught(x.t) ? '拾った' : '見逃し'} ${x.note}`);
  return { cands, secs, dur, w, wn: wrong.length };
}

if (opt('job')) {
  const ts = (opt('wrong') ?? '').split(',').filter(Boolean).map(Number).map(t => ({ t, note: '' }));
  const r = run(opt('job')!, ts, ts, opt('job')!.slice(0, 8));
  if (r) for (const c of r.cands.slice(0, 15)) console.log(`   ${c.from}〜${c.to} (${c.score}) ${c.reasons.slice(0, 3).join(' / ')}`);
} else {
  let W = 0, WN = 0, C = 0, S = 0, D = 0;
  for (const f of readdirSync(GT_DIR).filter(x => x.endsWith('.json')).sort()) {
    const gt = readJson(path.join(GT_DIR, f)) as { job?: string; holds?: Array<{ t: number; leader: string; follower: string | null }> };
    if (!gt.job || !gt.holds?.length) continue;
    const rep = ['report.original.md', 'report.md'].map(n => path.join(STORAGE, 'analysis-jobs', gt.job!, 'out', n)).find(existsSync);
    const heads: Array<{ s: number; line: string }> = [];
    if (rep) for (const ln of readFileSync(rep, 'utf-8').split(/\r?\n/)) {
      const mm = /^\*\*(\d+):(\d+(?:\.\d+)?)[^*]*\*\*/.exec(ln.trim());
      if (mm) heads.push({ s: Number(mm[1]) * 60 + Number(mm[2]), line: ln });
    }
    const all = gt.holds.map(h => ({ t: h.t, note: '' }));
    const wrong = gt.holds.filter(h => {
      const b = heads.filter(x => x.s <= h.t + 0.3).pop();
      if (!b) return false;
      const p = parseHands(b.line);
      return !(p.man === h.leader && (h.follower === null || p.woman === h.follower));
    }).map(h => ({ t: h.t, note: '既存の手が正解と違う' }));
    const r = run(gt.job, wrong, all, f.replace('.json', ''));
    if (r) { W += r.w; WN += r.wn; C += r.cands.length; S += r.secs; D += r.dur; }
  }
  console.log(`合計: 外れの再現 ${W}/${WN}  候補 ${C} 窓  ${S.toFixed(0)} 秒 / 動画 ${D.toFixed(0)} 秒（${Math.round((S / Math.max(D, 1)) * 100)}%）`);
}
