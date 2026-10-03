import * as THREE from 'three';
import { L_FOREARM, SIDE_SIGN } from './rigDims';
import { clamp } from './coupleGuide';
import type { Rig } from './coupleSolver';
import { type Capsule, capsules, bodyCapsules, capDepth } from './rigMetrics';

/**
 * 計測用（一時）。リグが実際に作った腕の姿勢を胸郭ローカルで測る。
 * 見た目の不満は必ず数値にしてから直す — 目視で原因を決めると外す。
 * ブラウザで `__armProbe = 1` にすると 300 フレームごとに要約を console へ出す。
 */
type ArmStat = { elev: number[]; back: number[]; across: number[]; elbow: number[]; spd: number[] };
const newStat = (): ArmStat => ({ elev: [], back: [], across: [], elbow: [], spd: [] });
const armStats: Record<string, ArmStat> = {};
const armPrev: Record<string, THREE.Vector3> = {};
let armFrames = 0;
const mv = { u: new THREE.Vector3(), f: new THREE.Vector3(), q: new THREE.Quaternion() };
const pct = (a: number[], p: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN;

export function measureArms(rigs: [Rig, Rig], linked: (0 | 1 | null)[], dt: number) {
  const g = globalThis as unknown as { __armProbe?: number };
  if (!g.__armProbe) return;
  armFrames++;
  for (let d = 0; d < 2; d++) {
    for (let k = 0; k < 2; k++) {
      const sh = rigs[d].shldr[k], el = rigs[d].elbow[k];
      if (!sh || !el) continue;
      const key = `${d === 0 ? 'L' : 'F'}/${k === 0 ? '左' : '右'}${linked[d] === k ? '・つなぎ' : '・フリー'}`;
      const st = (armStats[key] ??= newStat());
      // 上腕の向き（胸郭ローカル）。ボーンの +Y が付け根向きなので -Y が上腕の伸びる先
      mv.u.set(0, -1, 0).applyQuaternion(sh.quaternion);
      st.elev.push((Math.acos(clamp(-mv.u.y, -1, 1)) * 180) / Math.PI); // 0=真下 180=真上
      st.back.push(mv.u.z);                                             // 負=肘が背中側
      st.across.push(mv.u.x * SIDE_SIGN[k]);                            // 負=体を横切る側
      // 肘の含む角（180=まっすぐ、0=完全に畳む）。過伸展は 180 超で出る
      st.elbow.push(180 - (el.rotation.x * 180) / Math.PI);
      const pv = (armPrev[key] ??= new THREE.Vector3(0, -1, 0));
      const ang = (Math.acos(clamp(pv.dot(mv.u), -1, 1)) * 180) / Math.PI;
      st.spd.push(dt > 1e-4 ? ang / dt : 0);                            // 上腕の角速度[deg/s]
      pv.copy(mv.u);
    }
  }
  if (armFrames % 300 !== 0) return;
  const rows = Object.entries(armStats).map(([key, s]) => ({
    腕: key,
    仰角中央: +pct(s.elev, 0.5).toFixed(0),
    仰角p95: +pct(s.elev, 0.95).toFixed(0),
    仰角max: +Math.max(...s.elev).toFixed(0),
    背中側率: +(s.back.filter((v) => v < -0.35).length / s.back.length).toFixed(2),
    横切り率: +(s.across.filter((v) => v < -0.35).length / s.across.length).toFixed(2),
    肘角min: +Math.min(...s.elbow).toFixed(0),
    肘角max: +Math.max(...s.elbow).toFixed(0),
    角速度p95: +pct(s.spd, 0.95).toFixed(0),
    角速度max: +Math.max(...s.spd).toFixed(0),
    // 手を上げているのに肘が下・後ろを向いている = 人体では起きない組み合わせ
    破綻率: +(s.elev.filter((v, i) => v > 100 && s.back[i] < -0.3).length / s.elev.length).toFixed(3),
  }));
  console.log(`[ARM] ${armFrames}フレーム`);
  console.table(rows);
}

/**
 * 計測用（一時）。**描画されたリグそのもの**の腕の座標と、体（見えているカプセル）への
 * 食い込みを時刻窓で吐く。ブラウザで `__armDump = [3.2, 3.6]`（クリップ秒）にすると、
 * 窓内の毎フレーム、肩・肘・手首のワールド座標と、上腕/前腕/手が
 * どちらの体をどれだけ抉っているか（depth 正 = 貫通[m]）を console.table に出す。
 * 貫通の犯人は目視ではなくこの数字で確定させる。
 */
const dv = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
/** 腕の部位カプセル（上腕/前腕/手）と、ある人の体カプセル群との最大の食い込み */
function limbDepth(limb: Capsule, body: Capsule[]) {
  let best = -Infinity;
  for (const c of body) best = Math.max(best, capDepth(limb, c));
  return best;
}

/**
 * URL クエリ `?armDump=3.2,3.6` の解釈（コンソールに触れない環境向け）。
 * 呼び出し側（CoupleFigure）が読んで、ソルバーへ dumpWindow として渡す
 */
export function parseDumpWindow(search: string): number | [number, number] | null {
  const q = new URLSearchParams(search).get('armDump');
  if (!q) return null;
  const p = q.split(',').map(Number).filter((v) => Number.isFinite(v));
  return p.length >= 2 ? ([p[0], p[1]] as [number, number]) : p.length === 1 ? p[0] : null;
}

export function dumpArms(
  rigs: [Rig, Rig], linked: (0 | 1 | null)[], t: number, hold: THREE.Vector3,
  dumpFromUrl: number | [number, number] | null,
) {
  const g = globalThis as unknown as { __armDump?: number | [number, number] };
  const w = g.__armDump ?? dumpFromUrl;
  if (w == null) return;
  const [t0, t1] = Array.isArray(w) ? w : [w - 0.2, w + 0.2];
  if (t < t0 || t > t1) return;
  // 同じ t でも damp の収束過程を見たいので全フレーム記録する（コンソールへは間引いて出す）
  const dg = globalThis as unknown as { __dumpLastT?: number; __dumpFrame?: number };
  dg.__dumpFrame = (dg.__dumpFrame ?? 0) + 1;
  const toConsole = dg.__dumpLastT !== t;
  dg.__dumpLastT = t;
  // 腕IKの後に呼ばれる。描画と同じ行列で測るため、ここで確定させる
  rigs[0].root.updateMatrixWorld(true);
  rigs[1].root.updateMatrixWorld(true);
  const rows: Record<string, unknown>[] = [];
  const f2 = (v: number) => +v.toFixed(3);
  for (let d = 0; d < 2; d++) {
    for (let k = 0; k < 2; k++) {
      const rig = rigs[d];
      rig.shldr[k].getWorldPosition(dv.a);
      rig.elbow[k].getWorldPosition(dv.b);
      dv.c.set(0, -L_FOREARM, 0);
      rig.elbow[k].localToWorld(dv.c);
      const row: Record<string, unknown> = {
        腕: `${d === 0 ? 'L' : 'F'}/${k === 0 ? '左' : '右'}${linked[d] === k ? '・つなぎ' : ''}`,
        肩: `${f2(dv.a.x)},${f2(dv.a.y)},${f2(dv.a.z)}`,
        肘: `${f2(dv.b.x)},${f2(dv.b.y)},${f2(dv.b.z)}`,
        手首: `${f2(dv.c.x)},${f2(dv.c.y)},${f2(dv.c.z)}`,
      };
      // 上腕・前腕・手それぞれを、両者の体カプセルと突き合わせる
      const limbs = capsules(rig, d as 0 | 1).filter((c) => c.side === k);
      for (let o = 0; o < 2; o++) {
        const body = bodyCapsules(rigs[o], o as 0 | 1);
        const who = o === d ? '自' : '相手';
        for (const [part, label] of [['upperarm', '上腕'], ['forearm', '前腕'], ['hand', '手']] as const) {
          const limb = limbs.find((c) => c.part === part)!;
          row[`${label}→${who}`] = f2(limbDepth(limb, body));
        }
      }
      rows.push(row);
    }
  }
  const head = `[DUMP] t=${t.toFixed(3)} rootL=(${f2(rigs[0].root.position.x)},${f2(rigs[0].root.position.z)}) rootF=(${f2(rigs[1].root.position.x)},${f2(rigs[1].root.position.z)}) hold=(${f2(hold.x)},${f2(hold.y)},${f2(hold.z)})`;
  if (toConsole) { console.log(head); console.table(rows); }
  // コンソールが読めない環境向けに配列にも積む（最大500件で頭から捨てる）
  const sink = ((globalThis as unknown as { __dumpOut?: unknown[] }).__dumpOut ??= []);
  sink.push({ head, rows });
  if (sink.length > 500) sink.splice(0, sink.length - 500);
}
