import type { MoveFrameSet, SheetRow } from './choreoSheet';

/**
 * 「めくり」表示（上 = 技のコマのパラパラ漫画、下 = 1 技 1 ページの解説を左右にめくる）の純粋な部分。
 * UI（components/FlipView.tsx）から切り離して、コマの時間割・ページ送り・index.json の読み取りを持つ。
 *
 * 時刻はすべて元動画の秒（メディア時刻）。パラパラ漫画は技の区間 [start, end) を速度（0.25 / 0.5 / 1 倍）で
 * 流す時計で動かし、コマは「その時刻に写っているコマ」を出す。各コマはその技の拍のうち自分の持ち分
 * （次のコマまでの時間）だけ出ている = カウントどおりの速さ。練習モードのクリックと同じ時計で鳴らせる。
 */

/** パラパラ漫画の 1 コマ。strip は v1（帯だけの古いジョブ）を n 等分した i 番目 */
export type FlipFrame = {
  url: string;
  t: number | null;
  count?: number;
  label?: string;
  /** 見どころのコマ（サーバーの flip[].key）。カード用の frames[] から来たコマも見どころ扱い */
  key?: boolean;
  /** 拍の間（「&」）のコマ（サーバーの flip[].half。count は直前の拍）。古い flip[]（1 拍 1 コマ）には無い */
  half?: boolean;
  /** 1/4・3/4 拍のコマ（half で label が空）。見出しは出さず直前の拍の字を保つ */
  quarter?: boolean;
  strip?: { n: number; i: number; tileW: number; gap: number };
};

/**
 * 技 1 つ分の写真の出どころ。
 * - flip: サーバーが作った密なコマ（半拍 1 コマ＋見どころ。古いジョブは 1 拍 1 コマ。index.json の flip[]）
 * - frames: 見どころの 5 コマ前後（v2 の frames[]）
 * - strip: v1 の帯だけ。読み込んで幅からコマ数が分かれば分割、分からなければ帯をそのまま出す
 */
export type FlipSource =
  | { kind: 'flip' | 'frames'; frames: FlipFrame[]; strip: string | null }
  | { kind: 'strip'; frames: []; strip: string };

/** パラパラ漫画は速く見えるので 0.25 倍が既定（ユーザーの要望） */
const SPEEDS = [0.25, 0.5, 1] as const;
export const DEFAULT_FLIP_SPEED: FlipSpeed = 0.25;
/** 拍の間のコマの字 */
export const AND_LABEL = '&';
export type FlipSpeed = (typeof SPEEDS)[number];
export const FLIP_SPEEDS: readonly FlipSpeed[] = SPEEDS;

/** 拍が分からないときの 1 拍（≈171 BPM。practice.ts の guessBeat の最後の手と同じ） */
export const FALLBACK_BEAT_SEC = 0.35;

// ─── index.json の読み取り ───────────────────────────────────────────────────

function parseShot(raw: unknown, resolve: (u: string) => string): FlipFrame | null {
  const f = raw as { t?: unknown; url?: unknown; count?: unknown; label?: unknown; key?: unknown; half?: unknown } | null;
  if (!f || typeof f.url !== 'string' || !f.url) return null;
  const out: FlipFrame = { url: resolve(f.url), t: typeof f.t === 'number' && Number.isFinite(f.t) ? f.t : null };
  if (typeof f.count === 'number' && f.count >= 1 && f.count <= 8) out.count = Math.round(f.count);
  if (typeof f.label === 'string' && f.label.trim()) out.label = f.label.trim();
  if (f.key === true) out.key = true;
  if (f.half === true) {
    out.half = true;
    if (out.label === AND_LABEL) delete out.label; // 「&」は字の方（frameCaption）で出す
    else if (!out.label) out.quarter = true; // 1/4・3/4 のコマ（label 無しの half）。見出しは直前の拍のまま
  }
  return out;
}

function parseShots(list: unknown, resolve: (u: string) => string, key: boolean): FlipFrame[] {
  if (!Array.isArray(list)) return [];
  const out: FlipFrame[] = [];
  for (const raw of list) {
    const s = parseShot(raw, resolve);
    if (!s) continue;
    if (key) s.key = true;
    out.push(s);
  }
  return out;
}

/**
 * サーバーの out/move_frames/index.json → 行 index ごとのコマ。
 * v2 の flip[]（あれば）> frames[] > v1 の帯（url）の順に使う。
 * routine が書き直されて画像が古い行（開始時刻が 0.05 秒より食い違う）は使わない（choreoSheet.parseMoveFrames と同じ）
 */
export function parseFlipIndex(
  json: unknown,
  rows: SheetRow[],
  resolve: (url: string) => string = u => u,
): Map<number, FlipSource> {
  const out = new Map<number, FlipSource>();
  const list = (json as { moves?: unknown } | null)?.moves;
  if (!Array.isArray(list)) return out;
  const byIndex = new Map(rows.map(r => [r.index, r]));
  for (const e of list as { index?: unknown; start?: unknown; url?: unknown; frames?: unknown; flip?: unknown }[]) {
    if (!e || typeof e.index !== 'number') continue;
    const row = byIndex.get(e.index);
    if (!row) continue;
    if (typeof e.start === 'number' && row.start !== null && Math.abs(e.start - row.start) > 0.05) continue;
    const strip = typeof e.url === 'string' && e.url ? resolve(e.url) : null;
    const flip = parseShots(e.flip, resolve, false);
    if (flip.length > 0) { out.set(e.index, { kind: 'flip', frames: flip, strip }); continue; }
    const frames = parseShots(e.frames, resolve, true);
    if (frames.length > 0) { out.set(e.index, { kind: 'frames', frames, strip }); continue; }
    if (strip) out.set(e.index, { kind: 'strip', frames: [], strip });
  }
  return out;
}

/** ReportModal がもう持っている写真（choreoSheet.parseMoveFrames の結果。flip[] は無い）から作る */
export function sourceFromFrameSet(set: MoveFrameSet | undefined): FlipSource | null {
  if (!set) return null;
  if (set.frames.length > 0) {
    return { kind: 'frames', frames: set.frames.map(f => ({ ...f, key: true })), strip: set.strip };
  }
  return set.strip ? { kind: 'strip', frames: [], strip: set.strip } : null;
}

/**
 * v1 の帯（サーバーの strip_of: 高さ h のコマを幅 4px の白い隙間で横に並べたもの）が何コマか。
 * コマは 2:3 の縦長（make_move_frames の CROP_ASPECT）。幅がコマの整数倍にならなければ null（帯をそのまま出す）
 */
export function stripTileCount(width: number, height: number, aspect = 2 / 3, gap = 4): number | null {
  if (!(width > 0 && height > 0)) return null;
  const tileW = height * aspect;
  const n = (width + gap) / (tileW + gap);
  const r = Math.round(n);
  if (r < 2 || r > 12 || Math.abs(n - r) > 0.06) return null;
  return r;
}

/** 帯を n コマに分けたコマ（時刻は無い。区間を等分して流す） */
export function splitStrip(url: string, width: number, height: number, aspect = 2 / 3, gap = 4): FlipFrame[] | null {
  const n = stripTileCount(width, height, aspect, gap);
  if (!n) return null;
  const tileW = (width - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ url, t: null, strip: { n, i, tileW, gap } }));
}

// ─── コマの時間割 ──────────────────────────────────────────────────────────

export type MoveWindow = { start: number; end: number };
export type FrameSpan = { start: number; end: number };

/** 技の 8 カウントの数（"1-8" → 8、"1-16" → 16） */
export function rowCounts(row: Pick<SheetRow, 'counts'>): number {
  const m = /(\d+)\s*$/.exec(row.counts);
  const n = m ? Number(m[1]) : 8;
  return n > 0 ? n : 8;
}

/** 技の区間（メディア時刻）。時刻の無い行は 0 からカウント数 × 拍 */
export function moveWindow(row: Pick<SheetRow, 'start' | 'end' | 'counts'>, beatSec: number | null): MoveWindow {
  const beat = beatSec && beatSec > 0 ? beatSec : FALLBACK_BEAT_SEC;
  const start = row.start ?? 0;
  const end = row.end !== null && row.end > start ? row.end : start + rowCounts(row) * beat;
  return { start, end };
}

/**
 * 各コマが出ている区間（メディア時刻）。コマは区間の頭から終わりまで隙間なく並ぶ:
 * - 時刻（t）があれば: そのコマの時刻から次のコマの時刻まで（最初のコマは区間の頭から・最後は終わりまで）
 * - 時刻が無くカウントがあれば: カウント c のコマは (c − 1) 拍目から
 * - どちらも無ければ（v1 の帯を分けたコマ）: 区間を等分
 * どの場合も、カウントの持ち分（拍）× 1 拍の長さ = 出ている時間。速度は時計の側で掛ける
 */
export function frameSpans(frames: FlipFrame[], win: MoveWindow, beatSec: number | null): FrameSpan[] {
  const n = frames.length;
  if (n === 0) return [];
  const len = Math.max(win.end - win.start, 1e-3);
  const beat = beatSec && beatSec > 0 ? beatSec : FALLBACK_BEAT_SEC;
  let starts: number[];
  if (frames.every(f => f.t !== null)) {
    starts = frames.map(f => f.t as number);
  } else if (frames.every(f => typeof f.count === 'number')) {
    starts = frames.map(f => win.start + ((f.count as number) - 1) * beat);
  } else {
    starts = frames.map((_, i) => win.start + (len * i) / n);
  }
  // 区間の中へ寄せ、前のコマより前には戻さない（順番は index.json の並び = 時刻順）
  const clamped: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.min(Math.max(starts[i], win.start), win.end);
    clamped.push(i === 0 ? win.start : Math.max(s, clamped[i - 1]));
  }
  return clamped.map((s, i) => ({ start: s, end: i + 1 < n ? clamped[i + 1] : win.end }));
}

/** メディア時刻 m に出ているコマの位置（区間の外は端のコマ） */
export function frameAt(spans: FrameSpan[], m: number): number {
  if (!spans.length) return -1;
  let idx = 0;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].start <= m + 1e-9 && spans[i].end > spans[i].start) idx = i;
    else if (spans[i].start > m) break;
  }
  return idx;
}

/** 各コマが画面に出ている時間（ミリ秒、壁時計）。speed 0.5 なら 2 倍の長さ */
export function frameDurationsMs(spans: FrameSpan[], speed: number): number[] {
  const s = speed > 0 ? speed : 1;
  return spans.map(sp => ((sp.end - sp.start) / s) * 1000);
}

/** 各コマの持ち分（拍） */
export function frameBeats(spans: FrameSpan[], beatSec: number | null): number[] {
  const beat = beatSec && beatSec > 0 ? beatSec : FALLBACK_BEAT_SEC;
  return spans.map(sp => (sp.end - sp.start) / beat);
}

/** 時計が区間の終わりを過ぎたら頭へ（パラパラ漫画は技を繰り返す） */
export function loopTime(m: number, win: MoveWindow): number {
  const len = win.end - win.start;
  if (!(len > 0)) return win.start;
  if (m < win.start) return win.start;
  if (m < win.end) return m;
  return win.start + ((m - win.start) % len);
}

/** コマのカウントの字: 拍の上は「2」、拍の間は「2&」（直前の拍が分からなければ「&」） */
export function frameCount(f: Pick<FlipFrame, 'count' | 'half' | 'quarter'>): string {
  if (f.half && !f.quarter) return `${f.count ?? ''}${AND_LABEL}`;
  return f.count ? String(f.count) : '';
}

/** 見出しに使うコマの位置。1/4・3/4 のコマ（quarter）は直前の拍・「&」のコマの見出しを保つ（ちらつかせない） */
export function captionIndex(frames: Pick<FlipFrame, 'quarter'>[], i: number): number {
  let k = Math.min(Math.max(i, 0), frames.length - 1);
  while (k > 0 && frames[k].quarter) k--;
  return k;
}

/**
 * コマの説明の字。最初のコマ（技の頭）は立ち位置（「男右・女左」）があればそれを出す
 * （サーバーの「スタート（女は左）」より、写真の左右そのままの方が分かりやすい）
 */
export function frameLabel(f: Pick<FlipFrame, 'label'>, i = -1, startPos: string | null = null): string {
  if (i === 0 && startPos) return startPos;
  return f.label ?? '';
}

/** コマの大きな字（「2 通過」「2&」）。カウントも説明も無ければ空 */
export function frameCaption(f: Pick<FlipFrame, 'count' | 'label' | 'half' | 'quarter'>, i = -1, startPos: string | null = null): string {
  return [frameCount(f), frameLabel(f, i, startPos)].filter(Boolean).join(' ');
}

// ─── ページ送り ────────────────────────────────────────────────────────────

export function clampPage(i: number, n: number): number {
  if (n <= 0) return 0;
  return Math.min(Math.max(Math.round(i), 0), n - 1);
}

/** 「3 / 58」 */
export function pageLabel(i: number, n: number): string {
  return n > 0 ? `${clampPage(i, n) + 1} / ${n}` : '0 / 0';
}

/** 横に払う量がこの割合（ページ幅）を超えたらめくる */
export const SWIPE_RATIO = 0.18;
/** 幅が測れない（0）ときのめくる距離（px） */
export const SWIPE_MIN_PX = 48;
/** これより速く払ったら（px/ms）短くてもめくる */
export const SWIPE_VELOCITY = 0.45;

/**
 * 指・マウスを離したときにどちらへめくるか。左へ払う（dx < 0）= 次（+1）、右へ = 前（−1）、足りなければ 0。
 * 端（最初・最後のページ）から外へは 0
 */
export function swipeStep(dx: number, width: number, ms: number, index: number, n: number): -1 | 0 | 1 {
  const dist = Math.abs(dx);
  const threshold = width > 0 ? Math.max(width * SWIPE_RATIO, 24) : SWIPE_MIN_PX;
  const fast = ms > 0 && dist / ms >= SWIPE_VELOCITY && dist >= 20;
  if (dist < threshold && !fast) return 0;
  const step = dx < 0 ? 1 : -1;
  const next = index + step;
  if (next < 0 || next >= n) return 0;
  return step;
}

/** 端で外へ引っ張ったときは手応えだけ（1/3 に弱める） */
export function dragOffset(dx: number, index: number, n: number): number {
  if ((index <= 0 && dx > 0) || (index >= n - 1 && dx < 0)) return dx / 3;
  return dx;
}

/** 矢印キー → ページの動き */
export function keyStep(key: string): -1 | 0 | 1 {
  if (key === 'ArrowRight' || key === 'PageDown') return 1;
  if (key === 'ArrowLeft' || key === 'PageUp') return -1;
  return 0;
}

/** 先読みする写真の URL（今の技と次の技。v1 の帯は 1 枚） */
export function preloadUrls(sources: Map<number, FlipSource>, rows: SheetRow[], page: number): string[] {
  const urls: string[] = [];
  for (const p of [page, page + 1]) {
    const row = rows[p];
    const src = row ? sources.get(row.index) : undefined;
    if (!src) continue;
    if (src.kind === 'strip') urls.push(src.strip);
    else src.frames.forEach(f => urls.push(f.url));
  }
  return [...new Set(urls)];
}

// ─── 表示の選び方（めくり / 一覧） ─────────────────────────────────────────

export type ReportView = 'flip' | 'list';
export const VIEW_STORAGE_KEY = 'motionlab.reportView';
/** 0.25 倍を既定にしたときに変えた（前の既定 0.5 で保存された値を引き継がない） */
export const SPEED_STORAGE_KEY = 'motionlab.flipSpeed2';
export const NARROW_PX = 600;

/** 保存された選び方。無ければ画面幅で（600px 以下 = めくり） */
export function loadReportView(width: number | null = typeof window !== 'undefined' ? window.innerWidth : null): ReportView {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === 'flip' || v === 'list') return v;
  } catch { /* プライベートモード等 */ }
  return width !== null && width <= NARROW_PX ? 'flip' : 'list';
}

export function saveReportView(v: ReportView): void {
  try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* noop */ }
}

export function loadFlipSpeed(): FlipSpeed {
  try {
    const v = Number(localStorage.getItem(SPEED_STORAGE_KEY));
    const hit = SPEEDS.find(s => s === v);
    if (hit !== undefined) return hit;
  } catch { /* noop */ }
  return DEFAULT_FLIP_SPEED;
}

export function saveFlipSpeed(v: FlipSpeed): void {
  try { localStorage.setItem(SPEED_STORAGE_KEY, String(v)); } catch { /* noop */ }
}
