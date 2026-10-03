import type { SheetRow } from './choreoSheet';

/**
 * 練習モードの時間計算（UI・音から切り離した純粋な部分）。
 *
 * 時刻はすべて「元動画の秒」（メディア時刻）で持つ。再生速度は「壁時計の 1 秒で何メディア秒進むか」で、
 * カウントはメディア時刻だけで決まる（速度を変えてもカウント表示はずれない）。
 * 音（クリック）の予定時刻だけが速度で伸び縮みする: 壁時計の遅れ = (拍の時刻 − 今) / 速度。
 *
 * カウントの基準（カウント 1）は技の頭。サーバー（normalize_routine.py）が技の頭を 8 カウントの格子に
 * 寄せてあり、テンポがゆっくり変わる（drift）動画でも技ごとに頭から数え直せばずれが溜まらない。
 * 技の外（最初の技の前・最後の技の後）は近い技の頭から同じ拍の長さで延ばす。技が 1 つも無いときだけ
 * 格子の位相（grid.phaseSec）を使う。
 */

export const SPEEDS = [0.5, 0.75, 1] as const;
export type Speed = (typeof SPEEDS)[number];

export type Timing = 'on1' | 'on2';

/** 練習に使う技 1 つ分（時刻のある行だけ） */
export type Seg = { index: number; no: number; name: string; start: number; end: number };

export type Timeline = {
  beatSec: number;
  /** 8 カウントの頭の位相（秒）。技が無いときのカウントの基準 */
  phaseSec: number;
  timing: Timing;
  /** start の昇順 */
  segs: Seg[];
};

/** カウントの強さ。On2 は 2 と 6 を強く（On1 は 1 と 5）、フレーズの頭 1 を中くらい、4 と 8（休み）はごく小さく */
export type Accent = 'strong' | 'head' | 'weak' | 'ghost';

export function accentOf(count: number, timing: Timing): Accent {
  const strong = timing === 'on2' ? [2, 6] : [1, 5];
  if (strong.includes(count)) return 'strong';
  if (count === 1) return 'head';
  if (count === 4 || count === 8) return 'ghost';
  return 'weak';
}

/** 声で数えるカウント（サルサの数え方: 1, 2, 3 … 5, 6, 7。4 と 8 は休み） */
export function isSpokenCount(count: number): boolean {
  return count !== 4 && count !== 8;
}

const EPS = 1e-6;

/** result.json の routine.grid（beatSec / phaseSec）と timing を取り出す。無ければ null の欄 */
export function gridFromResultJson(json: string | null): { beatSec: number | null; phaseSec: number | null; timing: Timing } {
  let d: { routine?: { timing?: string; grid?: { beatSec?: unknown; phaseSec?: unknown } | null } | null; style?: { onBeat?: string } | null } | null = null;
  try { d = json ? JSON.parse(json) : null; } catch { d = null; }
  const g = d?.routine?.grid;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const beat = num(g?.beatSec);
  const timing = (d?.routine?.timing ?? d?.style?.onBeat) === 'on1' ? 'on1' : 'on2';
  return { beatSec: beat !== null && beat > 0 ? beat : null, phaseSec: num(g?.phaseSec), timing };
}

/** 拍が分からないとき: 技の頭の間隔（8 カウント）の中央値から。それも無ければ 0.35 秒（≈171 BPM） */
function guessBeat(rows: SheetRow[]): number {
  const starts = rows.map(r => r.start).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const g = (starts[i] - starts[i - 1]) / 8;
    if (g > 0.2 && g < 0.6) gaps.push(g);
  }
  if (!gaps.length) return 0.35;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 振付シートの行 → 練習のタイムライン。時刻のある行が 1 つも無ければ null */
export function buildTimeline(
  rows: SheetRow[],
  beatSec: number | null,
  opts: { phaseSec?: number | null; timing?: Timing } = {},
): Timeline | null {
  const beat = beatSec && beatSec > 0 ? beatSec : guessBeat(rows);
  const segs: Seg[] = rows
    .filter(r => r.start !== null)
    .map(r => {
      const start = r.start as number;
      const end = r.end !== null && r.end > start ? r.end : start + 8 * beat;
      return { index: r.index, no: r.no, name: r.name, start, end };
    })
    .sort((a, b) => a.start - b.start);
  if (!segs.length) return null;
  return { beatSec: beat, phaseSec: opts.phaseSec ?? segs[0].start, timing: opts.timing ?? 'on2', segs };
}

/** t 秒のカウントを数える基準（技の頭）。t 以前で最後に始まった技、無ければ最初の技 */
function anchorAt(tl: Timeline, t: number): number {
  if (!tl.segs.length) return tl.phaseSec;
  let a = tl.segs[0].start;
  for (const s of tl.segs) {
    if (s.start <= t + EPS) a = s.start;
    else break;
  }
  return a;
}

function wrap8(k: number): number {
  return ((k % 8) + 8) % 8 + 1;
}

/** メディア時刻 t が何カウント目か（1〜8）。速度には依らない */
export function countAtTime(tl: Timeline, t: number): number {
  const a = anchorAt(tl, t);
  return wrap8(Math.floor((t - a) / tl.beatSec + EPS));
}

export type Beat = { t: number; count: number };

/**
 * [from, to) にある拍（メディア時刻とカウント）。
 * 技 i の拍は頭から beatSec ごと、次の技の頭の半拍手前まで（頭が格子から少しずれていても 2 回鳴らない）。
 * 最初の技の前は頭から逆向きに（カウントイン 5, 6, 7, 8）、最後の技の後はそのまま延ばす
 */
export function beatsInRange(tl: Timeline, from: number, to: number): Beat[] {
  const out: Beat[] = [];
  if (!(to > from)) return out;
  const b = tl.beatSec;
  const anchors = tl.segs.length ? tl.segs.map(s => s.start) : [tl.phaseSec];
  // 最初の技の前
  const first = anchors[0];
  if (from < first) {
    const kLo = Math.ceil((from - first) / b - EPS);
    for (let k = kLo; k < 0; k++) {
      const t = first + k * b;
      if (t >= to) break;
      if (t >= from - EPS) out.push({ t, count: wrap8(k) });
    }
  }
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const limit = i + 1 < anchors.length ? anchors[i + 1] - b / 2 : Infinity;
    const lo = Math.max(from, a);
    const hi = Math.min(to, limit);
    if (hi <= lo) continue;
    for (let k = Math.max(0, Math.ceil((lo - a) / b - EPS)); ; k++) {
      const t = a + k * b;
      if (t >= hi) break;
      out.push({ t, count: wrap8(k) });
    }
  }
  return out;
}

/** t 秒に流れている技の segs 上の位置（技と技の間・前後は -1） */
export function segIndexAt(tl: Timeline, t: number): number {
  for (let i = tl.segs.length - 1; i >= 0; i--) {
    const s = tl.segs[i];
    if (s.start <= t + EPS) return t < s.end - EPS ? i : -1;
  }
  return -1;
}

export type Range = { start: number; end: number; first: number; last: number };

/** 行 index（routine.moves の位置）2 つ → 区間。順番は問わない。時刻の無い行しか無ければ null */
export function rangeOf(tl: Timeline, fromIndex: number, toIndex: number): Range | null {
  const lo = Math.min(fromIndex, toIndex), hi = Math.max(fromIndex, toIndex);
  const inside = tl.segs.map((s, i) => ({ s, i })).filter(x => x.s.index >= lo && x.s.index <= hi);
  if (!inside.length) return null;
  const first = inside[0].i, last = inside[inside.length - 1].i;
  return { start: tl.segs[first].start, end: tl.segs[last].end, first, last };
}

/** 頭の前に入れるカウントイン（4 拍 = 5, 6, 7, 8）。動画は 0 秒より前に戻れない */
export const COUNT_IN_BEATS = 4;

export function prerollStart(tl: Timeline, range: Range, canGoNegative: boolean): number {
  const t = range.start - COUNT_IN_BEATS * tl.beatSec;
  return canGoNegative ? t : Math.max(0, t);
}

/**
 * 区間の終わりの扱い。終わりに着いたら、ループなら頭へ、しないなら止める。
 * 区間から大きく外れた（ユーザーが動画をいじった）ときも頭へ戻す
 */
export function loopStep(t: number, range: Range, loop: boolean, beatSec: number): { seekTo: number | null; done: boolean } {
  if (t >= range.end - 0.02) return loop ? { seekTo: range.start, done: false } : { seekTo: null, done: true };
  if (t < range.start - (COUNT_IN_BEATS + 2) * beatSec) return { seekTo: range.start, done: false };
  return { seekTo: null, done: false };
}

export type Cue = {
  /** 今の技（segs 上の位置）。カウントイン中・技の間は -1 */
  current: number;
  /** 次の技（区間の最後ならループの頭、ループしないなら -1） */
  next: number;
  /** 次の技まで leadBeats 拍以内（「次: …」を目立たせる） */
  soon: boolean;
};

/** 今の技・次の技・次が近いか */
export function cueAt(tl: Timeline, t: number, range: Range, loop: boolean, leadBeats = 1): Cue {
  const cur = segIndexAt(tl, t);
  const current = cur >= range.first && cur <= range.last ? cur : -1;
  let next: number;
  let nextStart: number;
  if (t < range.start) {
    next = range.first;
    nextStart = range.start;
  } else {
    // t 以降に始まる区間内の最初の技
    let n = -1;
    for (let i = range.first; i <= range.last; i++) {
      if (tl.segs[i].start > t + EPS) { n = i; break; }
    }
    if (n >= 0) {
      next = n;
      nextStart = tl.segs[n].start;
    } else if (loop) {
      next = range.first;
      nextStart = range.end; // 区間の終わり＝頭へ戻る瞬間
    } else {
      next = -1;
      nextStart = Infinity;
    }
  }
  if (range.first === range.last && loop && t >= range.start) next = -1; // 1 技のループは「次」を出さない
  const soon = next >= 0 && nextStart - t <= leadBeats * tl.beatSec + EPS;
  return { current, next, soon };
}

// ─── 時計 ────────────────────────────────────────────────────────────────

/** 動画が無いときの時計。壁時計（秒）から、速度を掛けたメディア時刻を作る */
export class VirtualClock {
  private base = 0;
  private since = 0;
  private _rate = 1;
  private _playing = false;
  private nowSec: () => number;
  constructor(nowSec: () => number) {
    this.nowSec = nowSec;
  }

  get playing(): boolean { return this._playing; }
  get rate(): number { return this._rate; }

  time(): number {
    return this._playing ? this.base + (this.nowSec() - this.since) * this._rate : this.base;
  }

  play(): void {
    if (this._playing) return;
    this.since = this.nowSec();
    this._playing = true;
  }

  pause(): void {
    if (!this._playing) return;
    this.base = this.time();
    this._playing = false;
  }

  seek(t: number): void {
    this.base = t;
    this.since = this.nowSec();
  }

  setRate(r: number): void {
    this.base = this.time();
    this.since = this.nowSec();
    this._rate = r;
  }
}

// ─── 音の予定 ─────────────────────────────────────────────────────────────

export type ClockSource = {
  /** 今のメディア時刻。止まっている・読み込み中・シーク中は null（鳴らさない） */
  mediaTime(): number | null;
  rate(): number;
  /** 区間の終わり。ここから先の拍は鳴らさない（ループで頭へ戻るので） */
  end(): number | null;
};

export type BeatSink = {
  /** 音の時計（AudioContext.currentTime）。鳴らせないときは null */
  now(): number | null;
  click(at: number, accent: Accent, count: number): void;
  speak?(count: number, at: number): void;
};

export type SchedulerOptions = {
  timeline: Timeline;
  clock: ClockSource;
  sink: BeatSink;
  clicks: () => boolean;
  voice: () => boolean;
  /** 何秒先（音の時計で）まで予約するか */
  lookahead?: number;
  intervalMs?: number;
};

/** 予測と実際のメディア時刻の差がこれを超えたら、基準を取り直す（フレーム単位の揺れは無視して音を安定させる） */
const RESYNC_SEC = 0.06;
/** これを超えたらシーク（ループの頭へ戻った等）とみなし、予約済みの印を巻き戻す */
const JUMP_SEC = 0.25;
/** 少し過ぎた拍もすぐ鳴らす幅（ループで頭へ戻った直後の 1 を落とさない。遅れは最大この程度） */
const LATE_SEC = 0.08;

/**
 * 拍の音を少し先まで予約していくスケジューラ（Web Audio の定番の「先読み」方式）。
 * メディア時刻と音の時計の対応（基準）を持ち、予測がずれたときだけ取り直す。
 * 同じ拍は 2 回鳴らさない（scheduledTo より前は予約済み）
 */
export class BeatScheduler {
  private o: Required<SchedulerOptions>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchor: { m: number; a: number; rate: number } | null = null;
  private scheduledTo = -Infinity;

  constructor(opts: SchedulerOptions) {
    this.o = { lookahead: 0.12, intervalMs: 25, ...opts };
  }

  setTimeline(tl: Timeline): void {
    this.o.timeline = tl;
    this.reset();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.o.intervalMs);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.reset();
  }

  reset(): void {
    this.anchor = null;
    this.scheduledTo = -Infinity;
  }

  tick(): void {
    const { clock, sink, timeline } = this.o;
    const m = clock.mediaTime();
    const a = sink.now();
    // 止まった: 基準は捨てるが、予約済みの印は残す（止める直前に予約した拍は鳴ってしまうので、再開で 2 回鳴らさない）
    if (m === null || a === null) { this.anchor = null; return; }
    const rate = clock.rate();
    if (!(rate > 0)) return;
    let anchor = this.anchor;
    const predicted = anchor ? anchor.m + (a - anchor.a) * anchor.rate : NaN;
    if (!anchor || anchor.rate !== rate || Math.abs(predicted - m) > RESYNC_SEC) {
      const jumped = !anchor || Math.abs(predicted - m) > JUMP_SEC;
      anchor = { m, a, rate };
      this.anchor = anchor;
      if (jumped) {
        // 止めた所から再開（印が今の少し先にある）なら印を残す。シークなら今から（ちょうど拍の上ならその拍も鳴らす）
        const resumed = Number.isFinite(this.scheduledTo) && this.scheduledTo >= m - LATE_SEC && this.scheduledTo <= m + JUMP_SEC;
        this.scheduledTo = resumed ? this.scheduledTo : m - LATE_SEC;
      }
    }
    const nowM = anchor.m + (a - anchor.a) * rate;
    const horizon = nowM + this.o.lookahead * rate;
    const from = Math.max(this.scheduledTo, nowM - LATE_SEC);
    if (horizon <= from) return;
    const end = clock.end();
    const clicks = this.o.clicks(), voice = this.o.voice();
    for (const beat of beatsInRange(timeline, from, horizon)) {
      if (end !== null && beat.t >= end - 0.03) continue;
      const at = Math.max(a, anchor.a + (beat.t - anchor.m) / rate);
      if (clicks) sink.click(at, accentOf(beat.count, timeline.timing), beat.count);
      if (voice && sink.speak && isSpokenCount(beat.count)) sink.speak(beat.count, at);
    }
    this.scheduledTo = horizon;
  }
}

// ─── 設定の保存 ───────────────────────────────────────────────────────────

export type PracticePrefs = { speed: Speed; clicks: boolean; voice: boolean; videoSound: boolean };

export const DEFAULT_PREFS: PracticePrefs = { speed: 0.5, clicks: true, voice: false, videoSound: false };

const PREFS_KEY = 'motionlab.practice.v1';

export function loadPrefs(): PracticePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<PracticePrefs>;
    return {
      speed: (SPEEDS as readonly number[]).includes(p.speed as number) ? (p.speed as Speed) : DEFAULT_PREFS.speed,
      clicks: typeof p.clicks === 'boolean' ? p.clicks : DEFAULT_PREFS.clicks,
      voice: typeof p.voice === 'boolean' ? p.voice : DEFAULT_PREFS.voice,
      videoSound: typeof p.videoSound === 'boolean' ? p.videoSound : DEFAULT_PREFS.videoSound,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: PracticePrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* プライベートモード等 */ }
}
