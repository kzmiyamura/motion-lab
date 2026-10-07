/**
 * 区間の自動選択: 「AI に解析し直させる価値がある区間」の候補を、計算値だけで列挙する（実行はしない）。
 * 拾う印:
 *   hold      … hold の信頼度が低い（重なり・隠れが半分以上）／estimated（前後から補った）／holdUnclear
 *   occluded  … 2人が重なる・片方が隠れる区間が長い
 *   card      … 今のカードが怪しい（技名に「?」・自信が低い・passCheck/turnCheck あり）、
 *               または CV と食い違う（hold の手・回る向き・女性の CV ターンがカードに無い／男性のターンと書かれている）
 * 近い印は 1 つの窓にまとめる（長すぎる窓は割る）。正解は使わない。
 */
import { framesIn, toIntervals, type HoldSpan, type Tracks } from './segmentDigest.js';

type Json = Record<string, unknown>;

export interface Candidate { from: number; to: number; reasons: string[]; score: number }

export interface CandidateInputs {
  tracks: Tracks;
  result?: Json | null;
  summaryEvents?: Json[] | null;
  /** measurements.json の summary.holdUnclear（無い古いジョブは省略） */
  holdUnclear?: Array<{ from: number; to: number }> | null;
  /** 長さ（秒）。省略すると tracks の最後の時刻 */
  duration?: number;
  pad?: number;
  maxWindow?: number;
  minOccludedSec?: number;
  /** この秒数以上の重なり/隠れは、それだけで候補にする（それ未満は他の強い印に理由を足すだけ） */
  strongOccludedSec?: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** 'リーダー左手×フォロワー右手' → 'LR'（読めなければ null） */
export function holdCode(label: string | undefined | null): string | null {
  if (!label) return null;
  const m = /リーダー(右|左)手×フォロワー(右|左)手/.exec(label);
  if (!m) return null;
  return (m[1] === '右' ? 'R' : 'L') + (m[2] === '右' ? 'R' : 'L');
}

interface Mark { from: number; to: number; reason: string; strong: boolean }

export function findCandidates(inp: CandidateInputs): Candidate[] {
  const { tracks } = inp;
  const pad = inp.pad ?? 0.5, maxWin = inp.maxWindow ?? 4, minOcc = inp.minOccludedSec ?? 1.5;
  const dur = inp.duration ?? (tracks.frames.length ? tracks.frames[tracks.frames.length - 1].t : 0);
  const marks: Mark[] = [];

  // hold
  for (const h of (tracks.holdTimeline ?? []) as Array<HoldSpan & { estimated?: [number, number] }>) {
    const fr = framesIn(tracks, h.from, h.to);
    const bad = fr.length ? fr.filter(f => f.state !== 'apart').length / fr.length : 1;
    if (bad >= 0.5) marks.push({ from: h.from, to: h.to, reason: `hold の信頼度が低い（重なり/隠れ ${Math.round(bad * 100)}%）`, strong: true });
    if (h.estimated) marks.push({ from: h.from, to: h.to, reason: 'hold は前後から補った（estimated）', strong: true });
  }
  for (const u of inp.holdUnclear ?? []) marks.push({ from: u.from, to: u.to, reason: 'holdUnclear（手が決められない区間）', strong: true });

  // 重なり・隠れが長い
  const all = framesIn(tracks, 0, dur);
  for (const a of toIntervals(all.filter(f => f.state !== 'apart').map(f => f.t), 0.3)) {
    if (a[1] - a[0] >= minOcc) marks.push({ from: a[0], to: a[1], reason: `2人の重なり/隠れが ${r1(a[1] - a[0])} 秒続く`, strong: a[1] - a[0] >= (inp.strongOccludedSec ?? 2.0) });
  }

  // カード
  const routine = (inp.result?.routine ?? {}) as Json;
  const moves = Array.isArray(routine.moves) ? (routine.moves as Json[]) : [];
  const bpm = typeof routine.bpm === 'number' && routine.bpm > 0 ? routine.bpm : 120;
  const events = (inp.summaryEvents ?? tracks.events ?? []) as Json[];
  for (const m of moves) {
    const s = Number(m.start);
    if (!Number.isFinite(s)) continue;
    const e = s + ((typeof m.counts === 'number' ? m.counts : 8) * 60) / bpm;
    const why: string[] = [];
    if (/[?？]/.test(String(m.name ?? ''))) why.push('カードの技名に「?」');
    if (typeof m.confidence === 'number' && m.confidence < 0.4) why.push(`カードの自信が低い(${m.confidence})`);
    if (m.passCheck || m.turnCheck) why.push(`カードに食い違いの印（${String(m.passCheck ?? m.turnCheck)}）`);
    // CV の hold とカードの手
    const cvHolds = ((tracks.holdTimeline ?? []) as HoldSpan[]).filter(h => h.from < e && h.to > s).map(h => holdCode(h.hold)).filter(Boolean);
    const cardHolds = [m.holdStart, m.holdEnd].filter(x => typeof x === 'string' && /^[LR]{2}$/.test(x as string));
    if (cvHolds.length && cardHolds.length && !cvHolds.some(c => cardHolds.includes(c))) why.push(`カードの手(${cardHolds.join('/')})と CV の hold(${cvHolds.join('/')})が食い違う`);
    // CV のターン
    const turn = m.turn as { by?: string; direction?: string | null } | null | undefined;
    for (const ev of events) {
      if (ev.type !== 'Turn') continue;
      const t = Number(ev.t);
      if (t < s || t >= e) continue;
      if (ev.by === 'follower' && (!turn || turn.by === 'leader')) why.push('CV は女性のターンを検出したが、カードに女性のターンが無い');
      const run = (ev.spin as { runs?: Array<{ dir?: string }> } | undefined)?.runs?.[0];
      if (ev.by === 'follower' && turn?.by === 'follower' && run?.dir && turn.direction && run.dir !== turn.direction) {
        why.push(`カードの回る向き(${turn.direction})と CV(${run.dir})が食い違う`);
      }
    }
    for (const w of why) marks.push({ from: s, to: Math.min(e, s + 8), reason: w, strong: /CV|食い違い/.test(w) });
  }

  // 窓にまとめる
  marks.sort((a, b) => a.from - b.from);
  // 印どうしが重なるものだけまとめる（余白でつなげると動画全体が 1 つの窓になる）。強い印（hold・CV との食い違い）が 1 つも無い窓は捨てる
  const wins: Array<{ from: number; to: number; reasons: Set<string>; strong: boolean }> = [];
  // 弱い印は窓を作らず広げない（長い重なりが動画全体をつないでしまう）。重なる窓に理由だけ足す
  for (const mk of marks.filter(x => x.strong)) {
    const last = wins[wins.length - 1];
    if (last && mk.from < last.to - 0.3) { last.to = Math.max(last.to, mk.to); last.reasons.add(mk.reason); }
    else wins.push({ from: mk.from, to: mk.to, reasons: new Set([mk.reason]), strong: true });
  }
  for (const mk of marks.filter(x => !x.strong)) {
    for (const w of wins) if (mk.from < w.to && mk.to > w.from) w.reasons.add(mk.reason);
  }
  const out: Candidate[] = [];
  for (const w0 of wins.filter(x => x.strong)) {
    const w = { ...w0, from: Math.max(0, w0.from - pad), to: Math.min(dur || w0.to + pad, w0.to + pad) };
    const n = Math.max(1, Math.ceil((w.to - w.from) / maxWin));
    const len = (w.to - w.from) / n;
    for (let i = 0; i < n; i++) {
      out.push({ from: r1(w.from + i * len), to: r1(w.from + (i + 1) * len), reasons: [...w.reasons], score: w.reasons.size });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.from - b.from);
}
