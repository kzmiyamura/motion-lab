import type { MotionClip, ArmSegment } from '../components/MocapFigure';
import { L_UPARM, L_FOREARM } from './rigDims';

/**
 * CoupleFigure のガイド（クリップから信頼できる量だけを抜き出した時系列）と、
 * その時刻サンプリング。three には触らない純粋なデータ処理。
 */

// クリップの joints 並び（MocapFigure の J と同じ）
const LSHO = 1, RSHO = 2, LWRI = 5, RWRI = 6, LHIP = 7, RHIP = 8;
const LANK = 11, RANK = 12, LEAR = 13, REAR = 14, LTOE = 17, RTOE = 18;

// ペアの距離拘束[m]。弱透視の奥行き誤差で2人が重なる/離れすぎるのを止める。
// 2fda2815 実測: 腰中点の距離は median 0.67m だが min 0.05m・28%が0.5m未満で、
// 人体では起こりえない値が出る（復元の限界であって振付ではない）。
// 重心は動かさないので、振付の床の使い方は保たれる
// 上限は「手をつなげる距離」で決まる: 肩からホールド点までが腕の長さを超えたら
// どう解いても手は離れる。腕 0.55m × 2 を少し内側に取る
export const PAIR_MIN = 0.58, PAIR_MAX = 1.02;
// クローズドで組んでいる間だけ下限を外す。腰の間隔 0.30m は「男の腕（0.52m）が
// 女の背中に届く距離」として逆算した**振付の値**で、観測の復元誤差ではない。
// 0.58 に押し戻すと男の右肩から女の背中まで 0.775m になり、腕は 0.522m しか無いので
// 手が 25cm 手前（女の腹の前）で止まる = 「背中に手が回っていない」の正体。
// 手描きクリップの closed 区間にだけ効くので、CBL の通り抜けや動画は従来どおり
const PAIR_MIN_CLOSED = 0.20;
export const ARM_REACH = (L_UPARM + L_FOREARM) * 0.95;
// つないだ手の追従の鈍らせ量（0 = 即時）。腕ごとではなく共有点の側で鈍らせる
export const HOLD_LAG = 0.5;

export const damp = (cur: number, target: number, k: number) => cur + (target - cur) * k;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const wrapPi = (a: number) => {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
};

/** 移動平均（端は窓を縮める）。動線として見せるための平滑化 */
function smooth(src: number[], win: number): Float32Array {
  const out = new Float32Array(src.length);
  const h = Math.floor(win / 2);
  for (let i = 0; i < src.length; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(src.length - 1, i + h); k++) {
      s += src[k]; n++;
    }
    out[i] = s / n;
  }
  return out;
}

/** 中央値フィルタ。1〜2フレームだけ飛ぶ復元ノイズは、平均で均すと周りへ広がるだけで消えない */
function median(src: number[], win: number): number[] {
  const out = new Array<number>(src.length);
  const h = Math.floor(win / 2);
  const buf: number[] = [];
  for (let i = 0; i < src.length; i++) {
    buf.length = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(src.length - 1, i + h); k++) buf.push(src[k]);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

/**
 * 水平の移動を人が出せる速さへ頭打ちにする（前向き・後ろ向きの2回を平均して遅れを片寄らせない）。
 *
 * 弱透視では 横位置 X = (u - cx)·Z/f なので、**奥行き Z の推定が飛ぶと横位置も一緒に飛ぶ**。
 * 実測では腰の奥行きが最大 47m/s・全体の 20〜27% のフレームで 3m/s（人の歩速）を超えており、
 * これは踊りではなく復元ノイズ。平均で均すと隣のフレームへ広がるだけなので、速度で止める。
 */
const MAX_ROOT_SPEED = 3.5;   // [m/s] ダンサーの重心が床の上で出せる速さ

function limitSpeed(xs: number[], zs: number[], ts: number[], maxSpeed: number) {
  const pass = (fwd: boolean) => {
    const ox = xs.slice(), oz = zs.slice();
    for (let s = 1; s < ox.length; s++) {
      const i = fwd ? s : ox.length - 1 - s, p = fwd ? i - 1 : i + 1;
      const dt = Math.abs(ts[i] - ts[p]);
      if (!(dt > 1e-6 && dt < 0.5)) continue;
      const dx = ox[i] - ox[p], dz = oz[i] - oz[p];
      const len = Math.hypot(dx, dz), max = maxSpeed * dt;
      if (len > max) {
        const k = max / len;
        ox[i] = ox[p] + dx * k; oz[i] = oz[p] + dz * k;
      }
    }
    return [ox, oz] as const;
  };
  const [fx, fz] = pass(true), [bx, bz] = pass(false);
  return [
    fx.map((v, i) => (v + bx[i]) / 2),
    fz.map((v, i) => (v + bz[i]) / 2),
  ] as const;
}

/** 値 + 信頼度のチャンネル。信頼度は手続きアニメとの混ぜ率になる */
type Chan = { v: Float32Array; w: Float32Array };
/** 足首の目標（体ローカル座標。y は床基準の絶対高さ） */
type AnkleChan = { x: Float32Array; y: Float32Array; z: Float32Array; w: Float32Array };

export type Guide = {
  ts: Float32Array;
  x: Float32Array;
  z: Float32Array;
  yaw: Float32Array;   // 骨盤のヨー。unwrap + 平滑化済み
  speed: Float32Array; // 平滑化後の水平速度 [m/s]
  hipY: Float32Array;  // 実データの腰の高さ（沈み込みがそのまま出る）
  twist: Chan;         // 骨盤に対する胸郭の相対ヨー = 上体のねじれ
  headYaw: Chan;       // 骨盤に対する頭の相対ヨー = スポッティング
  ank: [AnkleChan, AnkleChan];  // [左, 右]
  footYaw: [Chan, Chan];
  wri: [AnkleChan, AnkleChan];  // 手首の目標。足首と同じ形（体ローカル + 床基準の y）
};

// 手の速さの上限[m/s]。これを超える1フレーム移動は復元ノイズ（実測 p95 で 10m/s 超が出る）
const MAX_HAND_SPEED = 5.0;
// 欠測を速度ベクトルで伸ばす時間[s]と、その間に許す最大変位[m]。
// 手首の穴は median 48〜96ms なので、これで大半は実データの続きで埋まる
const EXTRAP_SEC = 0.25, EXTRAP_MAX = 0.25;

/**
 * 欠測を「直前の速度ベクトルの続き」で埋める。位置を保持するだけだと手が空中で止まり、
 * 0 に落とすと消える。**人の手は急に止まらない**ので、出ていた方向へ伸ばして
 * 信頼度だけを落とし、手続きアニメ／ホールド点へ滑らかに明け渡す。
 */
function fillByVelocity(a: { x: number[]; y: number[]; z: number[]; w: number[] }, ts: number[]) {
  let last = -1;                      // 直前に実観測できた index
  let vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < ts.length; i++) {
    if (a.w[i] > 0) {
      if (last >= 0) {
        const dt = ts[i] - ts[last];
        if (dt > 1e-6 && dt < 0.5) {
          vx = (a.x[i] - a.x[last]) / dt;
          vy = (a.y[i] - a.y[last]) / dt;
          vz = (a.z[i] - a.z[last]) / dt;
          const sp = Math.hypot(vx, vy, vz);
          if (sp > MAX_HAND_SPEED) { const k = MAX_HAND_SPEED / sp; vx *= k; vy *= k; vz *= k; }
        }
      }
      last = i;
      continue;
    }
    if (last < 0) continue;
    const dt = ts[i] - ts[last];
    if (dt > EXTRAP_SEC) continue;    // 長い穴は手続き側へ渡す（w=0 のまま）
    const k = Math.min(1, EXTRAP_MAX / (Math.hypot(vx, vy, vz) * dt || 1e-6));
    a.x[i] = a.x[last] + vx * dt * k;
    a.y[i] = a.y[last] + vy * dt * k;
    a.z[i] = a.z[last] + vz * dt * k;
    a.w[i] = 1 - dt / EXTRAP_SEC;     // 伸ばすほど信頼度を落とす
  }
}

/**
 * クリップから信頼できる量だけを抜き出す。
 * 観測が無いフレームは直前の値を保持し、信頼度 0 を立てて呼び出し側に判断させる
 * （0 に落とすと平滑化がそこへ引っぱられて偽の動きが出る）。
 */
export function buildGuide(clip: MotionClip, pid: number): Guide {
  const ts: number[] = [], xs: number[] = [], zs: number[] = [], yaws: number[] = [];
  const hipYs: number[] = [];
  const hYaw: number[] = [], hYawW: number[] = [];
  const twists: number[] = [], twistW: number[] = [];
  const mkA = () => ({ x: [] as number[], y: [] as number[], z: [] as number[], w: [] as number[] });
  const aRaw = [mkA(), mkA()];
  const wRaw = [mkA(), mkA()];
  const fRaw = [{ v: [] as number[], w: [] as number[] }, { v: [] as number[], w: [] as number[] }];
  let prevYaw: number | null = null;

  // 19関節クリップでのみ取れる関節。旧13関節クリップは手続きアニメだけで踊る
  const ext = clip.joints.length >= 19;
  const last = <T,>(a: T[], fb: T): T => (a.length ? a[a.length - 1] : fb);

  for (const f of clip.frames) {
    const p = f.p[String(pid)];
    if (!p) continue;
    const j = p.j, v = p.v;
    if (v[LHIP] <= 0 || v[RHIP] <= 0) continue;
    const hx = (j[LHIP * 3] + j[RHIP * 3]) / 2;
    const hy = (j[LHIP * 3 + 1] + j[RHIP * 3 + 1]) / 2;
    const hz = (j[LHIP * 3 + 2] + j[RHIP * 3 + 2]) / 2;
    // 向き: 腰ライン（左→右）に垂直な水平ベクトル = up × (rHip - lHip)。
    // up × (dx,0,dz) = (dz, 0, -dx) が前方。three の rotation.y=θ は前方 (sinθ, cosθ)
    const dx = j[RHIP * 3] - j[LHIP * 3];
    const dz = j[RHIP * 3 + 2] - j[LHIP * 3 + 2];
    let yaw = Math.atan2(dz, -dx);
    if (prevYaw !== null) {
      // unwrap: 直前との差が最短になる分岐を選ぶ（連続ターンで一周が消えないように）
      while (yaw - prevYaw > Math.PI) yaw -= Math.PI * 2;
      while (yaw - prevYaw < -Math.PI) yaw += Math.PI * 2;
    }
    prevYaw = yaw;

    // 胸のヨーは肩ラインから同じ式で出す。**腰と平均してはいけない** —
    // サルサの見た目は骨盤と胸郭の「ねじれ差」そのもので、平均するとそれが消える。
    // 胸椎の回旋は片側 40〜50度が限界なので、それを超える値は復元ノイズとして頭打ち
    if (v[LSHO] > 0 && v[RSHO] > 0) {
      const sx = j[RSHO * 3] - j[LSHO * 3], sz = j[RSHO * 3 + 2] - j[LSHO * 3 + 2];
      twists.push(clamp(wrapPi(Math.atan2(sz, -sx) - yaw), -0.8, 0.8));
      twistW.push(Math.min(v[LSHO], v[RSHO]) >= 1 ? 1 : 0.5);
    } else {
      twists.push(last(twists, 0)); twistW.push(0);
    }

    ts.push(f.t); xs.push(hx); zs.push(hz); yaws.push(yaw);
    hipYs.push(clamp(hy, 0.55, 1.15));

    // ワールド → 体ローカル（腰中点が原点・前方が +Z）
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const toLocal = (wx: number, wz: number): [number, number] => {
      const dX = wx - hx, dZ = wz - hz;
      return [dX * cy - dZ * sy, dX * sy + dZ * cy];
    };

    // ── 頭の向き（スポッティング）: 耳ラインは肩ラインと同じ式で前方が出る
    if (ext && v[LEAR] > 0 && v[REAR] > 0) {
      const ex = j[REAR * 3] - j[LEAR * 3], ez = j[REAR * 3 + 2] - j[LEAR * 3 + 2];
      // 首の可動域を超える値は復元ノイズなので頭打ちにする
      hYaw.push(clamp(wrapPi(Math.atan2(ez, -ex) - yaw), -1.35, 1.35));
      hYawW.push(Math.min(v[LEAR], v[REAR]) >= 1 ? 1 : 0.5);
    } else {
      hYaw.push(last(hYaw, 0)); hYawW.push(0);
    }

    // ── 足首（脚IKの目標）と足の向き
    const foot = (ankIdx: number, toeIdx: number, s: 0 | 1) => {
      const dst = aRaw[s], fv = fRaw[s].v, fw = fRaw[s].w;
      if (v[ankIdx] > 0) {
        const [lx, lz] = toLocal(j[ankIdx * 3], j[ankIdx * 3 + 2]);
        dst.x.push(lx); dst.y.push(j[ankIdx * 3 + 1]); dst.z.push(lz);
        dst.w.push(v[ankIdx] >= 1 ? 1 : 0.55);
      } else {
        dst.x.push(last(dst.x, 0)); dst.y.push(last(dst.y, 0.05));
        dst.z.push(last(dst.z, 0)); dst.w.push(0);
      }
      const toeOk = ext && v[ankIdx] > 0 && v[toeIdx] > 0;
      const fx = toeOk ? j[toeIdx * 3] - j[ankIdx * 3] : 0;
      const fz = toeOk ? j[toeIdx * 3 + 2] - j[ankIdx * 3 + 2] : 0;
      if (toeOk && Math.hypot(fx, fz) > 0.03) {
        fv.push(clamp(wrapPi(Math.atan2(fx, fz) - yaw), -1.2, 1.2));
        fw.push(Math.min(v[ankIdx], v[toeIdx]) >= 1 ? 1 : 0.5);
      } else {
        fv.push(last(fv, 0)); fw.push(0);
      }
    };
    foot(LANK, LTOE, 0);
    foot(RANK, RTOE, 1);

    // ── 手首（腕IKの目標）。**腕こそ見たいところ**なので、観測できたフレームは
    // 手続きアニメではなく実データを使う。肩から腕の長さを超える点は復元ノイズなので捨てる
    const hand = (wIdx: number, shIdx: number, s: 0 | 1) => {
      const dst = wRaw[s];
      const reach = v[wIdx] > 0 && v[shIdx] > 0
        ? Math.hypot(j[wIdx * 3] - j[shIdx * 3], j[wIdx * 3 + 1] - j[shIdx * 3 + 1],
          j[wIdx * 3 + 2] - j[shIdx * 3 + 2])
        : -1;
      if (reach >= 0.08 && reach <= 0.62) {
        const [lx, lz] = toLocal(j[wIdx * 3], j[wIdx * 3 + 2]);
        dst.x.push(lx); dst.y.push(j[wIdx * 3 + 1]); dst.z.push(lz);
        dst.w.push(v[wIdx] >= 1 ? 1 : 0.5);
      } else {
        dst.x.push(last(dst.x, 0)); dst.y.push(last(dst.y, 1.1));
        dst.z.push(last(dst.z, 0.1)); dst.w.push(0);
      }
    };
    hand(LWRI, LSHO, 0);
    hand(RWRI, RSHO, 1);
  }

  // 手首の穴は速度ベクトルで少しだけ伸ばしてから均す（平滑化の前にやること —
  // 保持したままの値を均すと、止まっている手が正しいかのように見えてしまう）
  fillByVelocity(wRaw[0], ts);
  fillByVelocity(wRaw[1], ts);

  // 単発の飛びを中央値で潰し、残りを人の速さへ頭打ちにしてから均す
  const [lx, lz] = limitSpeed(median(xs, 5), median(zs, 5), ts, MAX_ROOT_SPEED);
  const x = smooth(lx, 7), z = smooth(lz, 7), yaw = smooth(yaws, 7);
  const speed = new Float32Array(ts.length);
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    speed[i] = dt > 1e-6 && dt < 0.5
      ? Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]) / dt
      : speed[i - 1];
  }
  // 信頼度は値より広い窓で均す = 手続きアニメとの切り替わりが滑らかになる
  const chan = (c: { v: number[]; w: number[] }): Chan => ({ v: smooth(c.v, 5), w: smooth(c.w, 11) });
  const ank = (a: ReturnType<typeof mkA>): AnkleChan => ({
    x: smooth(a.x, 5), y: smooth(a.y, 5), z: smooth(a.z, 5), w: smooth(a.w, 11),
  });
  const wch = (a: ReturnType<typeof mkA>): AnkleChan => ({
    x: smooth(a.x, 3), y: smooth(a.y, 3), z: smooth(a.z, 3), w: smooth(a.w, 5),
  });

  return {
    ts: new Float32Array(ts), x, z, yaw, speed: smooth(Array.from(speed), 5),
    hipY: smooth(hipYs, 7),
    twist: chan({ v: twists, w: twistW }),
    headYaw: chan({ v: hYaw, w: hYawW }),
    ank: [ank(aRaw[0]), ank(aRaw[1])],
    footYaw: [chan(fRaw[0]), chan(fRaw[1])],
    // 手首は足首より窓を狭くする。信頼度を広く均すと、観測できているフレームまで
    // 手続きアニメと半々に薄まって、せっかくの実データが見えなくなる
    wri: [wch(wRaw[0]), wch(wRaw[1])],
  };
}

/**
 * ペアの**相対位置**だけを別に解くガイド。
 *
 * 単眼の弱透視では奥行き(z)が推定なので、実際には横に並んでいる2人が
 * 「前後に並んでいる」ことになるフレームが出る。2D原盤と突き合わせると、
 * **画像では画面幅の15%以上離れているのに3Dでは20cm未満まで重なるフレームが9%**あり、
 * 失われた左右差はそのぶん奥行きに化けていた（重なって見える＝何をしているか読めない）。
 *
 * 直し方は人体・物理の側から: **手をつないだ2人の相対の向きは、人が回り込める速さより
 * 速く変わらない**。実測でも 7% のフレームが 720deg/s を超えており（最大 5941deg/s =
 * 毎秒16回転）、これは踊りではなく復元ノイズ。中央値フィルタ＋角速度の頭打ちで潰す。
 *
 * 重心（2人の中点）は実データのまま動かさないので、振付の床の使い方は保たれる。
 */
export type PairGuide = {
  ts: Float32Array; cx: Float32Array; cz: Float32Array;
  th: Float32Array;  // 相対位置の向き（unwrap 済み）
  d: Float32Array;   // 2人の距離
};
const MAX_PAIR_TURN = Math.PI * 4;   // [rad/s] = 720deg/s。人が相手を回り込める上限

/**
 * この時刻のペア距離の下限[m]。手描きクリップのクローズド区間だけ下限を外す
 * （そこだけは距離そのものが振付。理由は PAIR_MIN_CLOSED のコメント）。
 */
function pairFloorAt(clip: MotionClip, t: number): number {
  const segs = clip.armTimeline?.source === 'scripted' ? clip.armTimeline.segments : null;
  if (!segs) return PAIR_MIN;
  let cur: ArmSegment | null = null;
  for (const s of segs) { if (s.t0 <= t) cur = s; else break; }
  return cur?.phase === 'closed' ? PAIR_MIN_CLOSED : PAIR_MIN;
}

export function buildPair(clip: MotionClip, pid0: number, pid1: number): PairGuide {
  const ts: number[] = [], cx: number[] = [], cz: number[] = [];
  const th: number[] = [], d: number[] = [], floor: number[] = [];
  let prev: number | null = null;
  for (const f of clip.frames) {
    const a = f.p[String(pid0)], b = f.p[String(pid1)];
    if (!a || !b) continue;
    if (a.v[LHIP] <= 0 || a.v[RHIP] <= 0 || b.v[LHIP] <= 0 || b.v[RHIP] <= 0) continue;
    const ax = (a.j[LHIP * 3] + a.j[RHIP * 3]) / 2, az = (a.j[LHIP * 3 + 2] + a.j[RHIP * 3 + 2]) / 2;
    const bx = (b.j[LHIP * 3] + b.j[RHIP * 3]) / 2, bz = (b.j[LHIP * 3 + 2] + b.j[RHIP * 3 + 2]) / 2;
    const dx = bx - ax, dz = bz - az;
    let a2 = Math.atan2(dz, dx);
    if (prev !== null) {
      while (a2 - prev > Math.PI) a2 -= Math.PI * 2;
      while (a2 - prev < -Math.PI) a2 += Math.PI * 2;
    }
    prev = a2;
    ts.push(f.t); cx.push((ax + bx) / 2); cz.push((az + bz) / 2);
    th.push(a2); d.push(Math.hypot(dx, dz)); floor.push(pairFloorAt(clip, f.t));
  }

  // 単発の飛びを中央値で潰してから、残った速すぎる回り込みを頭打ちにする。
  // 前向き・後ろ向きの2回かけて平均する（片方向だけだと遅れが片側に偏る）
  const th1 = median(th, 5);
  const limit = (src: number[], fwd: boolean) => {
    const out = src.slice();
    const n = out.length;
    for (let s = 1; s < n; s++) {
      const i = fwd ? s : n - 1 - s, p = fwd ? i - 1 : i + 1;
      const dt = Math.abs(ts[i] - ts[p]);
      if (!(dt > 1e-6 && dt < 0.5)) continue;
      const max = MAX_PAIR_TURN * dt;
      out[i] = clamp(out[i], out[p] - max, out[p] + max);
    }
    return out;
  };
  const f1 = limit(th1, true), b1 = limit(th1, false);
  const th2 = th1.map((_, i) => (f1[i] + b1[i]) / 2);

  const [lcx, lcz] = limitSpeed(median(cx, 5), median(cz, 5), ts, MAX_ROOT_SPEED);
  return {
    ts: new Float32Array(ts),
    cx: smooth(lcx, 7), cz: smooth(lcz, 7),
    th: smooth(th2, 7),
    d: smooth(median(d, 5).map((v, i) => clamp(v, floor[i], PAIR_MAX)), 7),
  };
}

// ── ガイドのサンプリング（人物ごとにカーソルを持つ）
export type Sample = { i: number; i2: number; w: number; inRange: boolean };
export function sampleAt(g: { ts: Float32Array }, t: number, cur: { current: number }): Sample {
  if (g.ts.length < 2) return { i: 0, i2: 0, w: 0, inRange: false };
  let i = cur.current;
  if (i >= g.ts.length) i = g.ts.length - 1;
  while (i > 0 && g.ts[i] > t) i--;
  while (i < g.ts.length - 1 && g.ts[i + 1] <= t) i++;
  cur.current = i;
  const i2 = Math.min(i + 1, g.ts.length - 1);
  const gap = g.ts[i2] - g.ts[i];
  // 欠測で間隔が開いた区間は補間せず手前の値を保持（無い移動を作らない）
  const w = gap > 1e-6 && gap < 0.5 ? clamp((t - g.ts[i]) / gap, 0, 1) : 0;
  return { i, i2, w, inRange: t >= g.ts[0] - 0.4 && t <= g.ts[g.ts.length - 1] + 0.4 };
}
export const at = (s: Sample, a: Float32Array) => a[s.i] * (1 - s.w) + a[s.i2] * s.w;

// ── ホールド（つないでいる手）のタイムライン。0=左手, 1=右手。null=手を離している
export type Hold = { t: number; leader: 0 | 1 | null; follower: 0 | 1 | null };
export function buildHolds(clip: MotionClip): Hold[] {
  const out: Hold[] = [];
  for (const ev of [...clip.events].sort((a, b) => a.t - b.t)) {
    // hold が null のイベントは「この瞬間は手をつないでいない」という観測結果。
    // 読み飛ばすと直前のホールドが続き、開いて踊る区間でも手が繋がったままになる
    if (ev.hold === null || ev.hold === undefined) {
      out.push({ t: ev.t, leader: null, follower: null });
      continue;
    }
    const l = /リーダー(右|左)手/.exec(ev.hold);
    const f = /フォロワー(右|左)手/.exec(ev.hold);
    if (!l || !f) continue;
    out.push({ t: ev.t, leader: l[1] === '右' ? 1 : 0, follower: f[1] === '右' ? 1 : 0 });
  }
  // 最初のイベント以前も同じホールドで踊っているものとして前へ伸ばす
  if (out.length) out[0] = { ...out[0], t: -1e9 };
  return out;
}

/**
 * armTimeline のセグメント参照（前回カーソルから前後に歩く = 実質 O(1)）。
 * セグメントは連続・非重複がオフライン側で保証されている。
 */
export function segAt(segs: ArmSegment[], t: number, cur: { current: number }): ArmSegment | null {
  if (!segs.length) return null;
  let i = Math.min(cur.current, segs.length - 1);
  while (i > 0 && segs[i].t0 > t) i--;
  while (i < segs.length - 1 && segs[i].t1 <= t) i++;
  cur.current = i;
  const s = segs[i];
  return t >= s.t0 - 0.05 && t <= s.t1 + 0.05 ? s : null;
}
