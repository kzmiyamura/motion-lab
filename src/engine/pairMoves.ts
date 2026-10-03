/**
 * ペア（2人）の相対関係から Turn / CBL を検出する。
 *
 * サーバ版（server/analysis/analyze_pair.py の detect_turns / detect_cbl / detect_events）を
 * MediaPipe Pose のランドマーク（11/12 肩・23/24 腰）向けに移植したもの。
 * - 主ペア選択: 体の大きさ（可視ランドマークの bbox 面積）上位2人。背景・鏡の小さな人物を除外
 * - 2スロット追跡: 速度予測付き Nearest Neighbor（腰中点）
 * - Turn: 体の向き（左肩X − 右肩X の符号）が短時間に2回反転 = 一回転。振り幅条件でジッタを弾く
 * - CBL: 2人の腰X の並び順の入れ替わり（交差）。前後に十分な分離があること。
 *   2人の「相対」位置なのでカメラのパンでは発火しない
 * - CBL 近傍・相手のターン近傍の「連られ回転」を棄却（リーダーのピボット）
 *
 * 判定には前後の文脈が要るので、イベントは LAG_SEC 遅れて確定する（time は発生時刻）。
 * 座標の閾値はすべて胴長（肩中点〜腰中点）で正規化し、映像の大きさに依存しない。
 */

export interface PoseLandmarkLike { x: number; y: number; visibility?: number }

export interface PairMove {
  /** 発生時刻（秒） */
  t: number;
  action: 'Turn' | 'CBL';
  quality: number;
  /** 回った人の内部スロット（0/1）。CBL は undefined */
  by?: 0 | 1;
  note?: string;
}

const VIS = 0.5;
/** 主ペアの2人目は最大の人物の面積のこの割合以上（鏡・背景の小さな人物を弾く） */
const PAIR_MIN_AREA_RATIO = 0.3;
/** スロットを見失ってから空きとみなすまでの秒数 */
const SLOT_TIMEOUT_SEC = 1.0;
/** NN 割り当ての最大移動距離（胴長の倍数） */
const SLOT_GATE_TORSO = 2.5;

const TURN_FLIP_WINDOW = 1.5;   // 2回の向き反転がこの秒数以内 = 一回転
const TURN_FLIP_MARGIN = 0.12;  // |肩X差|/胴長 がこれ未満（真横向き）は向き不定として無視
const TURN_SWEEP_MIN = 0.35;    // 反転の前後でしっかり正面/背面まで振れたこと（|肩X差|/胴長）
const TURN_PRE_SEC = 1.0;
const TURN_COOLDOWN_SEC = 2.5;  // 同じ人のターンの最小間隔

const CBL_MIN_SEP = 0.35;        // 交差の前後に必要な左右分離（腰X差/胴長）
/** 交差の前後の run の間の最大の欠落（秒） */
const CBL_MAX_GAP_SEC = 3.0;
const CBL_COOLDOWN_SEC = 2.5;
/** 交差の前後の窓に必要な2人そろったサンプル数 */
const CBL_MIN_SAMPLES = 2;
/** CBL の±この秒数のターンは CBL の連られ回転（リーダーのピボット）とみなす */
const PIVOT_SUPPRESS_SEC = 1.2;

// ── 手上げ（男性のリードの手が頭上 = ターンの合図。docs/salsa-move-grammar.md 4.3）──
/** 手上げフレームをひとまとまりとみなす最大の間隔 */
const RAISE_GAP_SEC = 0.5;
/** 手上げの区間の中点からターン時刻までのずれ（手を上げてから回り切るまで） */
const RAISE_TURN_OFFSET_SEC = 0.2;
/** この秒数以内の Turn は同じ回転とみなしてまとめる */
const TURN_MERGE_SEC = 1.5;

/** 回帰評価で調整する閾値（既定値が採用値） */
export const PAIR_TUNING = {
  /** 手上げターンを使う */
  raise: true,
  /** 手上げとみなす最小フレーム数 */
  raiseMinFrames: 1,
  /** CBL が近くに無い手上げは、これ以上のフレーム数のときだけターンとみなす */
  raiseMinFramesAlone: 2,
  /** これより長く手を上げ続けるのは説明の身振り（ターンの手上げは一瞬） */
  raiseMaxSec: 1.2,
  /** 手上げターンに CBL を要求する（CBL の raiseCblBefore 秒前〜raiseCblAfter 秒後） */
  raiseNeedCbl: false,
  raiseCblBefore: 0.5,
  raiseCblAfter: 2.5,
  /** 手上げの前後この秒数以内に2人がそろって映ったフレームが無ければ出さない（1人の立ち話・身振り） */
  raisePairSec: 3,
  /** 2人の腰の左右の距離（胴長単位）の上限。これより離れた2人はペアとみなさない */
  pairMaxSep: 2.0,
  /** 体の向きの反転2回によるターンを使う（既定は無効: 立ち話やカメラのパンで誤検出が増え、F1 が下がった） */
  flip: false,
};

/** 判定の確定遅れ（CBL の後方窓 2.0s + 連られ判定 1.2s + 余裕） */
const LAG_SEC = 3.5;
/** バッファ保持秒数 */
const KEEP_SEC = 12;
const EVAL_INTERVAL_SEC = 0.25;

export interface PersonMeasure {
  hipX: number;
  hipY: number;
  /** (左肩X − 右肩X) / 胴長。正 = カメラ正面向き、負 = 背面向き（MediaPipe の左右ラベルに依存） */
  face: number | null;
  torso: number;
  /** 肩中点 */
  shX: number;
  shY: number;
  area: number;
  /** 手首（15/16）のどちらかが頭（鼻。見えなければ肩の少し上）より上 */
  handUp: boolean;
}

interface Slot { m: PersonMeasure; t: number; vx: number; vy: number }
interface Frame {
  t: number;
  s: [PersonMeasure | null, PersonMeasure | null];
  /** 主ペア候補の誰かが手を頭上に上げている */
  handUp: boolean;
}

export function measurePerson(lm: PoseLandmarkLike[]): PersonMeasure | null {
  const ok = (i: number) => lm[i] !== undefined && (lm[i].visibility ?? 1) >= VIS;
  if (!ok(11) || !ok(12) || !(ok(23) || ok(24))) return null;
  const hips = [23, 24].filter(ok).map(i => lm[i]);
  const hipX = hips.reduce((a, l) => a + l.x, 0) / hips.length;
  const hipY = hips.reduce((a, l) => a + l.y, 0) / hips.length;
  const shX = (lm[11].x + lm[12].x) / 2;
  const shY = (lm[11].y + lm[12].y) / 2;
  const torso = Math.hypot(shX - hipX, shY - hipY);
  if (torso < 0.02) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const l of lm) {
    if ((l.visibility ?? 1) < VIS) continue;
    x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x);
    y0 = Math.min(y0, l.y); y1 = Math.max(y1, l.y);
  }
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const face = (lm[11].x - lm[12].x) / torso;
  const head = ok(0) ? lm[0].y : Math.min(lm[11].y, lm[12].y) - 0.2 * torso;
  const handUp = [15, 16].some(i => ok(i) && lm[i].y < head);
  return { hipX, hipY, shX, shY, face, torso, area, handUp };
}

/** 主ペア（面積上位2人、2人目は最大の PAIR_MIN_AREA_RATIO 以上）を返す */
export function pickMainPair(ms: PersonMeasure[]): PersonMeasure[] {
  return pickCandidates(ms).slice(0, 2);
}

/** 主ペアの候補（二重検出を除き、面積の大きい順。最大の PAIR_MIN_AREA_RATIO 未満は除外） */
export function pickCandidates(ms: PersonMeasure[]): PersonMeasure[] {
  const sorted = [...ms].sort((a, b) => b.area - a.area);
  if (sorted.length === 0) return [];
  // 同一人物の二重検出（2パス検出で肩・腰がほぼ重なる）を除く
  const uniq: PersonMeasure[] = [];
  for (const m of sorted) {
    const dup = uniq.some(u => {
      const tol = 0.35 * Math.max(u.torso, m.torso);
      return Math.hypot(u.hipX - m.hipX, u.hipY - m.hipY) < tol && Math.hypot(u.shX - m.shX, u.shY - m.shY) < tol;
    });
    if (!dup) uniq.push(m);
  }
  const top = uniq[0].area;
  return uniq.filter(m => m.area >= top * PAIR_MIN_AREA_RATIO).slice(0, 4);
}

export class PairMoveDetector {
  private slots: [Slot | null, Slot | null] = [null, null];
  private frames: Frame[] = [];
  private lastEval = -Infinity;
  /** ここまでの時刻のイベントは確定済み */
  private finalizedUntil = -Infinity;
  private lastT = -Infinity;
  private emitted: PairMove[] = [];

  reset() {
    this.slots = [null, null];
    this.frames = [];
    this.lastEval = -Infinity;
    this.finalizedUntil = -Infinity;
    this.lastT = -Infinity;
    this.emitted = [];
  }

  /** デバッグ用: バッファ中のフレーム */
  get bufferedFrames(): readonly Frame[] { return this.frames; }

  /** 1フレーム分の全検出人物を入れる。新たに確定したイベントを返す */
  push(t: number, persons: PoseLandmarkLike[][]): PairMove[] {
    // シーク・ループで時刻が戻ったら、それまでの未確定分を確定させてから状態を捨てる
    let pending: PairMove[] = [];
    if (t < this.lastT - 0.5) { pending = this.flush(); this.reset(); }
    if (t <= this.lastT) return pending;
    this.lastT = t;

    const ms = persons.map(measurePerson).filter((m): m is PersonMeasure => m !== null);
    const pair = pickCandidates(ms);
    this.frames.push({ t, s: this.assign(t, pair), handUp: pair.some(m => m.handUp) });
    while (this.frames.length > 0 && this.frames[0].t < t - KEEP_SEC) this.frames.shift();

    if (t - this.lastEval < EVAL_INTERVAL_SEC) return pending;
    this.lastEval = t;
    return [...pending, ...this.finalize(t - LAG_SEC)];
  }

  /** 末尾の未確定分も含めて確定させる（再生終了・停止時） */
  flush(): PairMove[] {
    return this.finalize(Infinity);
  }

  private assign(t: number, pair: PersonMeasure[]): [PersonMeasure | null, PersonMeasure | null] {
    const out: [PersonMeasure | null, PersonMeasure | null] = [null, null];
    for (let i = 0; i < 2; i++) {
      const s = this.slots[i];
      if (s && t - s.t > SLOT_TIMEOUT_SEC) this.slots[i] = null;
    }
    const pred = (s: Slot | null) => {
      if (!s) return null;
      const dt = Math.min(t - s.t, 0.3);
      return { x: s.m.hipX + s.vx * dt, y: s.m.hipY + s.vy * dt, torso: s.m.torso };
    };
    const p = [pred(this.slots[0]), pred(this.slots[1])];
    const cost = (m: PersonMeasure, k: number) => {
      const q = p[k];
      if (!q) return 1.0; // 空きスロットへの中立コスト
      const d = Math.hypot(m.hipX - q.x, m.hipY - q.y);
      return d > SLOT_GATE_TORSO * q.torso ? Infinity : d / q.torso;
    };
    // 各スロットに候補を1人ずつ（または誰も）割り当てる組合せのうち、総コスト最小のもの。
    // 面積上位2人に決め打ちしないので、一瞬だけ大きく出た誤検出に追跡を奪われない
    const NONE = 1.2; // 割り当てなしのコスト（予測位置から胴長 1.2 倍以上離れた候補より「見失い」を選ぶ）
    const maxArea = Math.max(0, ...pair.map(m => m.area));
    const slotCost = (j: number, k: number) => {
      if (j < 0) return NONE;
      // 空きスロットは大きい人を優先して埋める
      if (!p[k]) return 1.0 - 0.1 * (maxArea > 0 ? pair[j].area / maxArea : 0);
      return cost(pair[j], k);
    };
    let best: [number, number] = [-1, -1];
    let bestCost = Infinity;
    for (let a = -1; a < pair.length; a++) {
      for (let b = -1; b < pair.length; b++) {
        if (a >= 0 && a === b) continue;
        let c = slotCost(a, 0) + slotCost(b, 1);
        // 初回（両スロット空き）は画面左を slot0 にする
        if (!p[0] && !p[1] && a >= 0 && b >= 0 && pair[a].hipX > pair[b].hipX) c += 0.01;        if (c < bestCost) { bestCost = c; best = [a, b]; }
      }
    }
    const assigned: Array<[PersonMeasure, 0 | 1]> = [];
    if (best[0] >= 0) assigned.push([pair[best[0]], 0]);
    if (best[1] >= 0) assigned.push([pair[best[1]], 1]);
    assigned.forEach(([m, k]) => {
      const prev = this.slots[k];
      let vx = 0, vy = 0;
      if (prev && t > prev.t) {
        const dt = t - prev.t;
        vx = 0.5 * prev.vx + 0.5 * (m.hipX - prev.m.hipX) / dt;
        vy = 0.5 * prev.vy + 0.5 * (m.hipY - prev.m.hipY) / dt;
      }
      this.slots[k] = { m, t, vx, vy };
      out[k] = m;
    });
    return out;
  }

  private finalize(until: number): PairMove[] {
    const all = detectPairMoves(this.frames);
    const fresh = all.filter(e => e.t > this.finalizedUntil && e.t <= until);
    if (Number.isFinite(until)) this.finalizedUntil = Math.max(this.finalizedUntil, until);
    else if (fresh.length) this.finalizedUntil = Math.max(this.finalizedUntil, ...fresh.map(e => e.t));
    // 窓の切れ目で同じイベントが二重に出ないよう、確定済みと近いものは捨てる
    const out: PairMove[] = [];
    for (const e of fresh) {
      const cd = e.action === 'CBL' ? CBL_COOLDOWN_SEC : TURN_COOLDOWN_SEC;
      if (this.emitted.some(p => p.action === e.action && p.by === e.by && Math.abs(p.t - e.t) < cd)) continue;
      this.emitted.push(e);
      out.push(e);
    }
    if (this.emitted.length > 50) this.emitted.splice(0, this.emitted.length - 50);
    return out;
  }
}

/** スロットごとのターン候補（時刻・振り幅）。サーバ版 detect_turns と同じ考え方 */
export function detectTurns(frames: readonly Frame[], k: 0 | 1): Array<{ t: number; swing: number }> {
  const series: Array<[number, number]> = [];
  for (const f of frames) {
    const m = f.s[k];
    if (m && m.face !== null && Math.abs(m.face) >= TURN_FLIP_MARGIN) series.push([f.t, m.face]);
  }
  const flips: Array<[number, number]> = []; // (時刻, 反転前の符号)
  for (let i = 1; i < series.length; i++) {
    const d0 = series[i - 1][1], d1 = series[i][1];
    if ((d0 > 0) !== (d1 > 0)) flips.push([series[i][0], d0 > 0 ? 1 : -1]);
  }
  const sweep = (from: number, to: number, sign: number) => {
    let best = 0;
    for (const [t, d] of series) if (t >= from && t <= to) best = Math.max(best, d * sign);
    return best;
  };
  const events: Array<{ t: number; swing: number }> = [];
  let last = -Infinity;
  let i = 0;
  while (i + 1 < flips.length) {
    const [t1, sign] = flips[i];
    const [t2] = flips[i + 1];
    const pre = sweep(t1 - TURN_PRE_SEC, t1, sign);
    const mid = sweep(t1, t2, -sign);
    if (t2 - t1 <= TURN_FLIP_WINDOW && t1 - last > TURN_COOLDOWN_SEC
        && pre >= TURN_SWEEP_MIN && mid >= TURN_SWEEP_MIN) {
      events.push({ t: t1, swing: Math.min(pre, mid) });
      last = t1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return events;
}

/**
 * CBL 候補時刻。サーバ版 detect_cbl と同じ考え方（2人の腰Xの並び順の入れ替わり + 前後の分離）。
 * ブラウザの骨格推定は交差の瞬間に2人を1人に潰しがちで、交差の前後に数秒の欠落が出る。
 * そこで「同じ並び順が続く区間（run）」を作り、並びが確定した run（CBL_MIN_SAMPLES 以上・
 * 中央値で CBL_MIN_SEP 以上離れている）が逆向きの run に CBL_MAX_GAP_SEC 以内で切り替わったら交差とする。
 * 時刻は前の run の終わりと次の run の始まりの中点。単発の取り違え（1〜2フレーム）は run にならず無視される
 */
export function detectCbl(frames: readonly Frame[]): number[] {
  const pair: Array<[number, number]> = [];
  for (const f of frames) {
    const [a, b] = f.s;
    if (!a || !b) continue;
    const d = (a.hipX - b.hipX) / ((a.torso + b.torso) / 2);
    // 離れすぎ（胴長の PAIR_TUNING.pairMaxSep 倍超）は踊っている相手ではない（壁際の見学者・鏡の人）
    if (Math.abs(d) <= PAIR_TUNING.pairMaxSep) pair.push([f.t, d]);
  }
  // 同符号の連続サンプルを run にまとめる
  type Run = { sign: number; t0: number; t1: number; ds: number[] };
  const runs: Run[] = [];
  for (const [t, d] of pair) {
    const sign = d >= 0 ? 1 : -1;
    const cur = runs[runs.length - 1];
    if (cur && cur.sign === sign && t - cur.t1 <= CBL_MAX_GAP_SEC) {
      cur.t1 = t; cur.ds.push(d);
    } else {
      runs.push({ sign, t0: t, t1: t, ds: [d] });
    }
  }
  const confirmed = runs.filter(r => r.ds.length >= CBL_MIN_SAMPLES && Math.abs(median(r.ds)) >= CBL_MIN_SEP);
  const events: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < confirmed.length; i++) {
    const a = confirmed[i - 1], b = confirmed[i];
    if (a.sign === b.sign || b.t0 - a.t1 > CBL_MAX_GAP_SEC) continue;
    const t = (a.t1 + b.t0) / 2;
    if (t - last > CBL_COOLDOWN_SEC) { events.push(t); last = t; }
  }
  return events;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** バッファ全体からイベントを出す（連られ回転の棄却込み） */
export function detectHandRaises(frames: readonly Frame[]): Array<{ t: number; n: number }> {
  const bursts: Array<{ t0: number; t1: number; n: number }> = [];
  for (const f of frames) {
    if (!f.handUp) continue;
    const b = bursts[bursts.length - 1];
    if (b && f.t - b.t1 <= RAISE_GAP_SEC) { b.t1 = f.t; b.n++; } else bursts.push({ t0: f.t, t1: f.t, n: 1 });
  }
  return bursts
    .filter(b => b.n >= PAIR_TUNING.raiseMinFrames && b.t1 - b.t0 <= PAIR_TUNING.raiseMaxSec)
    .map(b => ({ t: (b.t0 + b.t1) / 2 + RAISE_TURN_OFFSET_SEC, n: b.n }));
}

export function detectPairMoves(frames: readonly Frame[]): PairMove[] {
  const cbl = detectCbl(frames);
  const turns = [detectTurns(frames, 0), detectTurns(frames, 1)];
  const out: PairMove[] = cbl.map(t => ({ t, action: 'CBL' as const, quality: 0.7 }));
  if (PAIR_TUNING.raise) {
    for (const r of detectHandRaises(frames)) {
      const nearCbl = cbl.some(c => r.t - c >= -PAIR_TUNING.raiseCblBefore && r.t - c <= PAIR_TUNING.raiseCblAfter);
      if ((PAIR_TUNING.raiseNeedCbl || r.n < PAIR_TUNING.raiseMinFramesAlone) && !nearCbl) continue;
      if (!frames.some(f => f.s[0] && f.s[1] && Math.abs(f.t - r.t) <= PAIR_TUNING.raisePairSec)) continue;
      out.push({ t: r.t, action: 'Turn', quality: nearCbl ? 0.8 : 0.6, note: 'raise' });
    }
  }
  if (!PAIR_TUNING.flip) return dedupeTurns(out);
  for (const k of [0, 1] as const) {
    const other = turns[1 - k];
    for (const tr of turns[k]) {
      // 相手も ±PIVOT_SUPPRESS_SEC 以内に回っていたら、振り幅の小さい方を連られ回転として捨てる
      const rival = other.find(o => Math.abs(o.t - tr.t) <= PIVOT_SUPPRESS_SEC);
      if (rival && (rival.swing > tr.swing || (rival.swing === tr.swing && k === 1))) continue;
      out.push({ t: tr.t, action: 'Turn', quality: Math.min(1, 0.5 + tr.swing / 2), by: k });
    }
  }
  return dedupeTurns(out);
}

/** 近すぎる Turn（手上げと向き反転が同じ回転を二重に拾ったもの）を1つにまとめる */
function dedupeTurns(evs: PairMove[]): PairMove[] {
  const sorted = [...evs].sort((a, b) => a.t - b.t);
  const out: PairMove[] = [];
  for (const e of sorted) {
    const prev = [...out].reverse().find(p => p.action === e.action);
    if (e.action === 'Turn' && prev && e.t - prev.t < TURN_MERGE_SEC) {
      if (e.quality > prev.quality) out[out.indexOf(prev)] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}
