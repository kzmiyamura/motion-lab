import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import type { MotionClip } from '../components/MocapFigure';
import { buildScriptedBasic, buildScriptedCBL } from '../engine/scriptedClip';
import { composeRoutine } from '../engine/routineClip';
import { CoupleSolver, buildRigObjects, type Rig } from '../engine/coupleSolver';
import {
  penetrations, jointAngles, limitExcess, holdGap, wristWorld,
  PEN_CATEGORIES, LIMIT_KEYS, type PenCategory, type LimitKey, type PenHit,
} from '../engine/rigMetrics';

/**
 * リグの品質ラチェット。全クリップを固定 dt（1/60 秒）で回し、1周目は助走として捨て、
 * 2周目を採点する。数字は rigQuality.baseline.json と比べて**悪くなったら落ちる**。
 *
 * - 貫通: 見えている体のカプセルどうしの食い込み（2cm 超のフレーム率・最大・p95）
 * - 可動域: 関節角が人体の範囲を超えたサンプル率と最大超過量（丸めはしていない。測るだけ）
 * - つないだ手の離れ（最大）
 * - 不変量: 腰・脚・胴・頭の関節位置がスナップショット（rigSnapshot.json）と一致すること
 *   （腕の作業で脚が動いたら落ちる）。腕の関節もスナップショットと比べる
 *
 * 更新: `UPDATE_RIG=arms npx vitest run src/__tests__/rigQuality.test.ts`
 *   → 指標の基準と腕のスナップショットを書き直す（意図して腕を変えたとき）。
 *   `UPDATE_RIG=all` は体（脚・腰）のスナップショットも書き直す（脚を意図して変えたときだけ）。
 * 詳細: `RIG_REPORT=<path>` で全指標・最悪フレームを JSON に書き出す。
 */

const DT = 1 / 60;
const BASE = resolve(__dirname, 'rigQuality.baseline.json');
const SNAP = resolve(__dirname, 'rigSnapshot.json');
const LIFT = resolve(__dirname, '../../server/storage/lift3d');
const UPDATE = process.env.UPDATE_RIG ?? '';

type Cfg = { name: string; build: () => MotionClip; snapEvery: number };
function configs(): Cfg[] {
  const out: Cfg[] = [];
  for (const timing of ['on1', 'on2'] as const) {
    for (const closed of [false, true]) {
      const h = closed ? 'closed' : 'open';
      out.push({ name: `basic-${timing}-${h}`, build: () => buildScriptedBasic(timing, closed), snapEvery: 30 });
      out.push({ name: `cbl-${timing}-${h}`, build: () => buildScriptedCBL(timing, closed), snapEvery: 30 });
      for (const bpm of [170, 200]) {
        out.push({
          name: `routine-${timing}-${h}-${bpm}`,
          build: () => composeRoutine({
            timing, bpm,
            moves: [{ move: 'basic' }, { move: 'cbl' }, { move: 'basic' }, { move: 'cbl' }, { move: 'basic' }],
          }, closed).clip,
          snapEvery: 120,
        });
      }
    }
  }
  if (existsSync(LIFT)) {
    for (const f of readdirSync(LIFT).filter((n) => n.endsWith('_clip.json')).sort()) {
      out.push({
        name: `lift3d-${f.replace('_clip.json', '')}`,
        build: () => JSON.parse(readFileSync(resolve(LIFT, f), 'utf-8')) as MotionClip,
        snapEvery: 120,
      });
    }
  }
  return out;
}

const BODY_KEYS = ['root', 'hips', 'spine', 'head', 'thigh', 'knee', 'foot'] as const;
const v = new THREE.Vector3();
function bodyPts(rig: Rig): number[] {
  const out: number[] = [];
  for (const o of [rig.root, rig.hips, rig.spine, rig.head, ...rig.thigh, ...rig.knee, ...rig.foot]) {
    o.getWorldPosition(v); out.push(v.x, v.y, v.z);
  }
  return out;
}
function armPts(rig: Rig): number[] {
  const out: number[] = [];
  for (const o of [...rig.shldr, ...rig.elbow]) { o.getWorldPosition(v); out.push(v.x, v.y, v.z); }
  for (const k of [0, 1]) { wristWorld(rig, k, v); out.push(v.x, v.y, v.z); }
  return out;
}
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

type Stat = { rate: number; max: number; p95: number };
type Metrics = {
  frames: number;
  pen: Record<PenCategory, Stat>;
  limits: Record<LimitKey, { rate: number; max: number }>;
  holdGapMax: number;
};
type Worst = { t: number; hit: PenHit | null };
type Result = {
  metrics: Metrics;
  snap: { body: number[][]; arms: number[][] };
  worst: Record<PenCategory, Worst>;
  closedNeutral: number[][];   // クローズド中のフォロワーの左手（胸郭ローカル）の手首位置
};

const pctl = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const cm = (m: number) => Math.round(m * 1000) / 10;      // [m] → [cm] 0.1 刻み
const rate = (x: number) => Math.round(x * 10000) / 10000;
const deg = (x: number) => Math.round(x * 10) / 10;

function simulate(clip: MotionClip, snapEvery: number): Result {
  const solver = new CoupleSolver(clip, { keyPose: true });
  const rigs: [Rig, Rig] = [buildRigObjects(), buildRigObjects()];
  const n = Math.ceil(clip.duration / DT);
  const pen: Record<PenCategory, number[]> = { armPartner: [], armSelf: [], legPartner: [], legSelf: [] };
  const worst = Object.fromEntries(PEN_CATEGORIES.map((c) => [c, { t: 0, hit: null, d: -1 }])) as
    unknown as Record<PenCategory, Worst & { d: number }>;
  const lim = Object.fromEntries(LIMIT_KEYS.map((k) => [k, { n: 0, out: 0, max: 0 }])) as
    Record<LimitKey, { n: number; out: number; max: number }>;
  let gapMax = 0;
  const snap = { body: [] as number[][], arms: [] as number[][] };
  const closedNeutral: number[][] = [];
  for (let i = 0; i < 2 * n; i++) {
    const t = (i * DT) % clip.duration;
    solver.step(rigs, t, DT);
    if (i < n) continue;                  // 1周目は助走
    rigs[0].root.updateMatrixWorld(true);
    rigs[1].root.updateMatrixWorld(true);
    const m = i - n;
    if (m % snapEvery === 0) {
      snap.body.push([...bodyPts(rigs[0]), ...bodyPts(rigs[1])].map(r5));
      snap.arms.push([...armPts(rigs[0]), ...armPts(rigs[1])].map(r5));
    }
    if (!rigs[0].root.visible || !rigs[1].root.visible) continue;
    const out = solver.out;
    const hits: PenHit[] = [];
    const p = penetrations(rigs, { closedBack: out.closedL }, hits);
    for (const c of PEN_CATEGORIES) {
      pen[c].push(Math.max(0, p[c]));
      if (p[c] > worst[c].d) {
        worst[c].d = p[c]; worst[c].t = t;
        worst[c].hit = hits.filter((h) => h.cat === c).sort((a, b) => b.depth - a.depth)[0] ?? null;
      }
    }
    for (const rig of rigs) {
      for (const [k, ex] of limitExcess(jointAngles(rig))) {
        const s = lim[k];
        s.n++;
        if (ex > 0) { s.out++; s.max = Math.max(s.max, ex); }
      }
    }
    const g = holdGap(rigs, out.linked);
    if (g !== null) gapMax = Math.max(gapMax, g);
    if (out.closedF >= 0) {
      wristWorld(rigs[1], out.closedF, v);
      rigs[1].spine.worldToLocal(v);
      closedNeutral.push([v.x, v.y, v.z]);
    }
  }
  const frames = pen.armPartner.length;
  const metrics: Metrics = {
    frames,
    pen: Object.fromEntries(PEN_CATEGORIES.map((c) => [c, {
      rate: rate(pen[c].filter((d) => d > 0.02).length / Math.max(1, frames)),
      max: cm(Math.max(0, ...pen[c])),
      p95: cm(pctl(pen[c], 0.95)),
    }])) as Record<PenCategory, Stat>,
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, {
      rate: rate(lim[k].out / Math.max(1, lim[k].n)), max: deg(lim[k].max),
    }])) as Metrics['limits'],
    holdGapMax: cm(gapMax),
  };
  const w = Object.fromEntries(PEN_CATEGORIES.map((c) => [c, { t: worst[c].t, hit: worst[c].hit }]));
  return { metrics, snap, worst: w as Record<PenCategory, Worst>, closedNeutral };
}

// ── 全構成を1回だけ回す（スナップショットとラチェットで共有）
const results = new Map<string, Result>();
const cfgs = configs();
for (const c of cfgs) results.set(c.name, simulate(c.build(), c.snapEvery));

type SnapFile = Record<string, { body: number[][]; arms: number[][] }>;
type BaseFile = Record<string, Metrics>;
const readJson = <T,>(p: string): T | null => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as T : null);

if (UPDATE) {
  const prevSnap = readJson<SnapFile>(SNAP) ?? {};
  const snap: SnapFile = {};
  const base: BaseFile = {};
  for (const [name, r] of results) {
    snap[name] = {
      // 体（脚・腰）は UPDATE_RIG=all のときだけ書き直す。腕の作業で脚の基準を動かさない
      body: UPDATE === 'all' || !prevSnap[name] ? r.snap.body : prevSnap[name].body,
      arms: r.snap.arms,
    };
    base[name] = r.metrics;
  }
  writeFileSync(SNAP, JSON.stringify(snap));
  writeFileSync(BASE, JSON.stringify(base, null, 1) + '\n');
}
if (process.env.RIG_REPORT) {
  const rep: Record<string, unknown> = {};
  for (const [name, r] of results) {
    const cn = r.closedNeutral;
    const mean = cn.length ? [0, 1, 2].map((a) => cn.reduce((s, p) => s + p[a], 0) / cn.length) : null;
    rep[name] = { metrics: r.metrics, worst: r.worst, closedNeutralMean: mean };
  }
  writeFileSync(process.env.RIG_REPORT, JSON.stringify(rep, null, 1));
}

const maxDiff = (a: number[][], b: number[][]) => {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (let k = 0; k < a[i].length; k++) m = Math.max(m, Math.abs(a[i][k] - b[i][k]));
  }
  return a.length === b.length ? m : Infinity;
};

describe('リグのスナップショット（リファクタの番人）', () => {
  const snap = readJson<SnapFile>(SNAP);
  for (const c of cfgs) {
    it.skipIf(!snap?.[c.name])(`${c.name}: 腰・脚・胴・頭はスナップショットと一致（0.0cm）`, () => {
      expect(maxDiff(results.get(c.name)!.snap.body, snap![c.name].body)).toBeLessThan(2e-4);
    });
    it.skipIf(!snap?.[c.name])(`${c.name}: 腕もスナップショットと一致`, () => {
      expect(maxDiff(results.get(c.name)!.snap.arms, snap![c.name].arms)).toBeLessThan(2e-4);
    });
  }
  it('関節の並び（体）', () => {
    expect(BODY_KEYS.length).toBe(7);
  });
});

describe('リグ品質のラチェット（基準より悪くならない）', () => {
  const base = readJson<BaseFile>(BASE);
  const TOL_RATE = 0.002, TOL_CM = 0.1, TOL_DEG = 0.2;
  for (const c of cfgs) {
    it.skipIf(!base?.[c.name])(c.name, () => {
      const cur = results.get(c.name)!.metrics, b = base![c.name];
      const worse: string[] = [];
      for (const cat of PEN_CATEGORIES) {
        const x = cur.pen[cat], y = b.pen[cat];
        if (x.rate > y.rate + TOL_RATE) worse.push(`${cat}.rate ${y.rate} → ${x.rate}`);
        if (x.max > y.max + TOL_CM) worse.push(`${cat}.max ${y.max} → ${x.max}cm`);
        if (x.p95 > y.p95 + TOL_CM) worse.push(`${cat}.p95 ${y.p95} → ${x.p95}cm`);
      }
      for (const k of LIMIT_KEYS) {
        const x = cur.limits[k], y = b.limits[k];
        if (x.rate > y.rate + TOL_RATE) worse.push(`${k}.rate ${y.rate} → ${x.rate}`);
        if (x.max > y.max + TOL_DEG) worse.push(`${k}.max ${y.max} → ${x.max}°`);
      }
      if (cur.holdGapMax > b.holdGapMax + TOL_CM) worse.push(`holdGapMax ${b.holdGapMax} → ${cur.holdGapMax}cm`);
      expect(worse, worse.join('\n')).toEqual([]);
    });
  }
});
