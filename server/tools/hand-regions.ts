/**
 * 連続区間ごとの手の推定（buildHandRegions）を tracks.json から出す。claude は呼ばない。
 *
 * Usage（server/ で）: npx tsx tools/hand-regions.ts <measurements.tracks.json> [--gt <ground_truth.json>] [--aspect 0.5625]
 *   --gt を付けると、正解表の holds[]（t, leader, follower）の時刻ごとに、その時刻を覆う区間の推定の手と比べる
 *   （leader=男の手 L/R、follower=女の手 L/R か null。推定 "R-R" = リーダー右手×フォロワー右手）
 */
import { readFileSync } from 'node:fs';
import { buildHandRegions, describeHandRegions, describeLeadIn, type Tracks } from '../src/segmentDigest.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: tsx tools/hand-regions.ts <tracks.json> [--gt <gt.json>] [--aspect n]'); process.exit(2); }
const tracks = JSON.parse(readFileSync(file, 'utf-8')) as Tracks;
const aspect = Number(opt('aspect') ?? 0.5625);
const regions = buildHandRegions(tracks, aspect);
console.log(`regions=${regions.length}`);
if (args.includes('--all')) for (const s of describeHandRegions(regions, tracks.holdTimeline ?? [])) console.log('  ' + s.slice(0, 400));
console.log('leadIn: ' + (describeLeadIn(regions, tracks.holdTimeline ?? []) ?? '（なし）'));

const gtPath = opt('gt');
if (gtPath) {
  const gt = JSON.parse(readFileSync(gtPath, 'utf-8')) as { holds?: Array<{ t: number; leader: string; follower: string | null }> };
  let lead = 0, both = 0, nBoth = 0, none = 0;
  for (const h of gt.holds ?? []) {
    const g = regions.find(r => h.t >= r.from - 1e-6 && h.t <= r.to + 1e-6);
    const est = g?.hand ?? null;
    const okL = est !== null && est[0] === h.leader;
    if (est === null) none++;
    if (okL) lead++;
    if (h.follower !== null) { nBoth++; if (okL && est![2] === h.follower) both++; }
    console.log(`  t=${h.t} GT ${h.leader}/${h.follower ?? '-'}  推定 ${est ?? '-'}${g?.split ? '?' : ''}  ${est === null ? '（区間外）' : okL ? '男○' : '男×'}`);
  }
  console.log(`  男の手 ${lead}/${(gt.holds ?? []).length}  両方 ${both}/${nBoth}  区間外 ${none}`);
}
