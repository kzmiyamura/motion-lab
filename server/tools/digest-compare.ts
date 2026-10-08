/**
 * handHints の短縮・まとめ（HAND_HINTS_KEY）の前後で、digest の情報が同じことを機械的に照合する。claude は呼ばない。
 *   1. 前（compactHints=false）と後で、events の件数・t・type・mmss・strips・detail・hold・spin が同じ
 *   2. 各イベントの handHints を 展開（expandHandHints）して、(キー = 後ろか・手の組・重なり) ごとの時刻の区間を取り出し、
 *      前の区間を「間が 0.3 秒以内ならつなぐ」で独立に作り直したものと一致する（時刻・手の組が落ちていない）
 *   3. occluded は前後で完全に同じ
 * Usage（server/ で）: npx tsx tools/digest-compare.ts <jobの out ディレクトリ>...
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildDigest, expandHandHints, listKeyframes, stringifyDigest } from '../src/digest.js';

type Json = Record<string, unknown>;
const RUN = /^(\d+(?:\.\d+)?)〜(\d+(?:\.\d+)?) 秒(\(区間のあと\))? (.*)$/;

/** 文の一覧 → { "後|中身": [[from,to]...] }（つながない。同じキーの区間を時刻順に） */
function runsOf(list: string[]): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  for (const s of list) {
    const m = RUN.exec(s);
    const key = m ? `${m[3] ? '後' : ''}|${m[4]}` : `?|${s}`;
    (out[key] ??= []).push(m ? [Number(m[1]), Number(m[2])] : [NaN, NaN]);
  }
  for (const v of Object.values(out)) v.sort((a, b) => a[0] - b[0]);
  return out;
}
function bridge(rs: Array<[number, number]>, gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] <= gap + 1e-9) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

let bad = 0;
for (const arg of process.argv.slice(2)) {
  const outDir = path.resolve(arg);
  const m = JSON.parse(readFileSync(path.join(outDir, 'measurements.json'), 'utf-8')) as Json;
  const tp = path.join(outDir, 'measurements.tracks.json');
  const tracks = existsSync(tp) ? JSON.parse(readFileSync(tp, 'utf-8')) : null;
  const kf = listKeyframes(path.join(outDir, 'keyframes'));
  const before = buildDigest(m, kf, { pythonBin: 'PY' }, tracks, false);
  const after = buildDigest(m, kf, { pythonBin: 'PY' }, tracks, true);
  const bt = stringifyDigest(before).length, at = stringifyDigest(after).length;
  const be = before.events as Json[], ae = after.events as Json[];
  const errs: string[] = [];
  if (be.length !== ae.length) errs.push(`events 件数 ${be.length} → ${ae.length}`);
  let hints = 0, runsBefore = 0, runsAfter = 0;
  be.forEach((e, i) => {
    const a = ae[i];
    for (const k of ['t', 'type', 'mmss', 'strips', 'detail', 'hold', 'spin', 'by', 'rotations', 'pass', 'handRaise']) {
      if (JSON.stringify(e[k]) !== JSON.stringify(a[k])) errs.push(`event ${i} ${k} が違う`);
    }
    const hb = e.handHints as Record<string, string[]> | undefined, ha = a.handHints as Record<string, string[]> | undefined;
    if (!!hb !== !!ha) { errs.push(`event ${i} handHints の有無が違う`); return; }
    if (!hb || !ha) return;
    hints++;
    if (JSON.stringify(hb.occluded) !== JSON.stringify(ha.occluded)) errs.push(`event ${i} occluded が違う`);
    for (const field of ['jointHands', 'headHand'] as const) {
      const exp = runsOf(ha[field].flatMap(expandHandHints));
      const ref = runsOf(hb[field]);
      for (const v of Object.values(ref)) runsBefore += v.length;
      for (const v of Object.values(exp)) runsAfter += v.length;
      const keys = new Set([...Object.keys(exp), ...Object.keys(ref)]);
      for (const key of keys) {
        const want = JSON.stringify(bridge(ref[key] ?? [], 0.3)), got = JSON.stringify(exp[key] ?? []);
        if (want !== got) errs.push(`event ${i} ${field} [${key.slice(0, 40)}] 期待 ${want} / 実際 ${got}`);
      }
    }
  });
  console.log(`${path.basename(path.dirname(outDir))}: digest ${bt} → ${at} 文字（${Math.round((1 - at / bt) * 100)}% 減）, events ${be.length}, handHints 付き ${hints}, 区間 ${runsBefore} → ${runsAfter}, 不一致 ${errs.length}`);
  for (const e of errs.slice(0, 8)) console.log('  ✗', e);
  bad += errs.length;
}
process.exit(bad ? 1 : 0);
