/**
 * 全体解析（main）の後に「区間再解析で仕上げる」段の窓選び（純粋関数）。
 * main の結果で弱いカードだけを拾う（claude は呼ばない）。拾う印:
 *   - 自信が低い（confidence < minConfidence。既定 0.5）
 *   - 手が空（holdStart・holdEnd がどちらも無い）
 *   - holdUnclear（手が決められない区間）または hold の estimated（前後から補った）と重なる
 * 窓は「弱いカードの start から、その次の次のカードの start まで」（手は後ろの明瞭な区間で決めるので 1 枚先まで含める）。
 * 長さは maxWindow 秒まで。窓は連結しない（弱さの点＝理由の数＋自信の足りなさ が高い順に、重ならないものを最大 maxWindows 個）。正解は使わない。
 */
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

/** 仕上げ段で更新した区間の注記（report.md の本文は main のままなので、振付シートのカードと食い違うことを断る）。読めなければ空 */
export function segmentFinishNote(summaryPath: string): string {
  try {
    const s = JSON.parse(readFileSync(summaryPath, 'utf-8')) as { windows?: Array<{ from: number; to: number }> };
    const w = s.windows ?? [];
    if (!w.length) return '';
    const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    return `\n\n> 仕上げ段（区間再解析）で更新した区間: ${w.map(x => `${mmss(x.from)}〜${mmss(x.to)}`).join('、')}。` +
      '振付シートのカードはこの区間で更新済みで、上の本文（再現可能な記述）は更新前の main の内容のため、食い違うことがある。';
  } catch { return ''; }
}

export interface FinishWindow { from: number; to: number; cards: number[]; reasons: string[] }

export interface FinishInputs {
  result: Json | null | undefined;
  holdUnclear?: Array<{ from: number; to: number }> | null;
  /** tracks.holdTimeline（estimated を見る）。無くてもよい */
  holds?: Array<{ from: number; to: number; estimated?: unknown }> | null;
  /** 解析の頭（冒頭の静止画を除いた最初の秒。窓の from がこれより前にならない） */
  firstT?: number;
  minConfidence?: number;
  maxWindow?: number;
  maxWindows?: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function findWeakWindows(inp: FinishInputs): FinishWindow[] {
  const routine = (inp.result?.routine ?? {}) as Json;
  const moves = (Array.isArray(routine.moves) ? (routine.moves as Json[]) : [])
    .filter(m => Number.isFinite(Number(m.start)))
    .sort((a, b) => Number(a.start) - Number(b.start));
  if (!moves.length) return [];
  const minConf = inp.minConfidence ?? 0.5, maxWin = inp.maxWindow ?? 6, maxWins = inp.maxWindows ?? 6;
  const bpm = typeof routine.bpm === 'number' && routine.bpm > 0 ? routine.bpm : 120;
  const firstT = inp.firstT ?? 0;
  const spans = [
    ...(inp.holdUnclear ?? []).map(u => ({ from: u.from, to: u.to, why: 'holdUnclear と重なる' })),
    ...(inp.holds ?? []).filter(h => h.estimated).map(h => ({ from: h.from, to: h.to, why: 'hold が前後から補った値（estimated）と重なる' })),
  ];
  // カードごとの候補（弱さの点つき）。点が高い順に、重ならないものだけ maxWindows 個選び、最後に時刻順に並べる
  const cands: Array<FinishWindow & { score: number }> = [];
  moves.forEach((m, i) => {
    const s = Number(m.start);
    const endOwn = s + ((typeof m.counts === 'number' ? m.counts : 8) * 60) / bpm;
    const reasons: string[] = [];
    if (typeof m.confidence === 'number' && m.confidence < minConf) reasons.push(`自信が低い(${m.confidence})`);
    if (!m.holdStart && !m.holdEnd) reasons.push('手が空');
    for (const sp of spans) if (sp.from < endOwn && sp.to > s) { reasons.push(sp.why); break; }
    if (!reasons.length) return;
    const next2 = moves[i + 2] ? Number(moves[i + 2].start) : (moves[i + 1] ? Number(moves[i + 1].start) + (endOwn - s) : endOwn);
    const from = Math.max(firstT, r2(s)), to = r2(Math.min(next2, from + maxWin));
    if (to - from < 1) return;
    const conf = typeof m.confidence === 'number' ? m.confidence : 0.5;
    cands.push({ from, to, cards: [i], reasons: reasons.map(x => `カード${i + 1}: ${x}`), score: reasons.length + Math.max(0, minConf - conf) });
  });
  const picked: FinishWindow[] = [];
  for (const c of cands.sort((a, b) => b.score - a.score || a.from - b.from)) {
    if (picked.length >= maxWins) break;
    if (picked.some(p => c.from < p.to && c.to > p.from)) continue;
    picked.push({ from: c.from, to: c.to, cards: c.cards, reasons: c.reasons });
  }
  return picked.sort((a, b) => a.from - b.from);
}
