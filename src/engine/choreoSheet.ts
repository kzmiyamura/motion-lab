import { MOVE_LABEL, type RoutineHold, type RoutineMove, type RoutineMoveId } from './routineClip';

/**
 * 解析結果（result.json の routine.moves）→「振付シート」の行。
 *
 * 動画を見なくてもペアが踊れるよう、1行 = 1技 で「技名・カウントごとに男女が何をするか・写真」を出す。
 * 記号（男右×女右・↺）は読めないので、手・回転・通る側も普通の言葉にする。長い文章は出さない
 * （詳細は report.md 側に残し、折りたたんで見せる）。
 * 行の index は routine.moves の位置そのまま（サーバーの move_frames/index.json の index と対応する）。
 * サーバー（normalize_routine.py）が技の頭を 8 カウントの格子に寄せ、steps を付けてある前提。
 */

/** カウントごとの男女の動き（例: 1-2-3 / 男「左手を上げる」/ 女「前へ」） */
export type SheetStep = { count: string; leader: string; follower: string };

export type SheetRow = {
  /** routine.moves の 0 始まりの位置 */
  index: number;
  /** 表示番号（1 始まり） */
  no: number;
  start: number | null;
  /** 技の終わり（次の技の頭。無ければ counts × 拍） */
  end: number | null;
  time: string;
  counts: string;
  name: string;
  steps: SheetStep[];
  /** 例: 右手同士（握手）でつなぐ / 左手同士 → 右手同士に持ち替え */
  hold: string | null;
  /** 例: 女が左回り1½回転 */
  turn: string | null;
  /** 同じ行で男も回ったときの短い 1 行（例: 男も: 左回り1回転）。無ければ null */
  leaderTurn: string | null;
  /** 例: 女が男の左側を通る */
  pass: string | null;
  /** 推定で埋めた・自信が低い行（「?」バッジを出す） */
  uncertain: boolean;
  /** 上から見た図（2人の立ち位置・女性の通り道・回る向き）。何も起きない技は null */
  diagram: MoveDiagramData | null;
};

export type ChoreoSheetData = {
  /** 見出し行の要素（On1 / BPM 96 / 男＝右スタート） */
  header: string[];
  rows: SheetRow[];
  /** 見出しの下に1回だけ出す凡例（右回り/左回り・インサイド/アウトサイドの基準） */
  legend: string;
  /** 1拍の秒数（動画をカウント付きで流すのに使う）。分からなければ null */
  beatSec: number | null;
};

const HOLD_WORD: Record<RoutineHold, string> = {
  LR: '男の左手と女の右手',
  RR: '右手同士（握手）',
  RL: '男の右手と女の左手',
  LL: '左手同士',
  double: '両手',
  cross: '両手をクロス',
  closed: 'クローズド（組む）',
  none: '手を離す',
};

const LOW_CONFIDENCE = 0.4;

/** 秒 → m:ss */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 回転数を ½ 刻みで（1.5 → 1½、0.5 → ½） */
export function fmtRotations(n: number): string {
  const half = Math.round(n * 2) / 2;
  const whole = Math.floor(half);
  const frac = half - whole >= 0.5 ? '½' : '';
  return whole === 0 ? (frac || '0') : `${whole}${frac}`;
}

/** 手のつなぎを普通の言葉で（変わるときは「A → B に持ち替え」） */
export function holdLabel(start?: RoutineHold | null, end?: RoutineHold | null): string | null {
  const a = start ? HOLD_WORD[start] ?? null : null;
  const b = end ? HOLD_WORD[end] ?? null : null;
  if (a && b && a !== b) return end === 'none' ? `${a} → 手を離す` : `${a} → ${b}に持ち替え`;
  const one = a ?? b;
  if (!one) return null;
  return one === HOLD_WORD.none ? one : `${one}でつなぐ`;
}

/**
 * 回る向きの決まり（見出しの凡例に出す。サーバーの normalize_routine.py・analyze_pair の spin と同じ）:
 * 右回り = 回る人自身の右へ = 真上から見て時計回り。
 * 女性のターンのインサイド/アウトサイドは向きだけで決まる（左回り = インサイド・右回り = アウトサイド。つなぎ手が
 * 変わっても同じ）。サルサの主流（Dance Dojo）の呼び方で、腕の通り道で呼ぶ流儀は少数派
 * （docs/salsa-knowledge/on2-timing-and-terms.md §3）。流派で揺れるので左回り/右回りを主に書き、名前は添えるだけ
 */
export const TURN_LEGEND = '回る向きは回る人自身から見て（右回り＝上から見て時計回り）。女性の左回り＝インサイド、右回り＝アウトサイド（つなぐ手に関係なく）';

type TurnLike = NonNullable<RoutineMove['turn']> & { kind?: 'inside' | 'outside' | null };
export type TurnKind = 'inside' | 'outside';

/**
 * 女性のターンのインサイド/アウトサイド。向きだけで決める（左回り＝インサイド・右回り＝アウトサイド）。
 * つなぐ手は見ない（以前のサーバーが女性の左手のとき逆にして付けた turn.kind も、向きがあれば向きで決め直す）。
 * 向きが分からなければサーバーの turn.kind、それも無ければ null。引数の手は呼び出し側の互換のため残す
 */
export function turnKind(turn: TurnLike | null | undefined, _holdStart?: RoutineHold | null, _holdEnd?: RoutineHold | null): TurnKind | null {
  if (!turn || (turn.by !== 'follower' && turn.by !== 'both')) return null;
  if (turn.direction === 'left') return 'inside';
  if (turn.direction === 'right') return 'outside';
  return turn.kind === 'inside' || turn.kind === 'outside' ? turn.kind : null;
}

const DIR_LONG = { right: '右回り（時計回り）', left: '左回り（反時計回り）' } as const;
const KIND_WORD: Record<TurnKind, string> = { inside: 'インサイドターン', outside: 'アウトサイドターン' };

/**
 * 回転を普通の言葉で。誰が回るかを必ず書き、回る向きを主に、女性はインサイド/アウトサイドを後ろに添える:
 * 「女: 左回り（反時計回り）1½回転・インサイドターン」「男: 右回り（時計回り）1回転」
 */
export function turnLabel(turn: TurnLike | null | undefined, holdStart?: RoutineHold | null, holdEnd?: RoutineHold | null): string | null {
  if (!turn) return null;
  const who = turn.by === 'leader' ? '男' : turn.by === 'both' ? '2人とも' : '女';
  const n = typeof turn.rotations === 'number' && turn.rotations > 0 ? `${fmtRotations(turn.rotations)}回転` : '回る';
  const d = turn.direction === 'left' || turn.direction === 'right' ? turn.direction : null;
  const kind = turnKind(turn, holdStart, holdEnd);
  return `${who}: ${d ? DIR_LONG[d] : ''}${n}${kind ? `・${KIND_WORD[kind]}` : ''}`;
}

const DIR_SHORT = { right: '右回り', left: '左回り' } as const;

/**
 * 同じ行で男も回ったとき（routine.moves[].leaderTurn）の短い 1 行: 「男も: 左回り1回転」。
 * 行の主のターン（turn）は女性のターンで、男のターンはこちらに添える
 */
export function leaderTurnLabel(lt: RoutineMove['leaderTurn']): string | null {
  if (!lt || typeof lt !== 'object') return null;
  const d = lt.direction === 'left' || lt.direction === 'right' ? DIR_SHORT[lt.direction] : '';
  const n = typeof lt.rotations === 'number' && lt.rotations > 0 ? `${fmtRotations(lt.rotations)}回転` : '回る';
  return `男も: ${d}${n}`;
}

const SIDE_WORD = { left: '左', right: '右' } as const;

/** 通る側（男の体から見て）と、画面の上での動き（「画面右→左」） */
export function passLabel(p: RoutineMove['passSide'], sides?: MoveSides | null): string | null {
  const from = sides?.followerStart, to = sides?.followerEnd;
  const screen = from && to && from !== to ? `（画面${SIDE_WORD[from]}→${SIDE_WORD[to]}）` : '';
  if (p === 'left') return `女が男の左側を通る${screen}`;
  if (p === 'right') return `女が男の右側を通る${screen}`;
  if (p === 'return') return '行って戻る';
  if (screen) return `女が反対側へ${screen}`;
  return null;
}

/** サーバー（normalize_routine.py）が tracks.json から付けた立ち位置: 女性が画面の左右どちらで始まり・終わるか */
export type MoveSides = { followerStart?: 'left' | 'right' | null; followerEnd?: 'left' | 'right' | null; swapAt?: number[] };

/** 上から見た図の材料 */
export type MoveDiagramData = {
  /** 女性の画面上の位置（始まり・終わり）。分からなければ null（図は女＝右で描く） */
  followerStart: 'left' | 'right' | null;
  followerEnd: 'left' | 'right' | null;
  pass: 'left' | 'right' | 'return' | null;
  turn: { by: 'leader' | 'follower' | 'both'; direction: 'left' | 'right' | null; rotations: number | null; kind: TurnKind | null } | null;
  /** つないでいる手（男の手が先: LR = 男左×女右）。片手のときだけ */
  hold: 'LR' | 'RR' | 'RL' | 'LL' | null;
  /** 図の下に出す説明（回転は turnLabel と同じ言い方） */
  caption: string;
};

function sideOf(v: unknown): 'left' | 'right' | null {
  return v === 'left' || v === 'right' ? v : null;
}

/** 行の図。パスも回転も立ち位置も無い技（ベーシック・シャイン等）は null */
export function diagramFor(m: RoutineMove & { sides?: MoveSides | null }): MoveDiagramData | null {
  const sides = m.sides ?? null;
  const fs = sideOf(sides?.followerStart), fe = sideOf(sides?.followerEnd);
  const t = m.turn as TurnLike | null | undefined;
  const pass = m.passSide === 'left' || m.passSide === 'right' || m.passSide === 'return' ? m.passSide : null;
  const swapped = !!fs && !!fe && fs !== fe;
  if (!t && !pass && !swapped) return null;
  const turn = t ? {
    by: t.by,
    direction: t.direction === 'left' || t.direction === 'right' ? t.direction : null,
    rotations: typeof t.rotations === 'number' && t.rotations > 0 ? t.rotations : null,
    kind: turnKind(t, m.holdStart, m.holdEnd),
  } : null;
  const oneHand = (h?: RoutineHold | null) => (h === 'LR' || h === 'RR' || h === 'RL' || h === 'LL' ? h : null);
  const parts = [passLabel(pass, sides), turnLabel(t, m.holdStart, m.holdEnd)].filter(Boolean);
  return {
    followerStart: fs, followerEnd: fe, pass, turn,
    hold: oneHand(m.holdStart) ?? oneHand(m.holdEnd),
    caption: parts.join(' ／ '),
  };
}

function isUncertain(m: RoutineMove, rawName: string): boolean {
  if (m.evidence === 'inferred' || m.confidence === 'doubtful') return true;
  if (typeof m.confidence === 'number' && m.confidence < LOW_CONFIDENCE) return true;
  return /[?？]$/.test(rawName);
}

function parseSteps(raw: unknown): SheetStep[] {
  if (!Array.isArray(raw)) return [];
  const out: SheetStep[] = [];
  for (const s of raw.slice(0, 2)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const step = { count: str(o.count), leader: str(o.leader), follower: str(o.follower) };
    if (step.count && (step.leader || step.follower)) out.push(step);
  }
  return out;
}

type ResultLike = {
  leader?: { side?: string | null } | null;
  style?: { onBeat?: string } | null;
  routine?: {
    timing?: string; bpm?: number | null; bpmSource?: string;
    grid?: { beatSec?: number } | null;
    moves?: unknown[];
  } | null;
  beatGrid?: { bpm?: number } | null;
};

/** result.json の文字列から振付シートを作る。routine.moves が無ければ null */
export function parseChoreoSheet(resultJson: string | null): ChoreoSheetData | null {
  if (!resultJson) return null;
  let d: ResultLike;
  try { d = JSON.parse(resultJson) as ResultLike; } catch { return null; }
  const moves = d?.routine?.moves;
  if (!Array.isArray(moves) || moves.length === 0) return null;

  const header: string[] = [];
  const timing = d.routine?.timing ?? d.style?.onBeat;
  // ユーザーの動画は基本 On2。On1 と決まったときだけ On1、無い・unclear は On2（サーバーの normalize と同じ既定）
  header.push(timing === 'on1' ? 'On1' : 'On2');
  const bpm = d.routine?.bpm ?? d.beatGrid?.bpm;
  const hasBpm = typeof bpm === 'number' && bpm > 0;
  if (hasBpm) header.push(d.routine?.bpmSource === 'routine' ? `テンポ≈${Math.round(bpm)}（推定）` : `BPM ${Math.round(bpm)}`);
  if (d.leader?.side === 'right') header.push('男＝右スタート');
  else if (d.leader?.side === 'left') header.push('男＝左スタート');

  const gridBeat = d.routine?.grid?.beatSec;
  const beatSec = typeof gridBeat === 'number' && gridBeat > 0 ? gridBeat : hasBpm ? 60 / bpm : null;

  const rows: SheetRow[] = [];
  moves.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as RoutineMove & { steps?: unknown; sides?: MoveSides | null };
    const rawName = (typeof m.name === 'string' && m.name.trim())
      || MOVE_LABEL[m.move as RoutineMoveId] || String(m.move ?? '技');
    const counts = typeof m.counts === 'number' && m.counts > 0 ? m.counts : 8;
    const start = typeof m.start === 'number' ? m.start : null;
    const next = moves.slice(index + 1).find(x => typeof (x as RoutineMove)?.start === 'number') as RoutineMove | undefined;
    let end: number | null = null;
    if (start !== null) {
      if (next?.start !== undefined && next.start > start) end = next.start;
      else if (beatSec) end = start + counts * beatSec;
    }
    rows.push({
      index,
      no: index + 1,
      start,
      end,
      time: start === null ? '' : fmtClock(start),
      counts: `1-${counts}`,
      name: rawName.replace(/\s*[?？]$/, ''),
      steps: parseSteps(m.steps),
      hold: holdLabel(m.holdStart, m.holdEnd),
      turn: turnLabel(m.turn, m.holdStart, m.holdEnd),
      leaderTurn: leaderTurnLabel(m.leaderTurn),
      pass: passLabel(m.passSide, m.sides),
      uncertain: isUncertain(m, rawName),
      diagram: diagramFor(m),
    });
  });
  return rows.length ? { header, rows, beatSec, legend: TURN_LEGEND } : null;
}

/** 技1つ分の写真。v2 は1コマずつ（frames）、v1（古いジョブ）は横に並べた帯（strip）だけ */
/** count = 技の頭から数えた拍（1〜8）、label = そのコマの説明（「通過」「右回り中」等）。古い index.json には無い */
export type MoveShot = { t: number | null; url: string; count?: number; label?: string };
export type MoveFrameSet = { strip: string | null; frames: MoveShot[] };

/**
 * サーバーの out/move_frames/index.json → 行 index ごとの写真。
 * v2: moves[].frames = [{t, url, count?, label?}]（主ペアを切り取った1コマずつ。見どころの瞬間とその拍・説明）＋ url（帯）。
 * v1: url（帯）だけ。
 * routine が書き直されて画像が古くなっている行（開始時刻が合わない）は使わない
 */
export function parseMoveFrames(json: unknown, rows: SheetRow[]): Map<number, MoveFrameSet> {
  const out = new Map<number, MoveFrameSet>();
  const list = (json as { moves?: unknown })?.moves;
  if (!Array.isArray(list)) return out;
  const byIndex = new Map(rows.map(r => [r.index, r]));
  for (const e of list as { index?: unknown; start?: unknown; url?: unknown; frames?: unknown }[]) {
    if (typeof e?.index !== 'number') continue;
    const row = byIndex.get(e.index);
    if (!row) continue;
    if (typeof e.start === 'number' && row.start !== null && Math.abs(e.start - row.start) > 0.05) continue;
    const frames: MoveShot[] = [];
    if (Array.isArray(e.frames)) {
      for (const f of e.frames as { t?: unknown; url?: unknown; count?: unknown; label?: unknown }[]) {
        if (typeof f?.url !== 'string') continue;
        const shot: MoveShot = { t: typeof f.t === 'number' ? f.t : null, url: f.url };
        if (typeof f.count === 'number' && f.count >= 1 && f.count <= 8) shot.count = f.count;
        if (typeof f.label === 'string' && f.label.trim()) shot.label = f.label.trim();
        frames.push(shot);
      }
    }
    const strip = typeof e.url === 'string' ? e.url : null;
    if (!strip && frames.length === 0) continue;
    out.set(e.index, { strip, frames });
  }
  return out;
}

/** 写真の URL を差し替える（サーバー相対パス → 絶対 URL） */
export function mapFrameUrls(set: MoveFrameSet, fn: (url: string) => string): MoveFrameSet {
  return { strip: set.strip ? fn(set.strip) : null, frames: set.frames.map(f => ({ ...f, url: fn(f.url) })) };
}

/** index.json がまだ作成途中か（サーバーは1枚できるごとに complete:false で書き直す。古い形式は完成扱い） */
export function moveFramesPending(json: unknown): boolean {
  return (json as { complete?: unknown })?.complete === false;
}

/** 動画の t 秒が、技の頭（カウント1）から数えて何カウント目か（1〜8） */
export function countAt(t: number, start: number, beatSec: number): number {
  const k = Math.floor((t - start) / beatSec + 1e-6);
  return ((k % 8) + 8) % 8 + 1;
}

/** 見出しの下に出すサマリの最大文字数（スマホで 2 行程度） */
export const SUMMARY_MAX_CHARS = 60;

/**
 * 新形式の report.md（「## 詳細（根拠）」を持つもの）の冒頭サマリを、短い1行にする。
 * 題の下・最初の ## の前の最初の段落から、文（。！？ で終わる。半角の ? は技名の「推定」印なので区切りにしない）を頭から SUMMARY_MAX_CHARS 字まで取る。
 * 文の途中では切らない。最初の文だけで長すぎるときは出さない（空配列）。
 * 以前は3行まで丸ごと出していて、長い段落が折り返して文の切れ端のように見えていた。
 * 旧形式のレポートは冒頭が長いので出さない
 */
export function reportSummary(md: string | null): string[] {
  if (!md || !/^##\s+詳細/m.test(md)) return [];
  let first = '';
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (/^##\s/.test(t)) break;
    if (!t || /^#\s/.test(t)) continue;
    first = t.replace(/^>\s*/, '');
    break;
  }
  if (!first) return [];
  const sentences = first.match(/[^。！？]+[。！？]+|[^。！？]+$/g) ?? [];
  let out = '';
  for (const s of sentences) {
    const next = out + s.trim();
    if (next.length > SUMMARY_MAX_CHARS) break;
    out = next;
  }
  return out ? [out] : [];
}
