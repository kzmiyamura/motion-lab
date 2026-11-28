/**
 * measurements.json の summary.handLeadIn を書き足す（冒頭の手の推定。digest の handLeadIn と同じ計算）。
 * normalize_routine.py が読み、冒頭の行の hold を置き換える。tracks.json が無い・冒頭に読めない区間が無いときは
 * summary.handLeadIn を消す（normalize は何も上書きしない）。normalize を呼ぶ経路（jobWorker・tools/finish-segments）の
 * 直前で呼ぶ。失敗しても例外は投げない（上書きしないだけ）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildHandRegions, computeLeadIn, type Tracks } from './segmentDigest.js';

export function writeHandLeadIn(measurementsPath: string): LeadInResult {
  try {
    const raw = JSON.parse(readFileSync(measurementsPath, 'utf-8')) as Record<string, unknown>;
    const summary = (raw.summary ?? {}) as Record<string, unknown>;
    const tracksPath = measurementsPath.replace(/\.json$/, '.tracks.json');
    let li = null as ReturnType<typeof computeLeadIn>;
    if (existsSync(tracksPath)) {
      const tracks = JSON.parse(readFileSync(tracksPath, 'utf-8')) as Tracks;
      const aspect = typeof raw.width === 'number' && typeof raw.height === 'number' && raw.height > 0 ? raw.width / raw.height : 0.5625;
      li = computeLeadIn(buildHandRegions(tracks, aspect), tracks.holdTimeline ?? []);
    }
    if (li) summary.handLeadIn = li; else delete summary.handLeadIn;
    raw.summary = summary;
    writeFileSync(measurementsPath, JSON.stringify(raw), 'utf-8');
    return li ? { ok: true, hand: li.hand, to: li.to } : { ok: true, hand: null, to: null };
  } catch (e) {
    console.warn(`[handLeadIn] skipped: ${e instanceof Error ? e.message : e}`);
    return { ok: false, hand: null, to: null };
  }
}

export interface LeadInResult { ok: boolean; hand: string | null; to: number | null }
