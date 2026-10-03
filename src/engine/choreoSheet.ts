import { MOVE_LABEL, type RoutineHold, type RoutineMove, type RoutineMoveId } from './routineClip';

/**
 * 解析結果（result.json の routine.moves）→「振付シート」の行。
 *
 * 動画を見なくてもペアが踊れるよう、1行 = 1技 で「いつ・何カウント・何の技・どの手・誰がどっちに何回転」
 * だけを短い記号で並べる。文章は出さない（詳細は report.md 側に残し、折りたたんで見せる）。
 * 行の index は routine.moves の位置そのまま（サーバーの move_frames/index.json の index と対応する）。
 */

export type SheetRow = {
  /** routine.moves の 0 始まりの位置 */
  index: number;
  /** 表示番号（1 始まり） */
  no: number;
  start: number | null;
  time: string;
  counts: string;
  name: string;
  /** 例: 男左×女右 / 男左×女右→男右×女右 */
  hold: string | null;
  /** 例: 女↺1½ */
  turn: string | null;
  /** 例: 左通過 */
  pass: string | null;
  /** 推定で埋めた・自信が低い行（「?」バッジを出す） */
  uncertain: boolean;
};

export type ChoreoSheetData = {
  /** 見出し行の要素（On1 / BPM 96 / 男＝右スタート） */
  header: string[];
  rows: SheetRow[];
};

const HOLD_LABEL: Record<RoutineHold, string> = {
  LR: '男左×女右',
  RR: '男右×女右',
  RL: '男右×女左',
  LL: '男左×女左',
  double: '両手',
  cross: '両手クロス',
  closed: 'クローズド',
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

export function holdLabel(start?: RoutineHold | null, end?: RoutineHold | null): string | null {
  const a = start ? HOLD_LABEL[start] ?? null : null;
  const b = end ? HOLD_LABEL[end] ?? null : null;
  if (a && b && a !== b) return `${a}→${b}`;
  return a ?? b;
}

export function turnLabel(turn: RoutineMove['turn']): string | null {
  if (!turn) return null;
  const who = turn.by === 'leader' ? '男' : turn.by === 'both' ? '男女' : '女';
  const n = typeof turn.rotations === 'number' && turn.rotations > 0 ? fmtRotations(turn.rotations) : '';
  if (turn.direction === 'left') return `${who}↺${n}`;
  if (turn.direction === 'right') return `${who}↻${n}`;
  return `${who}回転${n}`;
}

export function passLabel(p: RoutineMove['passSide']): string | null {
  if (p === 'left') return '左通過';
  if (p === 'right') return '右通過';
  if (p === 'return') return '行って戻る';
  return null;
}

function isUncertain(m: RoutineMove, rawName: string): boolean {
  if (m.evidence === 'inferred' || m.confidence === 'doubtful') return true;
  if (typeof m.confidence === 'number' && m.confidence < LOW_CONFIDENCE) return true;
  return /[?？]$/.test(rawName);
}

type ResultLike = {
  leader?: { side?: string | null } | null;
  style?: { onBeat?: string } | null;
  routine?: { timing?: string; bpm?: number | null; moves?: unknown[] } | null;
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
  if (typeof bpm === 'number' && bpm > 0) header.push(`BPM ${Math.round(bpm)}`);
  if (d.leader?.side === 'right') header.push('男＝右スタート');
  else if (d.leader?.side === 'left') header.push('男＝左スタート');

  const rows: SheetRow[] = [];
  moves.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as RoutineMove;
    const rawName = (typeof m.name === 'string' && m.name.trim())
      || MOVE_LABEL[m.move as RoutineMoveId] || String(m.move ?? '技');
    const counts = typeof m.counts === 'number' && m.counts > 0 ? m.counts : 8;
    const start = typeof m.start === 'number' ? m.start : null;
    rows.push({
      index,
      no: index + 1,
      start,
      time: start === null ? '' : fmtClock(start),
      counts: `1-${counts}`,
      name: rawName.replace(/\s*[?？]$/, ''),
      hold: holdLabel(m.holdStart, m.holdEnd),
      turn: turnLabel(m.turn),
      pass: passLabel(m.passSide),
      uncertain: isUncertain(m, rawName),
    });
  });
  return rows.length ? { header, rows } : null;
}

/**
 * サーバーの out/move_frames/index.json → 行 index ごとの画像パス。
 * routine が書き直されて画像が古くなっている行（開始時刻が合わない）は使わない
 */
export function parseMoveFrames(json: unknown, rows: SheetRow[]): Map<number, string> {
  const out = new Map<number, string>();
  const list = (json as { moves?: unknown })?.moves;
  if (!Array.isArray(list)) return out;
  const byIndex = new Map(rows.map(r => [r.index, r]));
  for (const e of list as { index?: unknown; start?: unknown; url?: unknown }[]) {
    if (typeof e?.index !== 'number' || typeof e.url !== 'string') continue;
    const row = byIndex.get(e.index);
    if (!row) continue;
    if (typeof e.start === 'number' && row.start !== null && Math.abs(e.start - row.start) > 0.05) continue;
    out.set(e.index, e.url);
  }
  return out;
}

/**
 * 新形式の report.md（「## 詳細（根拠）」を持つもの）の冒頭サマリ（題の下・最初の ## の前、3行まで）。
 * 旧形式のレポートは冒頭が長いので出さない
 */
export function reportSummary(md: string | null): string[] {
  if (!md || !/^##\s+詳細/m.test(md)) return [];
  const out: string[] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (/^##\s/.test(t)) break;
    if (!t || /^#\s/.test(t)) continue;
    out.push(t.replace(/^>\s*/, ''));
    if (out.length >= 3) break;
  }
  return out;
}
