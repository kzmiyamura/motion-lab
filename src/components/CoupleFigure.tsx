import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MotionClip, ArmSegment } from './MocapFigure';
import type { FaceAvatar } from '../engine/faceAvatar';
import { PhotoHead, SampleHead, SAMPLE_BY_ID, DEFAULT_SKIN } from './AvatarHeads';

/**
 * カップルダンスを「2体」ではなく **1つのペア** として組むリグ。
 *
 * 以前は各ダンサーが独立に自分のポーズを計算していたので、つないでいるはずの手が
 * 合わなかった。合わないのは偶然ではなく構造の問題で、ゲームのカップルダンス/組み技は
 * 例外なく「ペアを1エンティティとして扱い、つなぎ目を**共有エフェクタ**にする」作りをする。
 * ここも同じにした — ホールド点は2人で1つ、両者の手はその1点へ IK で運ぶ。
 *
 * ポーズはレイヤーの積み重ねで作る。どれか1層が（データ欠落で）失敗しても
 * 身体そのものは壊れない:
 *
 *   1 移動      root の x/z・体の向き・腰の高さ        ← 実データ（腰は常時観測）
 *   2 脚        足首を目標にした2ボーンIK              ← 実データ（59〜82%）／欠けたら拍のステップ
 *   3 接続      つないだ手を共有ホールド点へIK          ← events の hold（全区間にある）
 *   4 フリーの腕 体側で軽く構える                      ← 手続き（腕の観測率は低すぎる）
 *   5 首        耳から取る相対ヨー = スポッティング      ← 実データ（ほぼ100%）
 */

// クリップの joints 並び（MocapFigure の J と同じ）
const LSHO = 1, RSHO = 2, LWRI = 5, RWRI = 6, LHIP = 7, RHIP = 8;
const LANK = 11, RANK = 12, LEAR = 13, REAR = 14, LTOE = 17, RTOE = 18;

// リグの寸法[m]（export の --target-height 1.70 に合わせた固定長）。
// JSX 側の group 位置と必ず一致させること — IK はこの値で解く
const L_THIGH = 0.46, L_SHIN = 0.44;
const L_UPARM = 0.28, L_FOREARM = 0.27;
const HIP_DX = 0.10;   // 股関節の左右オフセット
const SHO_DX = 0.185;  // 肩の左右オフセット
const SHO_DY = 0.40;   // 腰から肩までの高さ
const LEG_MAX = L_THIGH + L_SHIN;

// 左右の符号。前方 +Z・上 +Y の右手系なので **+X は本人の左**
// （体の向きの式 forward = (dz, -dx) と整合する）。0=左, 1=右
const SIDE_SIGN = [1, -1] as const;

// ペアの距離拘束[m]。弱透視の奥行き誤差で2人が重なる/離れすぎるのを止める。
// 2fda2815 実測: 腰中点の距離は median 0.67m だが min 0.05m・28%が0.5m未満で、
// 人体では起こりえない値が出る（復元の限界であって振付ではない）。
// 重心は動かさないので、振付の床の使い方は保たれる
// 上限は「手をつなげる距離」で決まる: 肩からホールド点までが腕の長さを超えたら
// どう解いても手は離れる。腕 0.55m × 2 を少し内側に取る
const PAIR_MIN = 0.58, PAIR_MAX = 1.02;
const ARM_REACH = (L_UPARM + L_FOREARM) * 0.95;
// つないだ手の追従の鈍らせ量（0 = 即時）。腕ごとではなく共有点の側で鈍らせる
const HOLD_LAG = 0.5;

const damp = (cur: number, target: number, k: number) => cur + (target - cur) * k;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a: number) => {
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

type Guide = {
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
function buildGuide(clip: MotionClip, pid: number): Guide {
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
type PairGuide = {
  ts: Float32Array; cx: Float32Array; cz: Float32Array;
  th: Float32Array;  // 相対位置の向き（unwrap 済み）
  d: Float32Array;   // 2人の距離
};
const MAX_PAIR_TURN = Math.PI * 4;   // [rad/s] = 720deg/s。人が相手を回り込める上限

function buildPair(clip: MotionClip, pid0: number, pid1: number): PairGuide {
  const ts: number[] = [], cx: number[] = [], cz: number[] = [];
  const th: number[] = [], d: number[] = [];
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
    th.push(a2); d.push(Math.hypot(dx, dz));
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
    d: smooth(median(d, 5).map((v) => clamp(v, PAIR_MIN, PAIR_MAX)), 7),
  };
}

// ── ガイドのサンプリング（人物ごとにカーソルを持つ）
type Sample = { i: number; i2: number; w: number; inRange: boolean };
function sampleAt(g: { ts: Float32Array }, t: number, cur: { current: number }): Sample {
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
const at = (s: Sample, a: Float32Array) => a[s.i] * (1 - s.w) + a[s.i2] * s.w;

// IK の作業用（毎フレーム確保しない）
const tmp = {
  dir: new THREE.Vector3(), pole: new THREE.Vector3(), axis: new THREE.Vector3(),
  ex: new THREE.Vector3(), ey: new THREE.Vector3(), ez: new THREE.Vector3(),
  m: new THREE.Matrix4(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
  qs: new THREE.Quaternion(),
  hold: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(),
  v: new THREE.Vector3(), v2: new THREE.Vector3(), w2: new THREE.Vector3(),
  pl: new THREE.Vector3(), sh: new THREE.Vector3(),
};

/**
 * ホールド点を「その人の腕が無理なく届く範囲」へ丸める（胸郭ローカルで処理し、
 * 世界座標へ戻す）。**両者ぶんを繰り返し当てて1点に収束させる**のが肝で、
 * 各自が自分の可動域へ別々に丸めた先を掴むと、掴んでいるはずの手が必ず離れる。
 */
function clampToArm(spine: THREE.Object3D, shoulder: THREE.Vector3, world: THREE.Vector3) {
  const sign = Math.sign(shoulder.x) || 1;
  spine.worldToLocal(world);
  world.x = sign * clamp((world.x - shoulder.x) * sign, ARM_ACROSS, ARM_OUT) + shoulder.x;
  world.z = Math.max(world.z, ARM_BACK_MIN);
  // 肩からの距離が腕の長さを超えたら、その肩へ寄せる
  tmp.v.subVectors(world, shoulder);
  const len = tmp.v.length();
  if (len > ARM_REACH) world.copy(shoulder).addScaledVector(tmp.v, ARM_REACH / len);
  spine.localToWorld(world);
}

/**
 * 手（腕IKの目標）を胴体の外へ押し出す。**体は空間を占有している**という当たり前を、
 * これまで誰も知らなかった。ホールド点は各自の「腕が届く箱」に丸めるだけだったので、
 * 肩と手の間に相手の胴体があっても素通りし、腕が体を貫通する／背中へ回り込む。
 *
 * 胴体は腰から肩までの垂直な円柱として扱う（軸は root の x/z）。
 */
const TORSO_R = 0.17;        // 胴体の半径[m]。肩幅 0.37 の内側に収まる程度
const TORSO_R_SELF = 0.13;   // 自分の胴体は少し細く見る（脇を締める姿勢を殺さないため）
function pushOutOfTorso(
  p: THREE.Vector3, cx: number, cz: number, yLo: number, yHi: number, r: number,
) {
  if (p.y < yLo - 0.10 || p.y > yHi + 0.20) return;   // 胴体の高さから外れていれば無関係
  const dx = p.x - cx, dz = p.z - cz;
  const d = Math.hypot(dx, dz);
  if (d >= r) return;
  if (d < 1e-5) { p.x = cx + r; return; }             // 芯に乗ったら適当な向きへ逃がす
  const k = r / d;
  p.x = cx + dx * k;
  p.z = cz + dz * k;
}

/**
 * 手の目標を、肩から**まっすぐ届く**位置へ回り込ませる。
 *
 * pushOutOfTorso だけでは足りない。目標を胴体の外へ出しても、肩と手を結ぶ線が
 * 相手の胴体を横切っていれば、そこへ腕を運ぶ IK は必ず体を貫通する
 * （端点が2つとも外にあることは、線分が外にあることを意味しない）。
 *
 * 横切っていたら、肩から円柱への**接線**の方向へ目標を寄せる。接線上なら
 * 肩から手までが胴体をかすめるだけで、中を通らない。
 */
function routeAroundTorso(
  p: THREE.Vector3, sx: number, sz: number, cx: number, cz: number,
  yLo: number, yHi: number, r: number,
) {
  if (p.y < yLo - 0.10 || p.y > yHi + 0.20) return;
  const dx = cx - sx, dz = cz - sz;
  const d = Math.hypot(dx, dz);
  if (d <= r + 1e-4) return;                    // 肩が胴体の中。ここでは救えない
  const tx = p.x - sx, tz = p.z - sz;
  const tlen = Math.hypot(tx, tz);
  if (tlen < 1e-5) return;
  // 肩から見た「胴体の方向」と「手の方向」の角度差が、接線の角度より小さければ横切る
  const cos = (tx * dx + tz * dz) / (tlen * d);
  if (cos <= 0) return;                          // 手は胴体と逆方向。無関係
  const half = Math.asin(clamp(r / d, -1, 1));   // 接線までの角度
  const ang = Math.acos(clamp(cos, -1, 1));
  if (ang >= half) return;                       // すでに外を通っている
  // 手がある側の接線へ回す（近いほうへ寄せる）
  const cross = dx * tz - dz * tx;               // 正 = 手は胴体の左側
  const rot = cross >= 0 ? half : -half;
  const ux = (dx * Math.cos(rot) - dz * Math.sin(rot)) / d;
  const uz = (dx * Math.sin(rot) + dz * Math.cos(rot)) / d;
  const reach = Math.min(tlen, Math.sqrt(d * d - r * r));  // 接点より先へは伸ばさない
  p.x = sx + ux * reach;
  p.z = sz + uz * reach;
}

// 肩の可動域。肘が裏返る領域（背中側・体を横切る側）へ目標が来ないよう先に丸める
const ARM_BACK_MIN = -0.04;  // これより後ろへは手を出さない[m]。胸の面より奥へは入れない
const ARM_ACROSS = -0.20;    // 体の反対側へ回り込める量[m]
const ARM_OUT = 0.62;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * 2ボーンIK。親ローカルの目標 (tx,ty,tz) へ末端を運ぶ。
 * `pole` は中間関節（膝・肘）を出す向き。姿勢は基底を明示して組む —
 * setFromUnitVectors だけだとロールが不定になり、曲がる面が毎フレーム変わってねじれる。
 *
 * pole は **dir に直交する成分だけを使う**。これを省くと、腕がほぼ真下を向いて
 * dir と pole が平行になった瞬間に外積が潰れ、曲がる面が飛んで肘が裏返る
 * （「腕がありえない方向へ曲がる」の正体はこれ）。
 *
 * `sm` は追従率（1 = 即時）。腕は目標が2体の位置に依存して細かく動くので鈍らせる。
 */
function solve2Bone(
  j1: THREE.Object3D, j2: THREE.Object3D, l1: number, l2: number,
  tx: number, ty: number, tz: number,
  px: number, py: number, pz: number,
  sm = 1,
) {
  const d = Math.hypot(tx, ty, tz) || 1e-6;
  // 完全に伸びきる/畳みきる手前で止める（acos の端で姿勢が飛ぶのを防ぐ）
  const dc = clamp(d, Math.abs(l1 - l2) + 0.02, l1 + l2 - 0.02);
  const bend = Math.PI - Math.acos(clamp((l1 * l1 + l2 * l2 - dc * dc) / (2 * l1 * l2), -1, 1));
  const off = Math.acos(clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1));

  tmp.dir.set(tx, ty, tz).divideScalar(d);
  tmp.pole.set(px, py, pz);
  tmp.pole.addScaledVector(tmp.dir, -tmp.pole.dot(tmp.dir)); // dir 成分を抜く
  if (tmp.pole.lengthSq() < 1e-8) {
    // dir と pole が平行。安定に決まる直交軸へ逃がす
    tmp.pole.set(-tmp.dir.y, tmp.dir.x, 0);
    if (tmp.pole.lengthSq() < 1e-8) tmp.pole.set(1, 0, 0);
  }
  tmp.pole.normalize();
  // dir を axis まわりに +off 回すと pole 側へ倒れる = 中間関節がそちらへ出る
  tmp.axis.crossVectors(tmp.dir, tmp.pole).normalize();
  tmp.ey.copy(tmp.dir).applyAxisAngle(tmp.axis, off).negate(); // ボーンの +Y（付け根向き）
  tmp.ex.copy(tmp.axis).negate();
  tmp.ex.addScaledVector(tmp.ey, -tmp.ex.dot(tmp.ey)).normalize();  // 直交化
  tmp.ez.crossVectors(tmp.ex, tmp.ey);
  tmp.m.makeBasis(tmp.ex, tmp.ey, tmp.ez);
  tmp.qs.setFromRotationMatrix(tmp.m);
  if (sm >= 1) j1.quaternion.copy(tmp.qs);
  else j1.quaternion.slerp(tmp.qs, sm);
  j2.rotation.set(sm >= 1 ? bend : damp(j2.rotation.x, bend, sm), 0, 0);
}

/**
 * 肘をどちらへ出すか（ポール）を手の高さで決める。**定数で固定してはいけない。**
 *
 * 手が腰の高さにあるときは肘は下・やや後ろ。ところが頭上へ手を上げると（ターンで
 * 手を通すときが全部これ）、肘を下へ向けたまま解くので「上腕は真上・前腕は真下へ
 * 折り返す」という人間の肩では作れない形になる。これが「腕がありえない動きをする」の正体。
 *
 * 実際の人体は、手が上がるほど肘が**外へ、そして前へ**逃げる。背中側へは回らない。
 * ty は肩から見た手の高さ[m]（正 = 肩より上）。
 */
function armPole(sign: number, ty: number, out: THREE.Vector3) {
  const up = clamp(ty / 0.30, 0, 1);   // 0 = 肩より下、1 = 頭上
  out.set(
    sign * (0.55 + 0.45 * up),   // 上げるほど外へ
    -1 + up,                     // 下向きは上げるほど弱まり、頭上では 0
    -0.3 + 0.6 * up,             // 下では やや後ろ、頭上では前へ（背中側へは回らない）
  );
}

// ── ホールド（つないでいる手）のタイムライン。0=左手, 1=右手。null=手を離している
type Hold = { t: number; leader: 0 | 1 | null; follower: 0 | 1 | null };
function buildHolds(clip: MotionClip): Hold[] {
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
function segAt(segs: ArmSegment[], t: number, cur: { current: number }): ArmSegment | null {
  if (!segs.length) return null;
  let i = Math.min(cur.current, segs.length - 1);
  while (i > 0 && segs[i].t0 > t) i--;
  while (i < segs.length - 1 && segs[i].t1 <= t) i++;
  cur.current = i;
  const s = segs[i];
  return t >= s.t0 - 0.05 && t <= s.t1 + 0.05 ? s : null;
}

// フェーズごとの「手を頭上へ運ぶ量」の目標。damp で滑らかに繋ぐ
const LIFT_BY_PHASE: Record<string, number> = {
  prep: 0.25, initiate: 0.8, rotate: 1, settle: 0.2,
};

type Rig = {
  root: THREE.Group; hips: THREE.Group; spine: THREE.Group; head: THREE.Group;
  thigh: THREE.Group[]; knee: THREE.Group[]; foot: THREE.Group[];
  shldr: THREE.Group[]; elbow: THREE.Group[];
  cursor: { current: number };
};
const newRig = (): Rig => ({
  root: null!, hips: null!, spine: null!, head: null!,
  thigh: [], knee: [], foot: [], shldr: [], elbow: [],
  cursor: { current: 0 },
});

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

function measureArms(rigs: [Rig, Rig], linked: (0 | 1 | null)[], dt: number) {
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
 * 計測用（一時）。**描画されたリグそのもの**の腕の座標と、胴体円柱への食い込みを
 * 時刻窓で吐く。ブラウザで `__armDump = [3.2, 3.6]`（クリップ秒）にすると、
 * 窓内の毎フレーム、肩・肘・手首のワールド座標と、上腕/前腕セグメントが
 * どちらの胴体をどれだけ抉っているか（depth 正 = 貫通）を console.table に出す。
 * 貫通の犯人は目視ではなくこの数字で確定させる。
 */
const dv = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
function segCylDepth(
  a: THREE.Vector3, b: THREE.Vector3,
  cx: number, cz: number, r: number, yLo: number, yHi: number,
) {
  // 線分を20分割し、胴体の高さ帯にある点の軸からの最小XZ距離を測る
  let best = Infinity, bu = -1;
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    const y = a.y + (b.y - a.y) * u;
    if (y < yLo || y > yHi) continue;
    const d = Math.hypot(a.x + (b.x - a.x) * u - cx, a.z + (b.z - a.z) * u - cz);
    if (d < best) { best = d; bu = u; }
  }
  return bu < 0 ? null : { depth: r - best, u: bu };
}

// URL クエリ `?armDump=3.2,3.6` でも有効化できる（コンソールに触れない環境向け）
const dumpFromUrl = (() => {
  const q = new URLSearchParams(globalThis.location?.search ?? '').get('armDump');
  if (!q) return null;
  const p = q.split(',').map(Number).filter((v) => Number.isFinite(v));
  return p.length >= 2 ? ([p[0], p[1]] as [number, number]) : p.length === 1 ? p[0] : null;
})();

function dumpArms(rigs: [Rig, Rig], linked: (0 | 1 | null)[], t: number, hold: THREE.Vector3) {
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
      // 上腕・前腕それぞれを、両者の胴体円柱と突き合わせる
      for (let o = 0; o < 2; o++) {
        const or_ = rigs[o];
        const yLo = or_.root.position.y + or_.hips.position.y;
        const r = o === d ? TORSO_R_SELF : TORSO_R;
        const up = segCylDepth(dv.a, dv.b, or_.root.position.x, or_.root.position.z, r, yLo, yLo + SHO_DY);
        const fo = segCylDepth(dv.b, dv.c, or_.root.position.x, or_.root.position.z, r, yLo, yLo + SHO_DY);
        const who = o === d ? '自' : '相手';
        row[`上腕→${who}`] = up ? f2(up.depth) : '-';
        row[`前腕→${who}`] = fo ? f2(fo.depth) : '-';
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

/** 服の配色。役割の色は服の色として残すので、青＝リーダー/ピンク＝フォロワーは変わらない */
type Palette = { cloth: string; pants: string; skin: string; shoe: string; dress: boolean };

function buildPalette(color: string, skin: string, dress: boolean): Palette {
  const c = new THREE.Color(color);
  return {
    cloth: color,
    pants: `#${c.clone().multiplyScalar(0.45).getHexString()}`,
    skin,
    // サルサシューズ: リーダーは黒のラテン（低いキューバンヒール）、
    // フォロワーはタンのストラップ付きヒール（この配色が実物でいちばん多い）
    shoe: dress ? '#b5834f' : '#17181f',
    dress,
  };
}

/**
 * サルサシューズ。**足首より下**へ伸ばす — クリップの足首は接地時で床から約5cm
 * （実測 p05: 0.04〜0.07m）なので、そこから下に靴底が来るように置く。
 */
function Shoe({ pal }: { pal: Palette }) {
  const mat = (
    <meshStandardMaterial color={pal.shoe} roughness={0.34} metalness={0.16} />
  );
  if (!pal.dress) {
    // ラテンシューズ: つま先の細い甲 + 後ろに低いキューバンヒール
    return (
      <group>
        <mesh position={[0, -0.025, 0.045]} castShadow>
          <boxGeometry args={[0.090, 0.048, 0.205]} />
          {mat}
        </mesh>
        <mesh position={[0, -0.020, 0.150]} castShadow>
          <boxGeometry args={[0.058, 0.036, 0.055]} />
          {mat}
        </mesh>
        <mesh position={[0, -0.056, -0.042]} castShadow>
          <boxGeometry args={[0.055, 0.026, 0.062]} />
          {mat}
        </mesh>
      </group>
    );
  }
  // ヒール: つま先を下げた甲 + 細いヒール + アンクルストラップ
  return (
    <group>
      <mesh position={[0, -0.030, 0.050]} rotation={[0.22, 0, 0]} castShadow>
        <boxGeometry args={[0.070, 0.040, 0.190]} />
        {mat}
      </mesh>
      <mesh position={[0, -0.062, -0.048]} castShadow>
        <cylinderGeometry args={[0.010, 0.013, 0.078, 10]} />
        {mat}
      </mesh>
      <mesh position={[0, 0.002, -0.008]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.043, 0.0055, 8, 20]} />
        {mat}
      </mesh>
    </group>
  );
}

/** 1人ぶんの見た目。関節は group 階層＝ボーンで、姿勢は CoupleFigure がまとめて書き込む */
function Body({
  rig, pal, face, sample,
}: {
  rig: Rig; pal: Palette; face?: FaceAvatar | null; sample?: string | null;
}) {
  const preset = sample ? SAMPLE_BY_ID(sample) : null;
  // 服＝役割色、素肌＝サンプルの肌色。上腕だけ服＝半袖に見える
  const clothMat = <meshStandardMaterial color={pal.cloth} roughness={0.62} metalness={0.02} />;
  const pantsMat = <meshStandardMaterial color={pal.pants} roughness={0.66} metalness={0.02} />;
  const skinMat = <meshStandardMaterial color={pal.skin} roughness={0.72} metalness={0} />;
  const shoeMat = <meshStandardMaterial color={pal.shoe} roughness={0.5} metalness={0.05} />;
  // ワンピースの人は脚が素肌、そうでない人はスラックス
  const legMat = pal.dress ? skinMat : pantsMat;

  return (
    <group ref={(o) => { if (o) rig.root = o; }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <circleGeometry args={[0.34, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} />
      </mesh>

      <group ref={(o) => { if (o) rig.hips = o; }} position={[0, 0.9, 0]}>
        <mesh>
          <capsuleGeometry args={[0.135, 0.1, 6, 14]} />
          {pal.dress ? clothMat : pantsMat}
        </mesh>
        {/* ワンピースのスカート。腰の子なので体の向きにだけ付いて回り、脚の動きでは歪まない */}
        {pal.dress && (
          <mesh position={[0, -0.16, 0]}>
            <cylinderGeometry args={[0.155, 0.28, 0.36, 24, 1, true]} />
            <meshStandardMaterial
              color={pal.cloth} roughness={0.65} metalness={0.02} side={THREE.DoubleSide}
            />
          </mesh>
        )}

        {/* 脚（太もも → すね → 足）。IK が太ももの姿勢と膝角を書き込む */}
        {[0, 1].map((s) => (
          <group
            key={s}
            ref={(o) => { if (o) rig.thigh[s] = o; }}
            position={[SIDE_SIGN[s] * HIP_DX, 0, 0]}
          >
            <mesh position={[0, -L_THIGH / 2, 0]} castShadow>
              <capsuleGeometry args={[0.078, L_THIGH - 0.1, 6, 12]} />
              {legMat}
            </mesh>
            <group ref={(o) => { if (o) rig.knee[s] = o; }} position={[0, -L_THIGH, 0]}>
              <mesh position={[0, -L_SHIN / 2, 0]} castShadow>
                <capsuleGeometry args={[0.062, L_SHIN - 0.1, 6, 12]} />
                {legMat}
              </mesh>
              {/* 足: つま先が +Z（体の前方）を向く向きで作る */}
              <group ref={(o) => { if (o) rig.foot[s] = o; }} position={[0, -L_SHIN, 0]}>
                <Shoe pal={pal} />
              </group>
            </group>
          </group>
        ))}

        {/* 胴 + 頭 + 腕 */}
        <group ref={(o) => { if (o) rig.spine = o; }}>
          <mesh position={[0, 0.24, 0]}>
            <capsuleGeometry args={[0.135, 0.32, 6, 14]} />
            {clothMat}
          </mesh>
          <mesh position={[0, 0.47, 0]}>
            <capsuleGeometry args={[0.045, 0.06, 4, 8]} />
            {skinMat}
          </mesh>

          {/* 頭（耳から取れる相対ヨーで回る = スポッティング） */}
          <group ref={(o) => { if (o) rig.head = o; }} position={[0, 0.58, 0]}>
            {face ? <PhotoHead avatar={face} color={pal.cloth} />
              : preset ? <SampleHead preset={preset} /> : (
                <>
                  <mesh>
                    <sphereGeometry args={[0.115, 20, 16]} />
                    {skinMat}
                  </mesh>
                  {/* 顔の向きが読めるように鼻先を出す */}
                  <mesh position={[0, -0.01, 0.105]}>
                    <sphereGeometry args={[0.032, 12, 10]} />
                    {shoeMat}
                  </mesh>
                </>
              )}
          </group>

          {/* 腕（肩 → 肘 → 手）。つないでいる側は IK が姿勢を書き込む */}
          {[0, 1].map((s) => (
            <group
              key={s}
              ref={(o) => { if (o) rig.shldr[s] = o; }}
              position={[SIDE_SIGN[s] * SHO_DX, SHO_DY, 0]}
            >
              {/* 上腕は服（＝袖）、前腕から先は素肌にして半袖に見せる */}
              <mesh position={[0, -L_UPARM / 2, 0]}>
                <capsuleGeometry args={[0.052, L_UPARM - 0.1, 6, 10]} />
                {clothMat}
              </mesh>
              <group ref={(o) => { if (o) rig.elbow[s] = o; }} position={[0, -L_UPARM, 0]}>
                <mesh position={[0, -L_FOREARM / 2, 0]}>
                  <capsuleGeometry args={[0.044, L_FOREARM - 0.1, 6, 10]} />
                  {skinMat}
                </mesh>
                <mesh position={[0, -L_FOREARM, 0]}>
                  <sphereGeometry args={[0.052, 12, 10]} />
                  {skinMat}
                </mesh>
              </group>
            </group>
          ))}
        </group>
      </group>
    </group>
  );
}

export function CoupleFigure({
  clip, timeRef, leaderColor, followerColor,
  leaderFace, followerFace, leaderSample, followerSample,
}: {
  clip: MotionClip;
  timeRef: { current: number };
  leaderColor: string;
  followerColor: string;
  leaderFace?: FaceAvatar | null;
  followerFace?: FaceAvatar | null;
  leaderSample?: string | null;
  followerSample?: string | null;
}) {
  // 添字 0 = リーダー, 1 = フォロワー
  const pids = useMemo<[number, number]>(
    () => [clip.leaderPid, 1 - clip.leaderPid], [clip.leaderPid]);
  const guides = useMemo(
    () => [buildGuide(clip, pids[0]), buildGuide(clip, pids[1])], [clip, pids]);
  const holds = useMemo(() => buildHolds(clip), [clip]);
  // armTimeline があればそれが唯一の腕の台本（実装順序3）。無い旧クリップは holds/events 走査。
  // `?armTimeline=0` で旧経路へ強制フォールバック（実装順序4の前後比較用）
  const armSegs = useMemo(() => {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    return q.get('armTimeline') === '0' ? undefined : clip.armTimeline?.segments;
  }, [clip]);
  // キーポーズ方式（既定ON）: 関節は手書きポーズ＋拍の手続きだけで決め、
  // 観測データは「技イベント・立ち位置・向き・腰の高さ」の選択にだけ使う。
  // 腕・足首の生観測を追いかけない = ノイズ由来の絡まり・貫通が原理的に出ない。
  // `?keyPose=0` で従来の観測追従に戻せる（見比べ用）
  const keyPose = useMemo(() => {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    return q.get('keyPose') !== '0';
  }, []);
  // 手描きクリップ（scriptedClip.ts 産）は関節データ自体が振付の正解
  const scripted = clip.armTimeline?.source === 'scripted';
  const armCur = useRef(0);
  const liftCur = useRef(0);
  const pair = useMemo(() => buildPair(clip, pids[0], pids[1]), [clip, pids]);
  const pairCur = useRef(0);
  const rigs = useRef<[Rig, Rig]>([newRig(), newRig()]).current;
  // つないだ手の共有点（前フレーム）。ここで鈍らせるので腕は目標をそのまま解ける
  const holdPos = useRef(new THREE.Vector3());
  const holdSame = useRef<unknown>(null);
  // 肌の色は選んだサンプルに合わせる（写真の頭でも体はこの色で通す）
  const pals = useMemo<[Palette, Palette]>(() => [
    buildPalette(leaderColor, SAMPLE_BY_ID(leaderSample ?? '')?.skin ?? DEFAULT_SKIN, false),
    buildPalette(followerColor, SAMPLE_BY_ID(followerSample ?? '')?.skin ?? DEFAULT_SKIN, true),
  ], [leaderColor, followerColor, leaderSample, followerSample]);

  useFrame((_st, dt) => {
    const t = timeRef.current;
    const [gL, gF] = guides;
    if (!rigs[0].root || !rigs[1].root || gL.ts.length < 2 || gF.ts.length < 2) return;

    const smp = [sampleAt(gL, t, rigs[0].cursor), sampleAt(gF, t, rigs[1].cursor)];

    // ── 拍。足首の実データがある区間では脚は実データが動かすので、拍は
    // 「観測が無い区間を埋める手続きアニメ」と上体の躍動に効く
    const bg = clip.beatGrid;
    const beat = bg ? (t - bg.firstBeatSec) / bg.beatIntervalSec : t * (172 / 60);
    const local = beat - Math.floor(beat);
    const dip = (1 - Math.cos(local * Math.PI * 2)) / 2;
    // サルサの休符: 4拍目・8拍目はステップしない（1,2,3 − 5,6,7 −）
    const rest = ((Math.floor(beat) % 4) + 4) % 4 === 3;
    const stepPhase = Math.sin(beat * Math.PI);

    // ── レイヤー1: 移動。先に2人ぶんの目標を出し、ペアの距離を拘束してから流す
    const tx = [0, 0], tz = [0, 0];
    for (let d = 0; d < 2; d++) {
      tx[d] = at(smp[d], guides[d].x);
      tz[d] = at(smp[d], guides[d].z);
    }
    // 2人の**相対位置**はペアガイドで解く。個々の x/z をそのまま使うと、
    // 奥行き推定の誤差で「横に並んでいるはずの2人が前後に重なる」フレームが出る
    const ps = sampleAt(pair, t, pairCur);
    if (smp[0].inRange && smp[1].inRange && ps.inRange) {
      const th = at(ps, pair.th), half = at(ps, pair.d) / 2;
      const cx = at(ps, pair.cx), cz = at(ps, pair.cz);
      const ux = Math.cos(th), uz = Math.sin(th);
      tx[0] = cx - ux * half; tz[0] = cz - uz * half;
      tx[1] = cx + ux * half; tz[1] = cz + uz * half;
    } else if (smp[0].inRange && smp[1].inRange) {
      let dx = tx[1] - tx[0], dz = tz[1] - tz[0];
      let dist = Math.hypot(dx, dz);
      if (dist < 1e-3) {
        // 完全に重なったフレームは向きが決まらないので、リーダーの真横へ逃がす
        const a = at(smp[0], guides[0].yaw);
        dx = Math.cos(a); dz = -Math.sin(a); dist = 1;
      }
      const push = (clamp(dist, PAIR_MIN, PAIR_MAX) - dist) / (2 * dist);
      tx[0] -= dx * push; tz[0] -= dz * push;
      tx[1] += dx * push; tz[1] += dz * push;
    }

    // ── レイヤー2・5: 人物ごとに独立して解ける層
    for (let d = 0; d < 2; d++) {
      const g = guides[d], s = smp[d], rig = rigs[d];
      rig.root.visible = s.inRange;
      if (!s.inRange) continue;

      const hipY = at(s, g.hipY);
      rig.root.position.x = damp(rig.root.position.x, tx[d], 0.35);
      rig.root.position.z = damp(rig.root.position.z, tz[d], 0.35);
      rig.root.rotation.y = damp(rig.root.rotation.y, at(s, g.yaw), 0.4);
      // 腰の高さも実データ。沈み込み（膝の使い方）が動画そのままに出る
      rig.hips.position.y = damp(rig.hips.position.y, hipY, 0.3);

      // ── 上体のねじれ: 肩ラインと腰ラインの差（実観測）。サルサの見た目の芯なので、
      // 観測が無いフレームだけ 0（＝腰と同じ向き）へ戻す
      const tw = clamp(at(s, g.twist.w), 0, 1);
      const twist = at(s, g.twist.v) * tw;
      rig.spine.rotation.y = damp(rig.spine.rotation.y, twist, 0.3);

      // ── 支持脚の判定 → キューバンモーション。
      // 低いほうの足首が体重を受けている。観測が無ければ拍のステップ位相で代用する
      const mirror = d === 1 ? -1 : 1;
      const w0 = clamp(at(s, g.ank[0].w), 0, 1), w1 = clamp(at(s, g.ank[1].w), 0, 1);
      const support = (w0 > 0.3 && w1 > 0.3)
        ? clamp((at(s, g.ank[1].y) - at(s, g.ank[0].y)) / 0.06, -1, 1)  // +1 = 左足に乗る
        : stepPhase * mirror;
      // 体重を受けた側の腰が上がり、胸郭はその逆へ振れる（骨盤を回すと脚IKが崩れるので上体で表す）
      rig.spine.position.y = damp(rig.spine.position.y, -dip * 0.02, 0.3);
      rig.spine.position.x = damp(rig.spine.position.x, -support * 0.022, 0.25);
      rig.spine.rotation.z = damp(rig.spine.rotation.z, -support * 0.055, 0.25);

      // 脚: 足首の実観測があればそこへIKで運び、無ければ拍のステップで埋める
      const amp = rest ? 0 : 0.16 + Math.min(0.3, at(s, g.speed) * 0.28);
      for (let k = 0; k < 2; k++) {
        const sign = SIDE_SIGN[k], ank = g.ank[k];
        // キーポーズ方式: 足首の**生観測**は使わない。ただし手描きクリップ（scripted）の
        // 足首は振付として書いた正解なので、そのまま踏む
        const aw = keyPose && !scripted ? 0 : clamp(at(s, ank.w), 0, 1);
        // 手続きの足位置（股関節ローカル）: 前後に振って、振り出す側を少し浮かす
        const sw = stepPhase * mirror * sign * amp * 0.55;
        const py = -(LEG_MAX * 0.97) + Math.max(0, stepPhase * mirror * sign) * 0.05;
        // 実データの足位置（股関節ローカル）
        const rx = at(s, ank.x) - sign * HIP_DX;
        const ry = at(s, ank.y) - hipY;
        const rz = at(s, ank.z);
        // 膝はつま先の上を通る（人体の構造）。つま先の向きは実観測なので、
        // 固定の「前」ではなくそれを使う — 横向きのステップで膝が内へ折れなくなる
        const fw = keyPose ? 0 : clamp(at(s, g.footYaw[k].w), 0, 1);
        const fy = at(s, g.footYaw[k].v) * fw;
        solve2Bone(rig.thigh[k], rig.knee[k], L_THIGH, L_SHIN,
          (rx) * aw, py + (ry - py) * aw, sw + (rz - sw) * aw,
          Math.sin(fy), 0, Math.cos(fy));

        // 足の向き: 体ローカルでの目標を作り、脚の回転ぶんを打ち消して足に入れる
        tmp.q.setFromAxisAngle(UP, fy);
        tmp.q2.copy(rig.thigh[k].quaternion).multiply(rig.knee[k].quaternion)
          .invert().multiply(tmp.q);
        rig.foot[k].quaternion.slerp(tmp.q2, 0.3);
      }

      // 首: 耳から取れる相対ヨー = スポッティング（ターンで顔だけ残る動き）。
      // 頭は胸郭の子なので、ねじれぶんを引いてから入れる
      const hw = clamp(at(s, g.headYaw.w), 0, 1);
      rig.head.rotation.y = damp(
        rig.head.rotation.y, clamp(at(s, g.headYaw.v) * hw - twist, -1.35, 1.35), 0.35);
    }

    // 胸郭を動かしたので、ここから先はワールド行列を実測してから使う
    // （肩の位置を手で展開すると、ねじれ・左右シフトのぶんだけ必ずずれる）
    rigs[0].root.updateMatrixWorld(true);
    rigs[1].root.updateMatrixWorld(true);

    // ── レイヤー3: 接続。つないだ手は2人で共有する1点へ運ぶ。
    // 目標生成は armTimeline（オフライン確定済みの台本）を再生する。旧クリップのみ
    // holds/events 走査へフォールバック
    const linked: (0 | 1 | null)[] = [null, null];
    let lift = 0, turner = -1, bsHand = -1;
    let holdKey: unknown = null;
    if (armSegs) {
      const seg = segAt(armSegs, t, armCur);
      if (seg && seg.hold) {
        linked[0] = seg.hold.leader === 'R' ? 1 : 0;
        linked[1] = seg.hold.follower === 'R' ? 1 : 0;
        // つなぐ手のペアが同じ間はセグメントをまたいでも共有点の鈍りを維持する
        holdKey = `${seg.hold.leader}x${seg.hold.follower}`;
      }
      if (seg?.turn) {
        turner = seg.turn.turner === 'leader' ? 0 : 1;
        lift = LIFT_BY_PHASE[seg.phase] ?? 0;
      }
      // CBL の pass: back_support の手はフォロワーの背中へ（リーダー側のみ発生する）
      if (seg?.phase === 'pass') {
        bsHand = seg.leader.L === 'back_support' ? 0
          : seg.leader.R === 'back_support' ? 1 : -1;
      }
    } else {
      let hold: Hold | null = null;
      for (const h of holds) { if (h.t <= t + 0.01) hold = h; else break; }
      if (hold && hold.leader !== null && hold.follower !== null) {
        linked[0] = hold.leader; linked[1] = hold.follower;
        holdKey = hold;
        // 進行中のターンを拾う。誰が回っているかで手の置き所が変わる
        for (const ev of clip.events) {
          if (ev.type !== 'Turn') continue;
          const dur = 1.6 + ((ev.rotations ?? 1) - 1) * 0.5;
          const prog = (t - (ev.t - 0.4)) / dur;
          if (prog < 0 || prog > 1) continue;
          const a = Math.sin(prog * Math.PI);
          if (a > lift) { lift = a; turner = ev.by === 'leader' ? 0 : 1; }
        }
      }
    }
    // フェーズ境界で lift が段差にならないよう、ここでまとめて鈍らせる
    lift = liftCur.current = damp(liftCur.current, lift, 0.2);

    if (linked[0] !== null && linked[1] !== null &&
        smp[0].inRange && smp[1].inRange) {
      rigs[0].shldr[linked[0]!].getWorldPosition(tmp.a);
      rigs[1].shldr[linked[1]!].getWorldPosition(tmp.b);
      // 平時: 両肩の中点。肩からの距離が両者で等しく最小になる＝いちばん届きやすい
      tmp.hold.addVectors(tmp.a, tmp.b).multiplyScalar(0.5).setY((tmp.a.y + tmp.b.y) / 2 - 0.20);
      if (turner >= 0) {
        // ターン中: 手は「回る人の回転軸の真上」へ。中点に置いたままだと
        // 相手が自分の手をくぐれず、サルサのターンに見えない
        const r = rigs[turner];
        tmp.v.set(r.root.position.x, r.hips.position.y + 0.78, r.root.position.z);
        tmp.hold.lerp(tmp.v, lift);
      }
      // つないだ手は物理的に**同じ1点**にある。だから片方でも手首が観測できていれば
      // そこが本当のホールド点で、合成した中点より必ず正しい。信頼度ぶんだけ実データへ寄せる
      // キーポーズ方式では実観測の手首へ寄せない — 幾何（両肩の中点・回転軸の真上）だけで
      // 決めた点のほうが、ノイズ混じりの観測より「きれいな1枚」になる
      if (!keyPose) {
        let dw = 0;
        tmp.v2.set(0, 0, 0);
        for (let d = 0; d < 2; d++) {
          const g = guides[d], k = linked[d]!;
          const w = clamp(at(smp[d], g.wri[k].w), 0, 1);
          if (w <= 0.02) continue;
          tmp.w2.set(at(smp[d], g.wri[k].x), at(smp[d], g.wri[k].y), at(smp[d], g.wri[k].z));
          rigs[d].root.localToWorld(tmp.w2);
          tmp.v2.addScaledVector(tmp.w2, w); dw += w;
        }
        if (dw > 0.02) tmp.hold.lerp(tmp.v2.divideScalar(dw), Math.min(1, dw));
      }

      // 手の揺れは**共有点の側**で吸収する。腕ごとに鈍らせると、2人が別々に
      // 遅れて別々の場所を掴むことになり、速いターンで手が離れる（実測 30〜40cm）
      if (holdSame.current === holdKey) tmp.hold.lerp(holdPos.current, HOLD_LAG);
      else holdSame.current = holdKey;              // つなぐ手が替わった瞬間は追わない

      // 肩甲上腕リズム: 手が肩より上がるぶんだけ肩自体も上がる（1/3 ほど）。
      // これが無いと腕だけが付け根から生えて回るように見える
      for (let d = 0; d < 2; d++) {
        const rig = rigs[d], k = linked[d]!, sign = SIDE_SIGN[k];
        tmp.v.copy(tmp.hold);
        rig.spine.worldToLocal(tmp.v);
        const raise = clamp((tmp.v.y - SHO_DY) / 0.35, 0, 1) * 0.055;
        rig.shldr[k].position.set(sign * (SHO_DX + raise * 0.35), SHO_DY + raise, 0);
      }
      // 共有点を**両者の可動域の共通部分**へ落とす。片側ずつ丸めると相手側で外れるので、
      // 2人ぶんを交互に3回当てて1点へ収束させる。
      // 併せて**2人ぶんの胴体の外**へも押し出す — つないだ手が相手の体の中／背中側に
      // 置かれると、そこへ腕を運ぶ IK が必ず体を貫通する
      // 肩のワールド位置を使うので、この時点の姿勢で行列を確定させる
      rigs[0].root.updateMatrixWorld(true);
      rigs[1].root.updateMatrixWorld(true);
      for (let it = 0; it < 3; it++) {
        for (let d = 0; d < 2; d++) {
          const rig = rigs[d], other = rigs[1 - d];
          const yLo = rig.root.position.y + rig.hips.position.y;
          pushOutOfTorso(tmp.hold, rig.root.position.x, rig.root.position.z,
            yLo, yLo + SHO_DY, TORSO_R);
          // 「肩から手までの線が胴体を横切らない」位置へ回り込ませる。
          // 相手の胴体だけでなく**自分の胴体**にも当てる（実測: つなぎ腕の前腕が
          // 自胴へ 4cm 食い込んでいた）
          const oLo = other.root.position.y + other.hips.position.y;
          tmp.sh.copy(rig.shldr[linked[d]!].position);
          rig.spine.localToWorld(tmp.sh);
          routeAroundTorso(tmp.hold, tmp.sh.x, tmp.sh.z,
            other.root.position.x, other.root.position.z,
            oLo, oLo + SHO_DY, TORSO_R);
          routeAroundTorso(tmp.hold, tmp.sh.x, tmp.sh.z,
            rig.root.position.x, rig.root.position.z,
            yLo, yLo + SHO_DY, TORSO_R_SELF);
          clampToArm(rig.spine, rig.shldr[linked[d]!].position, tmp.hold);
        }
      }
      holdPos.current.copy(tmp.hold);

      for (let d = 0; d < 2; d++) {
        const rig = rigs[d], k = linked[d]!, sign = SIDE_SIGN[k];
        // ワールドのホールド点 → 肩の親（胸郭）ローカル。行列から引くのでねじれても正しい
        tmp.v.copy(tmp.hold);
        rig.spine.worldToLocal(tmp.v);
        // 目標は上で可動域内に丸めてあるので、ここは鈍らせずそのまま解く
        // （両者が同じ1点を解く = 手が必ず合う）
        const ty = tmp.v.y - rig.shldr[k].position.y;
        armPole(sign, ty, tmp.pl);   // 肘の向きは手の高さで決める（定数だと頭上で裏返る）
        // 肘は**相手のいない側**へ出す。組んでいるときに肘を相手側へ出すのは
        // 人間はやらないし、やれば相手の体を貫通する
        const other = rigs[1 - d].root.position;
        tmp.v2.set(other.x, rig.shldr[k].position.y, other.z);
        rig.spine.worldToLocal(tmp.v2);
        tmp.v2.y = 0;
        if (tmp.v2.lengthSq() > 1e-6) tmp.pl.addScaledVector(tmp.v2.normalize(), -0.7);
        solve2Bone(rig.shldr[k], rig.elbow[k], L_UPARM, L_FOREARM,
          tmp.v.x - rig.shldr[k].position.x, ty, tmp.v.z,
          tmp.pl.x, tmp.pl.y, tmp.pl.z);
      }
    } else {
      holdSame.current = null;
    }

    // ── レイヤー3.5: CBL の pass 中、リーダーの空き手はフォロワーの背中を支える
    // （armTimeline の back_support 状態。ユーザー確認済み: 右手=背中・左手=胸の高さ）
    if (bsHand >= 0 && smp[0].inRange && smp[1].inRange) {
      const rig = rigs[0], k = bsHand, sign = SIDE_SIGN[k];
      const fRoot = rigs[1].root.position;
      const fy = rigs[1].root.rotation.y;
      const yLo = fRoot.y + rigs[1].hips.position.y;
      // フォロワーの背面（前方の逆）× 胴体半径の少し外、胸郭の高さ
      tmp.v.set(
        fRoot.x - Math.sin(fy) * (TORSO_R + 0.05),
        yLo + SHO_DY * 0.6,
        fRoot.z - Math.cos(fy) * (TORSO_R + 0.05),
      );
      clampToArm(rig.spine, rig.shldr[k].position, tmp.v);
      rig.spine.worldToLocal(tmp.v);
      const ty = tmp.v.y - rig.shldr[k].position.y;
      armPole(sign, ty, tmp.pl);
      solve2Bone(rig.shldr[k], rig.elbow[k], L_UPARM, L_FOREARM,
        tmp.v.x - rig.shldr[k].position.x, ty, tmp.v.z,
        tmp.pl.x, tmp.pl.y, tmp.pl.z, 0.35);
    }

    // ── レイヤー4: フリーの腕。実データがあればそれを目標に、無ければ体側で軽く構えて拍で揺れる
    for (let d = 0; d < 2; d++) {
      const rig = rigs[d], g = guides[d], s = smp[d];
      for (let k = 0; k < 2; k++) {
        if (linked[d] === k) continue;
        if (d === 0 && k === bsHand) continue;   // back_support 中の手はレイヤー3.5が持つ
        const sign = SIDE_SIGN[k];
        const sh = rig.shldr[k];
        sh.position.set(sign * SHO_DX, SHO_DY, 0);   // 上げた肩を戻す
        // キーポーズ方式では構えへ毎フレーム戻さない — 戻すと solve2Bone の slerp が
        // 毎回リセットから始まり、目標へ 25% しか進まない姿勢で固まる
        if (!keyPose) {
          sh.rotation.set(-0.30 + dip * 0.10, 0, sign * (0.42 + dip * 0.06));
          rig.elbow[k].rotation.set(damp(rig.elbow[k].rotation.x, -0.85, 0.2), 0, 0);
        }

        let w: number;
        if (keyPose) {
          // ── キーポーズ: フリーの腕は手書きの決めポーズ（胸郭ローカル）を拍で切り替える。
          // 観測は一切見ない。目標が滑らかに動くので solve2Bone の鈍り（w）で中割りになる
          if (!s.inRange) continue;
          const mirror = d === 1 ? -1 : 1;
          if (turner === d && lift > 0.25) {
            // 自分が回っている間: 腕を横へ開いてスタイリング（相手や自分に当てない高さ）
            tmp.v.set(sign * 0.42, 0.35, 0.10);
          } else if (linked[d] === null) {
            // シャイン（つないでいない）: 拍に合わせて前後に振る。脚と逆側の腕が前に出る
            const swing = stepPhase * mirror * -sign;
            tmp.v.set(sign * 0.32, 0.16 + Math.max(0, swing) * 0.14, 0.20 + swing * 0.16);
          } else {
            // 片手ホールド中の空き手: 軽く前で構える（社交ダンスの基本の構え）
            tmp.v.set(sign * 0.30, 0.18 + dip * 0.03, 0.24);
          }
          rig.spine.localToWorld(tmp.v);
          w = 0.25;
        } else {
          // 実観測（+ 速度ベクトルで伸ばした続き）の手首へ、信頼度ぶん寄せる。
          // 上で手続きの構えを入れてあるので、w が落ちれば自然にそちらへ戻る
          w = s.inRange ? clamp(at(s, g.wri[k].w), 0, 1) : 0;
          if (w <= 0.02) continue;
          tmp.v.set(at(s, g.wri[k].x), at(s, g.wri[k].y), at(s, g.wri[k].z));
          rig.root.localToWorld(tmp.v);
        }
        // 肩甲上腕リズム + 可動域。IK に無理をさせず、目標の側を人体の範囲へ丸める
        rig.spine.worldToLocal(tmp.v);
        const raise = clamp((tmp.v.y - SHO_DY) / 0.35, 0, 1) * 0.055;
        sh.position.set(sign * (SHO_DX + raise * 0.35), SHO_DY + raise, 0);
        rig.spine.localToWorld(tmp.v);
        // フリーの手も2人ぶんの胴体の外へ。実観測の手首がそのまま相手の体の中を
        // 指していることがある（腕の観測率が低いので当然起きる）
        tmp.sh.copy(sh.position);
        rig.spine.localToWorld(tmp.sh);
        // 先に可動域の箱へ丸め、そのあとで胴体を避ける。逆順だと clampToArm が
        // 目標の z を胸の前（ARM_BACK_MIN）へ引き戻し、せっかく接線へ回した線分が
        // また胴を横切る（実測: 前腕の自胴めり込みが 12cm のまま残った）
        clampToArm(rig.spine, sh.position, tmp.v);
        for (let o = 0; o < 2; o++) {
          const or_ = rigs[o];
          const yLo = or_.root.position.y + or_.hips.position.y;
          const r = o === d ? TORSO_R_SELF : TORSO_R;
          pushOutOfTorso(tmp.v, or_.root.position.x, or_.root.position.z,
            yLo, yLo + SHO_DY, r);
          // 自分の胴体にも適用する。目標を外へ出すだけでは、肩→手の線分が
          // 自分の胴を横切るケース（実測: 前腕が自胴へ 12cm 食い込む）を防げない
          routeAroundTorso(tmp.v, tmp.sh.x, tmp.sh.z,
            or_.root.position.x, or_.root.position.z, yLo, yLo + SHO_DY, r);
        }
        rig.spine.worldToLocal(tmp.v);
        const ty = tmp.v.y - sh.position.y;
        armPole(sign, ty, tmp.pl);
        solve2Bone(sh, rig.elbow[k], L_UPARM, L_FOREARM,
          tmp.v.x - sh.position.x, ty, tmp.v.z,
          tmp.pl.x, tmp.pl.y, tmp.pl.z, w);
      }
    }

    measureArms(rigs, linked, dt);
    dumpArms(rigs, linked, t, holdPos.current);
  });

  return (
    <>
      <Body rig={rigs[0]} pal={pals[0]} face={leaderFace} sample={leaderSample} />
      <Body rig={rigs[1]} pal={pals[1]} face={followerFace} sample={followerSample} />
    </>
  );
}

export default CoupleFigure;
