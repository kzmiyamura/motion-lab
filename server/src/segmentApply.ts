/**
 * --apply の形式: 区間再解析の行（AI の答え）を、フロントの振付シート（src/engine/choreoSheet.ts・routineClip.ts の RoutineMove）が
 * そのまま読める routine.moves の形にして、result.json の該当カードを置き換える。
 *
 * フロントが読むカードの欄: move（技の種類）・name・start・counts・turn・leaderTurn・passSide・holdStart/holdEnd・
 * evidence・confidence・steps・sides。steps / sides は normalize_routine.py（tracks から計算）が付ける欄なので、
 * 置き換えたカードでは付けない（古い steps が新しい技と食い違うのを避ける。フロントは steps が無ければ空の欄で出す）。
 */
import { parseHands } from './segmentDigest.js';

type Json = Record<string, unknown>;

export const MOVE_IDS = [
  'basic', 'cbl', 'right_turn', 'left_turn', 'inside_turn', 'outside_turn', 'cbl_inside_turn', 'cbl_outside_turn',
  'reverse_cbl', 'leader_turn', 'copa', 'hand_change', 'wrap', 'hammerlock', 'shadow', 'dip', 'shine', 'other',
] as const;
export const HOLDS = ['LR', 'RR', 'RL', 'LL', 'double', 'cross', 'closed', 'none'] as const;

const isMove = (x: unknown): x is string => typeof x === 'string' && (MOVE_IDS as readonly string[]).includes(x);
const isHold = (x: unknown): x is string => typeof x === 'string' && (HOLDS as readonly string[]).includes(x);

/** 手の文字列（「男性右手×女性右手」等）→ RoutineHold。読めなければ null */
export function holdFromHands(text: string): string | null {
  if (/手を離/.test(text)) return 'none';
  const p = parseHands(text);
  if (p.man === 'both') return 'double';
  if (p.man && p.woman && p.woman !== 'both') return `${p.man}${p.woman}`;
  return null;
}

const turnOf = (t: unknown): Json | null => {
  if (!t || typeof t !== 'object') return null;
  const o = t as Json;
  if (o.by !== 'leader' && o.by !== 'follower' && o.by !== 'both') return null;
  const dir = o.direction === 'right' || o.direction === 'left' ? o.direction : null;
  const rot = typeof o.rotations === 'number' ? o.rotations : undefined;
  return { by: o.by, direction: dir, ...(rot !== undefined ? { rotations: rot } : {}) };
};

/** 1 行 → RoutineMove。ref = 置き換える今のカード（start・counts を引き継ぐ） */
export function rowToMove(row: Json, ref?: Json | null): Json {
  const rawStart = Number(row.start);
  const refStart = ref ? Number(ref.start) : NaN;
  const start = Number.isFinite(refStart) && (!Number.isFinite(rawStart) || Math.abs(rawStart - refStart) <= 1.0) ? refStart : Math.round(rawStart * 100) / 100;
  const hands = String(row.hands ?? '');
  const holdStart = isHold(row.holdStart) ? row.holdStart : holdFromHands(hands);
  const holdEnd = isHold(row.holdEnd) ? row.holdEnd : holdStart;
  const man = parseHands(hands).man;
  const move: Json = {
    move: isMove(row.move) ? row.move : 'other',
    name: String(row.name ?? ''),
    start,
    counts: ref && typeof ref.counts === 'number' ? ref.counts : 8,
    turn: turnOf(row.turn),
    passSide: row.passSide === 'left' || row.passSide === 'right' || row.passSide === 'return' ? row.passSide : null,
    holdStart: holdStart ?? null,
    holdEnd: holdEnd ?? null,
    evidence: 'seen',
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
    source: 'segment-reanalyze',
  };
  if (man === 'L' || man === 'R') move.leadHand = man;
  // 立ち位置（女性が画面の左右どちらで始まり・終わるか）は tracks からの計算値で、技の読み直しでは変わらないので引き継ぐ
  if (ref && ref.sides && typeof ref.sides === 'object') move.sides = ref.sides;
  if (typeof row.description === 'string' && row.description) move.note = row.description;
  return move;
}

/** result の routine.moves のうち start が [from,to) のカードを、rows から作ったカードで置き換えた result（元は変えない） */
export function applyRowsToResult(result: Json, from: number, to: number, rows: Json[]): Json {
  const routine = { ...((result.routine ?? {}) as Json) };
  const moves = Array.isArray(routine.moves) ? (routine.moves as Json[]) : [];
  const replaced = moves.filter(m => Number(m.start) >= from && Number(m.start) < to);
  const kept = moves.filter(m => !replaced.includes(m));
  const used = new Set<number>();
  const added: Json[] = [];
  for (const r of rows) {
    // いちばん近い今のカードに 1 対 1 で対応させる（同じカードに 2 行は付けない）
    const free = replaced.filter(c => !used.has(Number(c.start)));
    const ref = free.sort((a, b) => Math.abs(Number(a.start) - Number(r.start)) - Math.abs(Number(b.start) - Number(r.start)))[0] ?? null;
    if (ref) used.add(Number(ref.start));
    added.push(rowToMove(r, ref));
  }
  routine.moves = [...kept, ...added].sort((a, b) => Number(a.start) - Number(b.start));
  return { ...result, routine };
}
