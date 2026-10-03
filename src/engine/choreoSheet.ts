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
  /** 例: 女が男の左側を通る */
  pass: string | null;
  /** 推定で埋めた・自信が低い行（「?」バッジを出す） */
  uncertain: boolean;
};

export type ChoreoSheetData = {
  /** 見出し行の要素（On1 / BPM 96 / 男＝右スタート） */
  header: string[];
  rows: SheetRow[];
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

export function turnLabel(turn: RoutineMove['turn']): string | null {
  if (!turn) return null;
  const who = turn.by === 'leader' ? '男が' : turn.by === 'both' ? '2人とも' : '女が';
  const n = typeof turn.rotations === 'number' && turn.rotations > 0 ? `${fmtRotations(turn.rotations)}回転` : '回る';
  const dir = turn.direction === 'left' ? '左回り' : turn.direction === 'right' ? '右回り' : '';
  return `${who}${dir}${n}`;
}

export function passLabel(p: RoutineMove['passSide']): string | null {
  if (p === 'left') return '女が男の左側を通る';
  if (p === 'right') return '女が男の右側を通る';
  if (p === 'return') return '行って戻る';
  return null;
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
  if (timing === 'on1') header.push('On1');
  else if (timing === 'on2') header.push('On2');
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
    const m = raw as RoutineMove & { steps?: unknown };
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
      turn: turnLabel(m.turn),
      pass: passLabel(m.passSide),
      uncertain: isUncertain(m, rawName),
    });
  });
  return rows.length ? { header, rows, beatSec } : null;
}

/** 技1つ分の写真。v2 は1コマずつ（frames）、v1（古いジョブ）は横に並べた帯（strip）だけ */
export type MoveShot = { t: number | null; url: string };
export type MoveFrameSet = { strip: string | null; frames: MoveShot[] };

/**
 * サーバーの out/move_frames/index.json → 行 index ごとの写真。
 * v2: moves[].frames = [{t, url}]（主ペアを切り取った1コマずつ）＋ url（帯）。v1: url（帯）だけ。
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
      for (const f of e.frames as { t?: unknown; url?: unknown }[]) {
        if (typeof f?.url === 'string') frames.push({ t: typeof f.t === 'number' ? f.t : null, url: f.url });
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
