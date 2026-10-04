import type { MotionClip, ArmSegment } from '../components/MocapFigure';
import { buildScriptedBasic, buildScriptedCBL, type Timing } from './scriptedClip';

/**
 * 解析結果（技の並び）→ 3D クリップ。
 *
 * 動画の骨格から奥行きを復元するのではなく、**技の名前・カウント・テンポだけ**を
 * 動画から取り、動き自体は合格済みの手描き振付（scriptedClip.ts）を並べて組む。
 * カメラの傾き・奥行きの誤差・隠れが原理的に効かない経路。
 *
 * 合格済みの振付は一切書き換えない — 既存クリップを「拍の窓」で切り出し、
 * 剛体変換（床の上の回転＋平行移動）で前の技の出口へつなぐだけ。
 * まだ手描きが無い技はベーシックで代用し、`coverage` に「近似」として正直に残す。
 */

/** 解析（result.json の routine）が出す技の語彙 */
export type RoutineMoveId =
  | 'basic' | 'cbl'
  | 'right_turn' | 'left_turn' | 'inside_turn' | 'outside_turn'
  | 'cbl_inside_turn' | 'cbl_outside_turn' | 'reverse_cbl' | 'leader_turn'
  | 'copa' | 'hand_change' | 'wrap' | 'hammerlock' | 'shadow' | 'dip'
  | 'shine' | 'other';

/** 手のつなぎ。男性の手が先（LR = 男性左手×女性右手） */
export type RoutineHold = 'LR' | 'RR' | 'RL' | 'LL' | 'double' | 'cross' | 'closed' | 'none';

export type RoutineMove = {
  move: RoutineMoveId;
  /** 表示名（「クロスボディ・インサイドターン」等） */
  name?: string;
  /** 動画上の開始時刻[秒]（カウント1）。わかる範囲で */
  start?: number;
  /** 拍数。8 の倍数（既定 8） */
  counts?: number;
  turn?: { by: 'leader' | 'follower' | 'both'; direction?: 'right' | 'left' | null; rotations?: number } | null;
  /** 同じ行で男も回ったとき（turn は女性のターンが主。サーバーの normalize_routine.py が付ける） */
  leaderTurn?: { direction?: 'right' | 'left' | null; rotations?: number | null } | null;
  /** 女性が男性の体から見てどちらを通ったか（return = コパのように行って戻る） */
  passSide?: 'left' | 'right' | 'return' | null;
  holdStart?: RoutineHold | null;
  holdEnd?: RoutineHold | null;
  /** seen = 画像で見えた / inferred = 隠れていて前後の状態から推定（docs/salsa-move-grammar.md 4章） */
  evidence?: 'seen' | 'inferred';
  confidence?: number | 'ok' | 'doubtful';
};

export type Routine = {
  timing: Timing | 'unclear';
  bpm?: number | null;
  moves: RoutineMove[];
};

export type CoverageItem = {
  index: number; name: string; beats: number;
  /** exact = 手描きの振付そのもの / approx = 未実装の技をベーシックで代用 */
  kind: 'exact' | 'approx';
};

const BASE_BPM = 170;                 // scriptedClip の手描きテンポ
const BASE_SPB = 60 / BASE_BPM;
const FPS = 30;
const BLEND_BEATS = 1;                // 技の継ぎ目を混ぜる幅（前後 0.5 拍ずつ）
const N_JOINTS = 19;

export const MOVE_LABEL: Record<RoutineMoveId, string> = {
  basic: 'ベーシック',
  cbl: 'クロスボディリード',
  right_turn: '右ターン',
  left_turn: '左ターン',
  inside_turn: 'インサイドターン',
  outside_turn: 'アウトサイドターン',
  cbl_inside_turn: 'クロスボディ・インサイドターン',
  cbl_outside_turn: 'クロスボディ・アウトサイドターン',
  reverse_cbl: 'リバース・クロスボディ',
  leader_turn: '男性のターン',
  copa: 'コパ',
  hand_change: '持ち替え',
  wrap: 'ラップ',
  hammerlock: 'ハンマーロック',
  shadow: 'シャドウ',
  dip: 'ディップ',
  shine: 'シャイン',
  other: 'その他の技',
};

/** 床の上の剛体変換。yaw は scriptedClip と同じ規約（前方 = (sin, cos)） */
type Xf = { x: number; z: number; yaw: number };

function apply(t: Xf, x: number, z: number): [number, number] {
  const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
  return [t.x + x * c + z * s, t.z - x * s + z * c];
}
function compose(a: Xf, b: Xf): Xf {           // a ∘ b（b を先に当てる）
  const [x, z] = apply(a, b.x, b.z);
  return { x, z, yaw: a.yaw + b.yaw };
}
function invert(t: Xf): Xf {
  const c = Math.cos(-t.yaw), s = Math.sin(-t.yaw);
  return { x: -(t.x * c + t.z * s), z: -(-t.x * s + t.z * c), yaw: -t.yaw };
}

/**
 * 既存クリップから切り出す拍の窓。entry/exit は窓の頭と終わりでの
 * 「リーダーの立ち位置と向き」— これを前の技の出口に合わせてつなぐ。
 */
type Unit = {
  src: MotionClip;
  b0: number; beats: number;            // 元クリップ内の拍の窓（BASE テンポ）
  entry: Xf; exit: Xf;
  label: string; kind: CoverageItem['kind'];
};

const D2R = Math.PI / 180;
// ベーシック: 男は (-0.35, 0) で +X を向く。8拍で元に戻る
const BASIC_POSE: Xf = { x: -0.35, z: 0, yaw: 90 * D2R };
// CBL: 男は PIVOT_X(-0.30) に残り、8拍の CBL で 180° 向き直る
const CBL_IN: Xf = { x: -0.30, z: 0, yaw: 90 * D2R };
const CBL_OUT: Xf = { x: -0.30, z: 0, yaw: 270 * D2R };
const CBL_ON2_SHIFT = 5;                // scriptedClip の CBL_ON2_SHIFT と同じ

/** 元クリップを時刻 t[秒] でサンプル（ループ・線形補間） */
function sample(clip: MotionClip, t: number, pid: string): { j: number[]; v: number[] } {
  const fr = clip.frames;
  const d = clip.duration;
  const u = ((t % d) + d) % d;
  const dt = fr.length > 1 ? fr[1].t - fr[0].t : 1;
  const i = Math.min(fr.length - 2, Math.floor(u / dt));
  const a = fr[i].p[pid], b = fr[i + 1].p[pid];
  const w = Math.min(1, Math.max(0, (u - fr[i].t) / dt));
  return {
    j: a.j.map((x, k) => x + (b.j[k] - x) * w),
    v: a.v.map((x, k) => Math.max(x, b.v[k])),
  };
}

/** 関節を剛体変換で床の上へ置き直す（y はそのまま） */
function place(p: { j: number[]; v: number[] }, t: Xf): { j: number[]; v: number[] } {
  const j = p.j.slice();
  for (let k = 0; k < N_JOINTS; k++) {
    const [x, z] = apply(t, j[k * 3], j[k * 3 + 2]);
    j[k * 3] = x; j[k * 3 + 2] = z;
  }
  return { j, v: p.v };
}

const smoothstep = (u: number) => u * u * (3 - 2 * u);

/** 解析の技 → 組み立て単位。手描きが無い技はベーシックで代用 */
function unitsFor(m: RoutineMove, timing: Timing, closed: boolean,
  basic: () => MotionClip, cbl: () => MotionClip): Unit[] {
  const counts = Math.max(8, Math.round((m.counts ?? 8) / 8) * 8);
  const label = m.name ?? MOVE_LABEL[m.move] ?? m.move;
  const basicBar = (lbl: string, kind: CoverageItem['kind']): Unit =>
    ({ src: basic(), b0: 0, beats: 8, entry: BASIC_POSE, exit: BASIC_POSE, label: lbl, kind });
  const out: Unit[] = [];
  if (m.move === 'cbl') {
    const shift = timing === 'on2' ? CBL_ON2_SHIFT : 0;
    out.push({ src: cbl(), b0: 8 + shift, beats: 8, entry: CBL_IN, exit: CBL_OUT, label, kind: 'exact' });
  } else if (m.move === 'basic') {
    out.push(basicBar(label, 'exact'));
  } else {
    out.push(basicBar(`（近似）${label}`, 'approx'));
  }
  // 残りの拍はベーシックで埋める（16カウントの技など）。手描きのある技なら埋めた分も exact
  const fillKind = out[0].kind;
  while (out.reduce((s, u) => s + u.beats, 0) < counts) {
    out.push(basicBar(m.move === 'basic' ? label : `${label}（続き）`, fillKind));
  }
  void closed;
  return out;
}

/**
 * ルーティンを1本の MotionClip に組む。返り値の clip は SalsaStage3D の
 * ハイブリッド再生（CoupleFigure）にそのまま渡せる（armTimeline.source = 'scripted'）。
 */
export function composeRoutine(routine: Routine, closed = false): { clip: MotionClip; coverage: CoverageItem[] } {
  const timing: Timing = routine.timing === 'on2' ? 'on2' : 'on1';
  const bpm = routine.bpm && routine.bpm >= 60 && routine.bpm <= 260 ? routine.bpm : BASE_BPM;
  let basicClip: MotionClip | null = null, cblClip: MotionClip | null = null;
  const basic = () => (basicClip ??= buildScriptedBasic(timing, closed));
  const cbl = () => (cblClip ??= buildScriptedCBL(timing, closed));

  const moves = routine.moves.length ? routine.moves : [{ move: 'basic' as const }];
  const units: Unit[] = [];
  const coverage: CoverageItem[] = [];
  moves.forEach((m, index) => {
    const us = unitsFor(m, timing, closed, basic, cbl);
    units.push(...us);
    coverage.push({
      index, name: m.name ?? MOVE_LABEL[m.move] ?? m.move,
      beats: us.reduce((s, u) => s + u.beats, 0),
      kind: us.some((u) => u.kind === 'approx') ? 'approx' : 'exact',
    });
  });

  // 各単位の配置: 前の単位の出口（ワールド）に自分の入口を重ねる
  // world = place ∘ inv(entry)。出口のワールド姿勢 = world ∘ exit
  const worlds: Xf[] = [];
  const starts: number[] = [];
  let pose: Xf = BASIC_POSE;            // 最初の単位はベーシックの立ち位置から
  let beat = 0;
  for (const u of units) {
    const w = compose(pose, invert(u.entry));
    worlds.push(w);
    starts.push(beat);
    pose = compose(w, u.exit);
    beat += u.beats;
  }
  const totalBeats = beat;

  // 単位 k の出力拍 b における2人の関節（元クリップの窓の外も、ループとしてそのまま読む）
  const at = (k: number, b: number, pid: string) => {
    const u = units[k];
    const srcT = (u.b0 + (b - starts[k])) * BASE_SPB;
    return place(sample(u.src, srcT, pid), worlds[k]);
  };

  const spb = 60 / bpm;
  const duration = totalBeats * spb;
  const n = Math.round(duration * FPS);
  const frames: MotionClip['frames'] = [];
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / FPS;
    const b = Math.min(totalBeats - 1e-6, t / spb);
    while (k < units.length - 1 && b >= starts[k + 1]) k++;
    const p: MotionClip['frames'][number]['p'] = {};
    for (const pid of ['0', '1']) {
      let cur = at(k, b, pid);
      // 継ぎ目の前後 0.5 拍は前後の単位を混ぜる（立ち位置・足幅の小さな差を吸収）
      const half = BLEND_BEATS / 2;
      const next = k + 1 < units.length ? starts[k + 1] : Infinity;
      const prevEdge = starts[k];
      let other: { j: number[]; v: number[] } | null = null, w = 0;
      if (next - b < half) { other = at(k + 1, b, pid); w = smoothstep((half - (next - b)) / BLEND_BEATS); }
      else if (k > 0 && b - prevEdge < half) { other = at(k - 1, b, pid); w = smoothstep((half - (b - prevEdge)) / BLEND_BEATS); }
      if (other && w > 0) {
        cur = { j: cur.j.map((x, q) => x + (other!.j[q] - x) * w), v: cur.v.map((x, q) => Math.max(x, other!.v[q])) };
      }
      p[pid] = { r: [], j: cur.j, v: cur.v };
    }
    frames.push({ t, p });
  }

  // 腕の台本: 各単位の窓に入るセグメントを切り出して出力時刻へ移す
  const segments: ArmSegment[] = [];
  units.forEach((u, kk) => {
    const w0 = u.b0 * BASE_SPB, w1 = (u.b0 + u.beats) * BASE_SPB;
    for (const s of u.src.armTimeline?.segments ?? []) {
      const a = Math.max(s.t0, w0), c = Math.min(s.t1, w1);
      if (c - a < 1e-6) continue;
      const toOut = (x: number) => (starts[kk] + (x - w0) / BASE_SPB) * spb;
      segments.push({ ...s, t0: toOut(a), t1: toOut(c) });
    }
  });
  if (segments.length) { segments[0].t0 = 0; segments[segments.length - 1].t1 = duration; }

  // 画面の「いまの技」表示用。CBL は既存の表示名、他は技名をそのまま出す
  const events: MotionClip['events'] = units
    .map((u, kk) => ({ u, t: starts[kk] * spb, kk }))
    .filter(({ u, kk }) => kk === 0 || u.label !== units[kk - 1].label)
    .map(({ u, t }) => ({ t, type: u.label === MOVE_LABEL.cbl ? 'CBL' : u.label, by: 'pair' }));

  return {
    clip: {
      version: 1,
      fps: FPS,
      duration,
      leaderPid: 0,
      joints: new Array(N_JOINTS).fill('') as string[],
      events,
      frames,
      beatGrid: { bpm, firstBeatSec: 0, beatIntervalSec: spb, confidence: 1 },
      armTimeline: { version: 1, source: 'scripted', segments },
    },
    coverage,
  };
}

type ResultJson = {
  style?: { onBeat?: string };
  events?: { t: number; type: string; by?: string; verdict?: string; rotations?: number }[];
  routine?: Partial<Routine> & { moves?: RoutineMove[] };
  beatGrid?: { bpm?: number } | null;
};

const MOVE_IDS = new Set<string>(Object.keys(MOVE_LABEL));

/**
 * 解析の result.json からルーティンを取り出す。
 * `routine`（Claude が書く技の並び）があればそれを使い、無い古い結果では
 * events（CBL/Turn の時刻）から小節単位で並べ直す（ターンは近似になる）。
 */
export function routineFromResult(resultJson: string | null): Routine | null {
  if (!resultJson) return null;
  let d: ResultJson;
  try { d = JSON.parse(resultJson) as ResultJson; } catch { return null; }
  const onBeat = d.routine?.timing ?? d.style?.onBeat;
  const timing: Routine['timing'] = onBeat === 'on1' || onBeat === 'on2' ? onBeat : 'unclear';
  const bpm = d.routine?.bpm ?? d.beatGrid?.bpm ?? null;

  if (Array.isArray(d.routine?.moves) && d.routine.moves.length) {
    const moves = d.routine.moves
      .filter((m) => m && typeof m.move === 'string')
      .map((m) => ({ ...m, move: (MOVE_IDS.has(m.move) ? m.move : 'other') as RoutineMoveId }));
    return moves.length ? { timing, bpm, moves } : null;
  }

  // 旧形式: 確定した技イベントを時刻順に並べ、間をベーシックで埋める
  const evs = (d.events ?? [])
    .filter((e) => e.verdict !== 'doubtful' && (e.type === 'CBL' || e.type === 'Turn'))
    .sort((a, b) => a.t - b.t);
  if (!evs.length) return null;
  const barSec = 8 * 60 / (bpm ?? BASE_BPM);
  const moves: RoutineMove[] = [];
  let lastEnd = evs[0].t;
  for (const e of evs) {
    if (e.t < lastEnd - 1e-6) continue;          // 同じ小節に入る2つ目は捨てる
    const gapBars = Math.min(4, Math.floor((e.t - lastEnd) / barSec));
    for (let i = 0; i < gapBars; i++) moves.push({ move: 'basic' });
    moves.push(e.type === 'CBL'
      ? { move: 'cbl', start: e.t }
      : {
        move: e.by === 'leader' ? 'leader_turn' : 'right_turn',
        name: e.by === 'leader' ? '男性のターン' : '女性のターン',
        start: e.t,
        turn: { by: e.by === 'leader' ? 'leader' : 'follower', rotations: e.rotations ?? 1 },
      });
    lastEnd = e.t + barSec;
  }
  return { timing, bpm, moves: [{ move: 'basic' }, ...moves, { move: 'basic' }] };
}
