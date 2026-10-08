/**
 * 区間ダイジェスト — 「間違えている区間だけ」を AI に解析し直させるための、小さな補助情報（すべて CV の計算値）。
 *
 * 全体の再解析は 1 回でキャッシュ読み約 55 万トークン。数秒の区間だけなら、その区間の計算値と数枚の画像で足りる。
 * ここは純粋関数だけ（ファイル・claude の呼び出しは tools/reanalyze-segment.ts）。**正解は入れない**。
 * 人物 ID（pid）は重なりで入れ替わるので、人は「画面の左/右の人」で書く（位置は取り違えない）。
 */

type Json = Record<string, unknown>;

export interface TrackPerson { pid: number; bbox: number[]; kps?: number[][] }
export interface TrackFrame { t: number; kept?: TrackPerson[] }
export interface Tracks { leaderPid?: number; frames: TrackFrame[]; events?: Json[]; holdTimeline?: HoldSpan[] }
export interface HoldSpan { from: number; to: number; hold: string }

export interface SegmentInputs {
  tracks: Tracks;
  /** result.json（routine.moves と events[].verdict を使う）。無くてもよい */
  result?: Json | null;
  /** measurements.json の summary.events（handRaise を使う）。無ければ tracks.events */
  summaryEvents?: Json[] | null;
  from: number;
  to: number;
  /** 画像の幅/高さ（距離を胴長で測るときの縦横補正。縦動画なら 0.5625） */
  aspect?: number;
  /** 画像側で見つけた場面の切り替わり（秒） */
  cuts?: number[];
  /** 状態の列の刻み（秒） */
  sampleStep?: number;
  /** digest から落とす項目（実験用）: holds / cardHands（今のカードの手・説明）/ turns */
  drop?: string[];
  /** つないだ手の候補を区間のあと何秒まで見るか */
  lookAhead?: number;
  /** CV の leaderPid が男女逆のとき true（リーダー=女性として読み替える。正しい男性の側は anchor か正解表から） */
  flipRoles?: boolean;
}

// ---- 人物の箱（make_strips.py の background_pid / pair_boxes と同じ考え方） ----

const MIN_HEIGHT_RATIO = 0.6;
const MAX_FOOT_GAP = 0.3;
const OVERLAP_X = 0.35;
const JOINT_DIST = 0.45; // 手首同士がこの距離（胴長単位）以内ならつないでいる候補
const JOINT_MIN_SEC = 0.2; // これより短い「近い」は、手を伸ばして通り過ぎただけ（つないだ手ではない）

const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** 奥にいる別人（背景）を除いて、踊り手側だけの人物にする。1 人になったら「片方が隠れている」 */
export function pairPersons(frame: TrackFrame): TrackPerson[] {
  const ps = (frame.kept ?? []).filter(p => p.bbox && p.bbox.length === 4);
  if (ps.length !== 2) return ps.length > 2 ? [...ps].sort((a, b) => area(b.bbox) - area(a.bbox)).slice(0, 2) : ps;
  const [a, b] = ps;
  const ha = a.bbox[3] - a.bbox[1], hb = b.bbox[3] - b.bbox[1];
  const hmax = Math.max(ha, hb);
  if (hmax <= 0) return ps;
  if (Math.min(ha, hb) / hmax < MIN_HEIGHT_RATIO || Math.abs(a.bbox[3] - b.bbox[3]) > MAX_FOOT_GAP * hmax) {
    return [area(a.bbox) >= area(b.bbox) ? a : b];
  }
  return ps;
}

export type PairState = 'apart' | 'overlap' | 'hidden' | 'none';

export function pairState(persons: TrackPerson[]): PairState {
  if (persons.length === 0) return 'none';
  if (persons.length === 1) return 'hidden';
  const [a, b] = persons.map(p => p.bbox);
  const inter = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const minW = Math.min(a[2] - a[0], b[2] - b[0]);
  return minW > 0 && inter / minW >= OVERLAP_X ? 'overlap' : 'apart';
}

const STATE_JA: Record<PairState, string> = {
  apart: '2人が分かれて見える', overlap: '2人が縦に重なっている', hidden: '1人分の箱しか無い（片方が隠れている）', none: '検出なし',
};

// ---- 向き・腕 ----

const conf = (p: TrackPerson, i: number) => p.kps?.[i]?.[2] ?? 0;
const pt = (p: TrackPerson, i: number, min = 0.3): [number, number] | null => {
  const k = p.kps?.[i];
  return k && k[2] >= min ? [k[0], k[1]] : null;
};
const mid = (a: [number, number] | null, b: [number, number] | null): [number, number] | null =>
  a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;

export type Facing = 'face' | 'back' | 'unclear';

/** 顔が見えるか（鼻・目のキーポイント信頼度）。見える = カメラの方を向いている */
export function facingOf(p: TrackPerson): Facing {
  if (!p.kps) return 'unclear';
  const nose = conf(p, 0), eyes = (conf(p, 1) + conf(p, 2)) / 2;
  if (nose >= 0.5 && eyes >= 0.4) return 'face';
  if (nose < 0.3 && eyes < 0.25) return 'back';
  return 'unclear';
}

const FACING_JA: Record<Facing, string> = { face: '顔が見える', back: '顔が見えない(背中向き)', unclear: '横向きか不明' };

/** 頭の中心（鼻・目・耳のうち取れたものの平均。無ければ肩の少し上） */
export function headCenter(p: TrackPerson): [number, number] | null {
  const hs = [0, 1, 2, 3, 4].map(i => pt(p, i, 0.2)).filter((x): x is [number, number] => x !== null);
  if (hs.length >= 2) return [hs.reduce((s, h) => s + h[0], 0) / hs.length, hs.reduce((s, h) => s + h[1], 0) / hs.length];
  const sh = mid(pt(p, 5), pt(p, 6)), hip = mid(pt(p, 11), pt(p, 12));
  if (!sh) return null;
  return [sh[0], sh[1] - 0.5 * (hip ? Math.abs(hip[1] - sh[1]) : 0.1)];
}

/** 胴の長さ（肩の中点〜腰の中点。画像の縦を 1 とした長さ） */
export function torsoLength(p: TrackPerson): number | null {
  const sh = mid(pt(p, 5), pt(p, 6)), hip = mid(pt(p, 11), pt(p, 12));
  return sh && hip ? Math.abs(hip[1] - sh[1]) || null : null;
}

export type Hand = '右手' | '左手';

/**
 * 手首（骨格の 9=左・10=右）が本人のどちらの手か。骨格のラベルは背中向きで逆になるので使わず、
 * 指示書のルールで決める: 顔が見える人は画面の左にある手が本人の右手、背中向きの人は画面の左にある手が本人の左手。
 * 顔が見えるかが決まらないときは肩の並び（骨格の左肩が画面の右にあれば正面）で補う。それも読めなければ null
 */
export function handOfWrist(p: TrackPerson, idx: 9 | 10): Hand | null {
  const w = pt(p, idx);
  const sh = mid(pt(p, 5), pt(p, 6));
  if (!w || !sh) return null;
  let f = facingOf(p);
  if (f === 'unclear') {
    const l = pt(p, 5), r = pt(p, 6);
    if (l && r && Math.abs(l[0] - r[0]) >= 0.03) f = l[0] > r[0] ? 'face' : 'back';
  }
  if (f === 'unclear') return null;
  const screenLeft = w[0] < sh[0];
  return f === 'face' ? (screenLeft ? '右手' : '左手') : (screenLeft ? '左手' : '右手');
}

/** 頭より手首が上にある手 */
export function raisedHands(p: TrackPerson): Hand[] {
  const head = headCenter(p);
  if (!head) return [];
  const out: Hand[] = [];
  for (const idx of [9, 10] as const) {
    const w = pt(p, idx);
    const h = handOfWrist(p, idx);
    if (w && h && w[1] < head[1]) out.push(h);
  }
  return out;
}

/** 相手の頭の近くにある手首（相手の頭までの距離が胴長の thresh 倍以内）。距離は胴長単位 */
export function wristsNearHead(p: TrackPerson, partner: TrackPerson, aspect: number, thresh = 0.6): Array<{ hand: Hand; dist: number; idx: number }> {
  const head = headCenter(partner), len = torsoLength(partner);
  if (!head || !len) return [];
  const out: Array<{ hand: Hand; dist: number; idx: number }> = [];
  for (const idx of [9, 10] as const) {
    const w = pt(p, idx);
    const hand = handOfWrist(p, idx);
    if (!w || !hand) continue;
    const d = Math.hypot((w[0] - head[0]) * aspect, w[1] - head[1]) / len;
    if (d <= thresh) out.push({ hand, dist: Math.round(d * 100) / 100, idx });
  }
  return out;
}

/** 2人の手首のうち一番近い組（手をつないでいる手の候補）。距離は2人の胴長の平均を 1 とした値。どちらかが読めなければ null */
export function closestWristPair(a: TrackPerson, b: TrackPerson, aspect: number, skipA: number[] = [], skipB: number[] = []): { handA: Hand; handB: Hand; dist: number } | null {
  const la = torsoLength(a), lb = torsoLength(b);
  if (!la || !lb) return null;
  const len = (la + lb) / 2;
  let best: { handA: Hand; handB: Hand; dist: number } | null = null;
  for (const ia of [9, 10] as const) {
    for (const ib of [9, 10] as const) {
      const wa = pt(a, ia), wb = pt(b, ib), ha = handOfWrist(a, ia), hb = handOfWrist(b, ib);
      if (!wa || !wb || !ha || !hb || skipA.includes(ia) || skipB.includes(ib)) continue;
      const d = Math.hypot((wa[0] - wb[0]) * aspect, wa[1] - wb[1]) / len;
      if (!best || d < best.dist) best = { handA: ha, handB: hb, dist: d };
    }
  }
  return best;
}

// ---- 区間の取り出し ----

const r2 = (x: number) => Math.round(x * 100) / 100;

export interface FrameInfo {
  t: number;
  state: PairState;
  /** 画面の左 → 右の順 */
  persons: TrackPerson[];
}

export function framesIn(tracks: Tracks, from: number, to: number): FrameInfo[] {
  const out: FrameInfo[] = [];
  for (const f of tracks.frames) {
    if (f.t < from - 1e-6 || f.t > to + 1e-6) continue;
    const persons = pairPersons(f).sort((a, b) => (a.bbox[0] + a.bbox[2]) - (b.bbox[0] + b.bbox[2]));
    out.push({ t: f.t, state: pairState(persons), persons });
  }
  return out;
}

/** 条件を満たす時刻を、隙間 gap 秒以内でつないだ区間にする */
export function toIntervals(times: number[], gap = 0.25): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && t - last[1] <= gap) last[1] = t;
    else out.push([t, t]);
  }
  return out;
}

const iv = (a: [number, number]) => `${r2(a[0])}〜${r2(a[1])}`;
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 && b0 <= a1;

/** 技の名前（リーダー=男性、フォロワー=女性）。人手の指示書の呼び方に合わせる */
export const whoJa = (by: unknown) => (by === 'leader' ? '男性' : by === 'follower' ? '女性' : '2人');

export interface SegmentDigest {
  segment: { from: number; to: number };
  about: string;
  /** 時刻ごとの状態（1 行 1 時刻） */
  timeline: string[];
  /** 2 人が重なっている／片方が隠れている区間（手の計測が当てにならない） */
  occludedSpans: string[];
  cuts: number[];
  turns: Json[];
  holds: { inSegment: Json[]; before: Json | null; after: Json | null };
  /** つないだ手の候補（手首同士が近い組。向きのルールで右手/左手に直してある） */
  jointHands: string[];
  handRaise: string[];
  wristNearHead: string[];
  currentCards: Json[];
  neighbors: { prev: string | null; next: string | null };
}

const BEAT_PER_CARD = 8;

/** result.json の routine.moves のうち [from,to] にかかるカードと、その前後の技名 */
export function cardsIn(result: Json | null | undefined, from: number, to: number) {
  const routine = (result?.routine ?? {}) as Json;
  const moves = Array.isArray(routine.moves) ? (routine.moves as Json[]) : [];
  const bpm = typeof routine.bpm === 'number' && routine.bpm > 0 ? routine.bpm : 120;
  const dur = (m: Json) => ((typeof m.counts === 'number' ? m.counts : BEAT_PER_CARD) * 60) / bpm;
  const idx: number[] = [];
  moves.forEach((m, i) => {
    const s = Number(m.start);
    if (Number.isFinite(s) && s < to && s + dur(m) > from) idx.push(i);
  });
  const cards = idx.map(i => {
    const m = moves[i];
    return {
      start: m.start, counts: m.counts, name: m.name, holdStart: m.holdStart, holdEnd: m.holdEnd,
      leadHand: m.leadHand, turn: m.turn, steps: m.steps, confidence: m.confidence,
    } as Json;
  });
  const nameOf = (i: number) => (i >= 0 && i < moves.length ? String(moves[i].name ?? '') : null);
  return {
    cards, indices: idx,
    prev: idx.length ? nameOf(idx[0] - 1) : null,
    next: idx.length ? nameOf(idx[idx.length - 1] + 1) : null,
  };
}

export function buildSegmentDigest(inp: SegmentInputs): SegmentDigest {
  const { tracks, from, to } = inp;
  const aspect = inp.aspect ?? 0.5625;
  const step = inp.sampleStep ?? 0.3;
  const frames = framesIn(tracks, from, to);
  const events = (inp.summaryEvents ?? tracks.events ?? []) as Json[];
  const verdictOf = (e: Json) => {
    const evs = Array.isArray(inp.result?.events) ? (inp.result!.events as Json[]) : [];
    return evs.find(x => x.type === e.type && Math.abs(Number(x.t) - Number(e.t)) < 0.06)?.verdict ?? null;
  };

  // 重なり・隠れ
  const occ = toIntervals(frames.filter(f => f.state !== 'apart').map(f => f.t), 0.3);
  const occludedSpans = occ.map(a => {
    const st = frames.filter(f => f.t >= a[0] && f.t <= a[1]).map(f => f.state);
    const hidden = st.filter(s => s === 'hidden').length, over = st.filter(s => s === 'overlap').length;
    return `${iv(a)} 秒: ${hidden >= over ? '片方が隠れている（1人分の箱）' : '2人が縦に重なっている'}。この間の手の計測・回る人の取り違えは当てにならない`;
  });
  const isOcc = (t: number) => occ.some(a => t >= a[0] - 0.05 && t <= a[1] + 0.05);

  // ターン・CBL
  const turns: Json[] = [];
  const turnSpans: Array<{ from: number; to: number; who: string; dir: string }> = [];
  const whoOf = (by: unknown) => whoJa(inp.flipRoles && (by === 'leader' || by === 'follower') ? (by === 'leader' ? 'follower' : 'leader') : by);
  for (const e of events) {
    if (e.type !== 'Turn' && e.type !== 'CBL') continue;
    const span = (e.span ?? e.spin) as { from?: number; to?: number } | undefined;
    const t = Number(e.t);
    const s0 = typeof span?.from === 'number' ? span.from : t - 0.4, s1 = typeof span?.to === 'number' ? span.to : t + 0.4;
    if (!overlaps(s0, s1, from, to)) continue;
    const spin = e.spin as { runs?: Array<{ dir?: string; turns?: number }> } | undefined;
    const run = spin?.runs?.[0];
    const occluded = isOcc(t) || isOcc(s0) || isOcc(s1);
    const o: Json = {
      // 重なり/隠れの間のターンの回転数は、骨格が取り違えて数えるので出さない（出すと AI がその数に寄る）。回数は画像で数える
      type: e.type, t, 回転数: e.type === 'Turn' && occluded ? null : (e.rotations ?? null),
      // 向きは骨格の肩の動きから計算した値（回る本人から見た右/左）。誰が回ったかは重なり中は取り違える
      向き: run?.dir === 'right' ? '右回り(時計回り。回る本人から見て)' : run?.dir === 'left' ? '左回り(回る本人から見て)' : null,
      span: [r2(s0), r2(s1)], 信頼: verdictOf(e),
    };
    if (e.type === 'Turn') {
      o.回った人 = occluded
        ? `CV は${whoOf(e.by)}と判定したが、重なり/隠れの間なので当てにならない（回っているのは見えている箱の人。男女は画像で決める）`
        : `CV の判定: ${whoOf(e.by)}`;
    } else {
      o.回った人 = whoOf(e.by);
      o.pass = e.pass ?? null; o.手上げ = e.handRaise ?? null;
    }
    turns.push(o);
    if (e.type === 'Turn') turnSpans.push({ from: s0, to: s1, who: occluded ? '' : whoOf(e.by), dir: run?.dir === 'right' ? '右回り' : run?.dir === 'left' ? '左回り' : '' });
  }

  // hold
  const holdsAll = (tracks.holdTimeline ?? []) as HoldSpan[];
  const holdRel = (h: HoldSpan) => {
    const fr = framesIn(tracks, h.from, h.to);
    if (!fr.length) return { 信頼度: 'low', 理由: '計測コマなし' };
    const bad = fr.filter(f => f.state !== 'apart').length / fr.length;
    return bad >= 0.5
      ? { 信頼度: 'low', 理由: `区間の ${Math.round(bad * 100)}% のコマで2人が重なる/片方が隠れている` }
      : { 信頼度: 'normal', 理由: '2人が分かれて見えるコマが多い', 重なり割合: r2(bad) };
  };
  const handsOfHold = (label: string) => {
    const m = /リーダー(右|左)手×フォロワー(右|左)手/.exec(label);
    if (!m) return label;
    return inp.flipRoles ? `男性${m[2]}手×女性${m[1]}手` : `男性${m[1]}手×女性${m[2]}手`;
  };
  const describeHold = (h: HoldSpan) => ({ from: h.from, to: h.to, hold: handsOfHold(h.hold), ...holdRel(h) }) as Json;
  const inSeg = holdsAll.filter(h => overlaps(h.from, h.to, from, to));
  const before = [...holdsAll].filter(h => h.to < from).sort((a, b) => b.to - a.to)[0];
  const after = [...holdsAll].filter(h => h.from > to).sort((a, b) => a.from - b.from)[0];
  const holds = {
    inSegment: inSeg.map(describeHold),
    before: before ? describeHold(before) : null,
    after: after ? describeHold(after) : null,
  };

  // 手上げ・頭の近くの手首（全コマで計算して区間にまとめる）
  const raiseT: Record<string, number[]> = {};
  const nearT: Record<string, number[]> = {};
  frames.forEach(f => {
    const names = ['画面左の人', '画面右の人'];
    f.persons.forEach((p, i) => {
      const nm = f.persons.length === 2 ? names[i] : '見えている1人';
      for (const h of raisedHands(p)) (raiseT[`${nm}の${h}`] ??= []).push(f.t);
      if (f.persons.length === 2 && f.state !== 'hidden') {
        for (const w of wristsNearHead(p, f.persons[1 - i], aspect)) (nearT[`${nm}の${w.hand}→${names[1 - i]}の頭`] ??= []).push(f.t);
      }
    });
  });
  const handRaise = Object.entries(raiseT).flatMap(([k, ts]) => toIntervals(ts).map(a => `${iv(a)} 秒 ${k}が頭より上`));
  for (const e of events) {
    const hr = e.handRaise as { raised?: boolean; hand?: string; ratio?: number } | undefined;
    if (hr?.raised && Number(e.t) >= from && Number(e.t) <= to) handRaise.push(`t=${r2(Number(e.t))} CV の手上げ判定あり（どちらの手かは向きに依存するので書かない）`);
  }

  // つないだ手の候補（手首同士が近い組）。区間のあとの数秒も見る（はっきり分かれた所で決めてさかのぼるため）
  const jointT: Record<string, number[]> = {};
  const lookAhead = inp.lookAhead ?? 2.5;
  for (const f of framesIn(tracks, from, to + lookAhead)) {
    if (f.persons.length !== 2 || f.state === 'hidden') continue;
    // 相手の頭に手をかけている手は、つないだ手ではない
    const skipA = wristsNearHead(f.persons[0], f.persons[1], aspect).map(w => w.idx);
    const skipB = wristsNearHead(f.persons[1], f.persons[0], aspect).map(w => w.idx);
    const c = closestWristPair(f.persons[0], f.persons[1], aspect, skipA, skipB);
    if (!c || c.dist > JOINT_DIST) continue;
    (jointT[`画面左の人の${c.handA}×画面右の人の${c.handB}`] ??= []).push(f.t);
  }
  const jointHands = Object.entries(jointT).flatMap(([k, ts]) =>
    toIntervals(ts, 0.3).filter(a => a[1] - a[0] >= JOINT_MIN_SEC).map(a => {
      const fr = framesIn(tracks, a[0], a[1]);
      const bad = fr.filter(f => f.state === 'overlap').length / Math.max(1, fr.length);
      return `${iv(a)} 秒${a[0] > to ? '(区間のあと)' : ''} ${k}の手首が近い${bad >= 0.5 ? '（2人が重なっていて当てにならない）' : ''}`;
    }));
  const wristNearHead = Object.entries(nearT).flatMap(([k, ts]) => toIntervals(ts).map(a => `${iv(a)} 秒 ${k}が近い（胴長0.6以内）`));

  // 時刻ごとの状態
  const timeline: string[] = [];
  for (let t = from; t <= to + 1e-6; t += step) {
    const f = frames.reduce<FrameInfo | null>((best, x) => (!best || Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best), null);
    if (!f || Math.abs(f.t - t) > 0.15) { timeline.push(`t=${r2(t)} （コマなし）`); continue; }
    const parts = f.persons.map((p, i) => {
      const nm = f.persons.length === 2 ? (i === 0 ? '左' : '右') : '1人';
      const rh = raisedHands(p);
      return `${nm}:${FACING_JA[facingOf(p)]}${rh.length ? `・${rh.join("")}が頭より上` : ""}`;
    });
    const turning = turnSpans.filter(s => t >= s.from && t <= s.to).map(s => `CV:${s.who ? s.who + 'が' : ''}ターン中${s.dir ? '(' + s.dir + ')' : ''}`);
    timeline.push(`t=${r2(t)} [${STATE_JA[f.state]}] ${parts.join(' / ')}${turning.length ? ' ; ' + turning.join(',') : ''}`);
  }

  const cur = cardsIn(inp.result, from, to);
  const drop = new Set(inp.drop ?? []);
  const cards = drop.has('cardHands')
    ? cur.cards.map(c => ({ start: c.start, counts: c.counts, name: c.name }) as Json)
    : cur.cards;
  const d: SegmentDigest = {
    segment: { from, to },
    about: 'CV の計算値（正解ではない）。人の左/右は画面の左右。手の右手/左手は、顔が見える人は画面の左の手=右手・背中向きは画面の左の手=左手のルールで直してある。jointHands=手首同士が近い組（つないだ手の候補）。重なり/隠れの時刻の手・回る人は信じない。',
    timeline, occludedSpans, cuts: (inp.cuts ?? []).filter(c => c >= from && c <= to).map(r2), turns,
    holds, jointHands, handRaise, wristNearHead,
    currentCards: cards, neighbors: { prev: cur.prev, next: cur.next },
  };
  if (drop.has('holds')) d.holds = { inSegment: [], before: null, after: null };
  if (drop.has('turns')) d.turns = [];
  return d;
}

// ---- 指示文 ----

/** 指示書（analysis.md）から手の判定ルールの箇条書きだけを抜く（「手のつなぎは必ず」〜「回転数は」の直前まで＋回る向きの行） */
export function extractHandRules(md: string): string {
  const lines = md.split(/\r?\n/);
  const s = lines.findIndex(l => l.includes('手のつなぎは必ず'));
  if (s < 0) return '';
  let e = lines.findIndex((l, i) => i > s && l.includes('回転数は'));
  if (e < 0) e = Math.min(lines.length, s + 20);
  return lines.slice(s, e).join('\n').trim();
}

export interface PromptOptions {
  /** 画像の説明（ファイル名 → 何の画像か） */
  images: Array<{ file: string; note: string }>;
  handRules: string;
}

export function buildSegmentPrompt(d: SegmentDigest, o: PromptOptions): string {
  return [
    `サルサのペア動画の ${d.segment.from}〜${d.segment.to} 秒だけを解析し直す。この区間の技の行（技名・手・説明）を JSON で答える。`,
    '下の digest は CV の計算値（正解ではなく手がかり。重なり/隠れの時刻の値は信じない）。画像は Read で見る（時刻ラベル付き）。',
    '',
    '## 手順',
    '1. 今のカード（currentCards）と hold の計測は、この区間が「間違っている」と見なされたときの値。写さず、画像と jointHands を優先する。',
    '2. 手は、2人が重なっていない最初の時刻（区間のあとの jointHands でもよい）で決め、離す・持ち替える動きが画像で見えない限り、前へさかのぼって同じ手にする。重なり/隠れで読めないだけの区間を「手を離して」「none」と書かない（離したと画像で見えた時だけ none）。決めた手は、さかのぼる先のすべての行の hands・holdStart・holdEnd に書く（男性◯手×女性◯手の形で。片方だけにしない）。',
    '3. 回った人・向き・手を頭にかける動きは、画像で確かめてから書く。',
    '',
    '## 手の判定ルール（指示書の抜粋）',
    o.handRules,
    '',
    '## 画像',
    ...o.images.map(i => `- ${i.file}: ${i.note}`),
    '',
    '## digest',
    JSON.stringify(d),
    '',
    '## 出力（JSON のみ。前後に説明を書かない）',
    '{"rows":[{"start":秒,"name":"技名","hands":"男性◯手×女性◯手","move":"技の種類","holdStart":"手","holdEnd":"手","turn":{"by":"follower","direction":"right","rotations":1},"passSide":"left","description":"1〜2文"}],"basis":"根拠を1〜2文"}',
    '- 行は currentCards に対応させる（start はそのカードの start）。カードに収まらない出来事（カードの前の区間のターン等）は、別の行にしてよい。カードの中の出来事（ターン→頭に手をかける等）は name・description に書く。手を頭にかける動きを画像で確かめたときは、技名の末尾に「（頭に手をかける）」を付ける（description だけに書かない）。',
    '- move は basic cbl right_turn left_turn inside_turn outside_turn cbl_inside_turn cbl_outside_turn reverse_cbl leader_turn copa hand_change wrap hammerlock shadow dip shine other のどれか。女性が男性の脇・背後を通って左右が入れ替わる行は、男性が回っていても move を cbl 系（cbl cbl_inside_turn cbl_outside_turn reverse_cbl）にして、男性の回りは leaderTurn（{"direction":"right","rotations":1}）に書く（turn は女性の回りだけ。男性の回りを turn に書かない）。leader_turn は入れ替わりが無いときだけ。',
    '- holdStart / holdEnd は LR RR RL LL（男性の手が先。LR=男性左手×女性右手）double cross closed none のどれか。turn は回った人 by（leader=男性 / follower=女性）・direction（right/left。回る本人から見て）・rotations。無ければ null。passSide は女性が男性のどちら側を通ったか（left/right/return）。',
  ].join('\n');
}

/** 答えの文字列から {"rows":[...]} を拾う */
export function parseSegmentAnswer(text: string): { rows: Json[]; basis?: string } | null {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const p = JSON.parse(text.slice(s, e + 1)) as { rows?: unknown; basis?: unknown };
    return Array.isArray(p.rows) ? { rows: p.rows as Json[], basis: typeof p.basis === 'string' ? p.basis : undefined } : null;
  } catch { return null; }
}

/** result.json の routine.moves のうち start が [from,to) のカードを、新しい行で置き換えた result を返す（元は変えない） */
export function applySegmentRows(result: Json, from: number, to: number, rows: Json[]): Json {
  const routine = { ...((result.routine ?? {}) as Json) };
  const moves = Array.isArray(routine.moves) ? (routine.moves as Json[]) : [];
  const kept = moves.filter(m => !(Number(m.start) >= from && Number(m.start) < to));
  const added = rows.map(r => ({
    start: Number(r.start), name: String(r.name ?? ''), handsText: String(r.hands ?? ''), description: String(r.description ?? ''),
    evidence: 'segment-reanalyze',
  }));
  routine.moves = [...kept, ...added].sort((a, b) => Number(a.start) - Number(b.start));
  return { ...result, routine };
}

export interface ParsedHands { man: 'L' | 'R' | 'both' | null; woman: 'L' | 'R' | 'both' | null }

/** 「男性右手×女性左手」「右手同士」「男性左手で」「両手」などの手の文字列を読む（評価・比較用） */
export function parseHands(text: string): ParsedHands {
  const side = (s: string) => (s === '右' ? 'R' : 'L');
  const same = /(右|左)手同士/.exec(text);
  if (same) return { man: side(same[1]), woman: side(same[1]) };
  if (/両手/.test(text)) return { man: 'both', woman: 'both' };
  const m = /男性(右|左)手/.exec(text), w = /女性(右|左)手/.exec(text);
  return { man: m ? side(m[1]) : null, woman: w ? side(w[1]) : null };
}
