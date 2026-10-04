import type { RoutineHold, RoutineMove } from './routineClip';

/**
 * 振付シートのカードごとの「始まりの状態 → 終わりの状態」（docs/salsa-knowledge/video-analysis-cues.md P4・
 * README「次にやること」7）。動画を見ずに踊れるよう、各 8 カウントの頭と終わりで
 *   - 女性が男から見てどこにいるか（正面 / 男の左 / 男の右 / 後ろ）
 *   - 2 人の向き（時計の文字盤。12 時 = ルーティンの頭で男が向いていた向き。女性は 6 時 = 男の方を向く）
 *   - つないでいる手（男左手×女右手 等）
 *   - スロットの端（技の始まりと同じ端か、反対の端か）
 * を出し、各部品（通過・回る向き・回転数・手）が見えたものか推定かを付ける。
 *
 * 状態は技の欄から作り、前の技の終わりを次の技の始まりにつないでいく。データが無い所は前から引き継いで「推定」にする。
 * 前の終わりと次の始まり（次の技の欄で見えたもの）が食い違えば warnings に入れる（カードの間の ⚠）。
 *
 * 向きの決まり（choreoSheet.ts の TURN_LEGEND と同じ）: 右回り = 上から見て時計回り = 時計の数字が増える向き。
 * CBL 系の回転数は通過の½を含む（CBL ½、CBL＋ターン 1½。on2-timing-and-terms.md §5）。
 * 通過があれば男は 180° 向きを変える（スロットの反対の端を向く）。
 */

export type Prov = 'seen' | 'inferred';
export type RelPos = 'front' | 'left' | 'right' | 'behind';

export type PairState = {
  /** 女性の位置（男の向きから見て）。分からなければ null */
  position: RelPos | null;
  /** 向き（度。0 = 12 時、時計回りに増える）。分からなければ null */
  leaderFacing: number | null;
  followerFacing: number | null;
  hold: RoutineHold | null;
  /** 手が見えたか推定か（手が分からなければ null） */
  holdProv: Prov | null;
};

export type PartKind = 'pass' | 'dir' | 'rot';
export type PartChip = { part: PartKind; label: string; prov: Prov };

export type ContinuityKind = 'hold' | 'side' | 'facing';
export type ContinuityWarning = { kind: ContinuityKind; label: string; detail: string };

export type CardState = {
  start: PairState;
  end: PairState;
  /** 女性が技の始まりと同じ端で終わるか、反対の端か（分からなければ null） */
  slotEnd: 'same' | 'opposite' | null;
  slotProv: Prov | null;
  /** 通過・回る向き・回転数・手の「見えた / 推定」 */
  parts: PartChip[];
  /** 前のカードの終わりとこのカードの始まりの食い違い */
  warnings: ContinuityWarning[];
};

type Side = 'left' | 'right';
type Dir = 'left' | 'right';
type TurnIn = {
  by?: string; direction?: string | null; rotations?: number | null;
  directionSource?: string; dirSource?: string; rotationSource?: string;
};
type LeaderTurnIn = { direction?: string | null; rotations?: number | null; dirSource?: string; rotationSource?: string; source?: string };

/** result.json の routine.moves[] の 1 行（使う欄だけ。どれも無いことがある） */
export type MoveIn = Omit<RoutineMove, 'turn'> & {
  turn?: TurnIn | null;
  sides?: { followerStart?: string | null; followerEnd?: string | null; swapAt?: number[] } | null;
  inferredHold?: RoutineHold | null;
  holdSource?: string;
  stepsSource?: string;
  passCheck?: string;
  rotationCheck?: string;
  directionCheck?: string;
  leaderTurn?: LeaderTurnIn | null;
};

const CBL_MOVES = new Set(['cbl', 'cbl_inside_turn', 'cbl_outside_turn', 'reverse_cbl']);
/** 向かい合って（女性が正面で）始まる技。前の終わりがそうなっていなければ ⚠ */
const OPEN_MOVES = new Set([
  'basic', 'cbl', 'cbl_inside_turn', 'cbl_outside_turn', 'reverse_cbl',
  'right_turn', 'left_turn', 'inside_turn', 'outside_turn', 'copa', 'hand_change', 'leader_turn', 'dip',
]);
/** 前の状態がどうであれ、終わった後は分からない（次で黙って向かい合いに戻す）技 */
const RESET_AFTER = new Set(['shine', 'other']);
const ONE_HAND = new Set<RoutineHold>(['LR', 'RR', 'RL', 'LL']);
const HOLDS = new Set<RoutineHold>(['LR', 'RR', 'RL', 'LL', 'double', 'cross', 'closed', 'none']);
/** これ未満の自信（数値）・doubtful の行は、部品を全部「推定」にする */
export const VERY_LOW_CONFIDENCE = 0.3;

export const HOLD_SHORT: Record<RoutineHold, string> = {
  LR: '男左手×女右手',
  RR: '男右手×女右手',
  RL: '男右手×女左手',
  LL: '男左手×女左手',
  double: '両手',
  cross: '両手クロス',
  closed: 'クローズド',
  none: '手を離す',
};

export const POSITION_WORD: Record<RelPos, string> = {
  front: '正面',
  left: '男の左',
  right: '男の右',
  behind: '男の後ろ',
};

const norm = (a: number) => ((a % 360) + 360) % 360;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const side = (v: unknown): Side | null => (v === 'left' || v === 'right' ? v : null);
const dir = (v: unknown): Dir | null => (v === 'left' || v === 'right' ? v : null);
const hold = (v: unknown): RoutineHold | null => (typeof v === 'string' && HOLDS.has(v as RoutineHold) ? v as RoutineHold : null);

/** 度 → 時計の時（0 → 12、90 → 3）。null はそのまま */
export function clockHour(deg: number | null): number | null {
  if (deg === null) return null;
  const h = Math.round(norm(deg) / 30) % 12;
  return h === 0 ? 12 : h;
}

/** 女性の位置（男の向きから測った角度）→ 正面/右/後ろ/左 */
export function positionOf(bearing: number | null): RelPos | null {
  if (bearing === null) return null;
  const q = Math.round(norm(bearing) / 90) % 4;
  return (['front', 'right', 'behind', 'left'] as const)[q];
}

function veryLow(m: MoveIn): boolean {
  return m.confidence === 'doubtful' || (num(m.confidence) && m.confidence < VERY_LOW_CONFIDENCE);
}

/** 欄そのものが「見えた」と言える行か（evidence が inferred・自信がごく低い行は全部推定） */
function seenRow(m: MoveIn): boolean {
  return m.evidence !== 'inferred' && !veryLow(m);
}

function fmtRot(n: number): string {
  const half = Math.round(n * 2) / 2;
  const whole = Math.floor(half);
  const frac = half - whole >= 0.5 ? '½' : '';
  return whole === 0 ? (frac || '0') : `${whole}${frac}`;
}

/** 回転 → 向きの変化（度）。向きが分からず½の倍数でもなければ null */
function turnDelta(rotations: number, d: Dir | null): number | null {
  if (d) return rotations * 360 * (d === 'left' ? -1 : 1);
  return Number.isInteger(rotations * 2) ? rotations * 360 : null;
}

type PassInfo = {
  /** 女性がスロットの反対の端へ抜けたか（分からなければ null） */
  passed: boolean | null;
  /** passed を CV の立ち位置（tracks）で確かめたか */
  fromTracks: boolean;
  /** 通過の部品を出すか */
  hasPass: boolean;
};

function passInfo(m: MoveIn): PassInfo {
  const fs = side(m.sides?.followerStart), fe = side(m.sides?.followerEnd);
  const ps = m.passSide;
  const typed = CBL_MOVES.has(m.move);
  const hasPass = ps === 'left' || ps === 'right' || ps === 'return' || typed || (!!fs && !!fe && fs !== fe);
  if (fs && fe) return { passed: fs !== fe, fromTracks: true, hasPass };
  if (ps === 'left' || ps === 'right') return { passed: true, fromTracks: false, hasPass };
  if (ps === 'return') return { passed: false, fromTracks: false, hasPass };
  if (typed) return { passed: true, fromTracks: false, hasPass };
  return { passed: false, fromTracks: false, hasPass };
}

/**
 * 各部品の「見えた / 推定」。決まり:
 * - 行全体: evidence = inferred、自信が VERY_LOW_CONFIDENCE 未満・doubtful → 全部推定
 * - 通過: passCheck（技の種類と CV の立ち位置の食い違いを直した印）があれば推定。通る側（passSide）が無く、
 *   立ち位置の入れ替わりからだけ分かる・技の種類からだけ分かるときも推定
 * - 回る向き: CV が Claude の向きを直した（turn.directionSource = cv・directionCheck）、turn judge の自信不足（dirSource が ? 付き）、
 *   向きが無い → 推定
 * - 回転数: 目安・拍の上限に寄せた（turn.rotationSource・rotationCheck）→ 推定
 * - 手: holdStart/holdEnd が無く inferredHold（holdSource = inferred）や前の技からの引き継ぎで埋めた → 推定
 * 技名の「?」はこれらの直しのどれかで付くので、部品ごとには見ない（名前の ? バッジで出ている）
 */
export function partChips(m: MoveIn): PartChip[] {
  const out: PartChip[] = [];
  const rowSeen = seenRow(m);
  const p = passInfo(m);
  if (p.hasPass) {
    const ps = m.passSide;
    const label = ps === 'left' ? '男の左を通る' : ps === 'right' ? '男の右を通る' : ps === 'return' ? '行って戻る' : '反対側へ';
    const named = ps === 'left' || ps === 'right' || ps === 'return';
    out.push({ part: 'pass', label, prov: rowSeen && named && !m.passCheck ? 'seen' : 'inferred' });
  }
  const t = m.turn;
  if (t && typeof t === 'object') {
    const who = t.by === 'leader' ? '男 ' : t.by === 'both' ? '2人 ' : '';
    const d = dir(t.direction);
    const dsrc = t.dirSource ?? t.directionSource ?? '';
    const dirInferred = !d || !rowSeen || dsrc === 'cv' || /\?$/.test(dsrc) || !!m.directionCheck;
    out.push({ part: 'dir', label: `${who}${d === 'left' ? '左回り' : d === 'right' ? '右回り' : '向き?'}`, prov: dirInferred ? 'inferred' : 'seen' });
    if (num(t.rotations) && t.rotations > 0) {
      const rotInferred = !rowSeen || !!t.rotationSource || !!m.rotationCheck || dsrc === 'cv' || !!m.directionCheck;
      out.push({ part: 'rot', label: `${fmtRot(t.rotations)}回転`, prov: rotInferred ? 'inferred' : 'seen' });
    }
  }
  const lt = m.leaderTurn;
  if (lt && typeof lt === 'object' && !(t && t.by === 'leader')) {
    const d = dir(lt.direction);
    const src = lt.dirSource ?? lt.source ?? '';
    const n = num(lt.rotations) && lt.rotations > 0 ? `${fmtRot(lt.rotations)}` : '';
    out.push({
      part: 'dir',
      label: `男 ${d === 'left' ? '左回り' : d === 'right' ? '右回り' : '回る'}${n}`,
      prov: !d || !rowSeen || /\?$/.test(src) || !!lt.rotationSource ? 'inferred' : 'seen',
    });
  }
  return out;
}

type Chain = { leader: number | null; follower: number | null; bearing: number | null; hold: RoutineHold | null; holdProv: Prov | null };

const INITIAL: Chain = { leader: 0, follower: 180, bearing: 0, hold: null, holdProv: null };

function snapshot(c: Chain): PairState {
  return {
    position: positionOf(c.bearing),
    leaderFacing: c.leader === null ? null : norm(c.leader),
    followerFacing: c.follower === null ? null : norm(c.follower),
    hold: c.hold,
    holdProv: c.hold ? c.holdProv : null,
  };
}

const faceToFace = (c: Chain) => c.leader !== null && c.follower !== null && norm(c.follower - c.leader) === 180 && c.bearing !== null && norm(c.bearing) === 0;

const add = (a: number | null, d: number | null) => (a === null || d === null ? null : a + d);

/**
 * routine.moves → 行 index ごとのカードの状態（オブジェクトでない行は null）。
 * 1 行目の始まりは「向かい合って女性が正面、男 12 時・女 6 時」。以降は前の行の終わりから始める
 */
export function buildCardStates(moves: unknown[]): (CardState | null)[] {
  const out: (CardState | null)[] = [];
  let chain: Chain = { ...INITIAL };
  let prev: MoveIn | null = null;
  for (const raw of moves) {
    if (!raw || typeof raw !== 'object') { out.push(null); continue; }
    const m = raw as MoveIn;
    const warnings: ContinuityWarning[] = [];
    const rowSeen = seenRow(m);
    const c: Chain = { ...chain };

    // --- 始まり: 前の終わりを引き継ぎ、この行で見えたもので上書き（食い違いは ⚠）
    if (prev && RESET_AFTER.has(prev.move)) {
      // シャイン等の後は向き・位置が分からないので、向かい合う技なら黙って向かい合いに戻す
      if (OPEN_MOVES.has(m.move) && c.leader !== null) { c.follower = c.leader + 180; c.bearing = 0; }
    } else if (OPEN_MOVES.has(m.move)) {
      if (c.leader === null) c.leader = 0;
      if (prev && !faceToFace(c) && c.follower !== null && c.bearing !== null) {
        warnings.push({
          kind: 'facing', label: '向きが合わない',
          detail: `前の終わり: 女は${POSITION_WORD[positionOf(c.bearing)!]}・男${clockHour(c.leader)}時 女${clockHour(c.follower)}時 → この技は向かい合って始まる`,
        });
      }
      c.follower = c.leader + 180;
      c.bearing = 0;
    }

    const hs = hold(m.holdStart), he = hold(m.holdEnd), hi = hold(m.inferredHold);
    if (hs) {
      const prevEnd = prev ? hold(prev.holdEnd) : null;
      // 手の ⚠ は前の終わりもこの始まりも「見えた」ときだけ（推定の行どうしの食い違いは書き方の揺れが多く、⚠ が出過ぎる）
      if (prevEnd && rowSeen && prev && seenRow(prev) && ONE_HAND.has(prevEnd) && ONE_HAND.has(hs) && prevEnd !== hs
        && m.move !== 'hand_change' && prev?.move !== 'hand_change') {
        warnings.push({ kind: 'hold', label: '手が合わない', detail: `前の終わり ${HOLD_SHORT[prevEnd]} → ${HOLD_SHORT[hs]}（持ち替えが無い）` });
      }
      c.hold = hs;
      c.holdProv = rowSeen ? 'seen' : 'inferred';
    } else if (hi) {
      c.hold = hi;
      c.holdProv = 'inferred';
    } else if (c.hold) {
      c.holdProv = 'inferred';
    }

    const pe = prev ? side(prev.sides?.followerEnd) : null, ns = side(m.sides?.followerStart);
    if (pe && ns && pe !== ns) {
      warnings.push({ kind: 'side', label: '立ち位置が飛ぶ', detail: `前の終わり 女は画面${pe === 'left' ? '左' : '右'} → 始まり 画面${ns === 'left' ? '左' : '右'}` });
    }
    const start = snapshot(c);

    // --- 技の中: 通過・回転で向きと位置を動かす
    const p = passInfo(m);
    const t = m.turn && typeof m.turn === 'object' ? m.turn : null;
    const tDir = dir(t?.direction);
    const tRot = t && num(t.rotations) && t.rotations > 0 ? t.rotations : null;
    const followerTurns = !!t && (t.by === 'follower' || t.by === 'both' || !t.by);
    const leaderTurns = !!t && (t.by === 'leader' || t.by === 'both');

    let leaderSpin = 0 as number | null;
    if (leaderTurns) leaderSpin = turnDelta(tRot ?? 1, tDir);
    const lt = m.leaderTurn && typeof m.leaderTurn === 'object' && !(t && t.by === 'leader') ? m.leaderTurn : null;
    if (lt) leaderSpin = add(leaderSpin, turnDelta(num(lt.rotations) && lt.rotations > 0 ? lt.rotations : 1, dir(lt.direction)));

    if (p.passed === null) {
      c.leader = null; c.follower = null; c.bearing = null;
    } else {
      // 女性: ターンがあればその回転（CBL 系は通過の½込み）、無くて通過すれば½
      const fTurn = followerTurns ? turnDelta(tRot ?? (p.passed ? 0.5 : 1), tDir) : (p.passed ? 180 : 0);
      c.follower = add(c.follower, fTurn);
      // 男: 通過で反対の端を向き（180°）、自分のターンの分も回る。女性は男の回った分だけ相対位置がずれる
      c.leader = add(add(c.leader, p.passed ? 180 : 0), leaderSpin);
      c.bearing = add(c.bearing, leaderSpin === null ? null : -leaderSpin);
    }
    if (m.move === 'wrap') { c.bearing = 90; c.follower = c.leader; }
    else if (m.move === 'shadow') { c.bearing = 0; c.follower = c.leader; }
    else if (m.move === 'hammerlock') { c.follower = null; }

    if (he) { c.hold = he; c.holdProv = rowSeen ? 'seen' : 'inferred'; }
    else if (hs) { c.holdProv = 'inferred'; }
    else if (c.hold) { c.holdProv = 'inferred'; }
    const end = snapshot(c);

    const parts = partChips(m);
    out.push({
      start, end,
      slotEnd: p.passed === null ? null : p.passed ? 'opposite' : 'same',
      slotProv: p.passed === null ? null : p.fromTracks || (rowSeen && p.hasPass && !m.passCheck && m.passSide) ? 'seen' : 'inferred',
      parts,
      warnings,
    });
    chain = c;
    prev = m;
  }
  return out;
}

/** result.json の文字列 → カードの状態（行 index = routine.moves の位置）。routine.moves が無ければ null */
export function parseSheetStates(resultJson: string | null): (CardState | null)[] | null {
  if (!resultJson) return null;
  try {
    const moves = (JSON.parse(resultJson) as { routine?: { moves?: unknown } })?.routine?.moves;
    return Array.isArray(moves) && moves.length ? buildCardStates(moves) : null;
  } catch {
    return null;
  }
}
