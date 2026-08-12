import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MotionClip } from './MocapFigure';

/**
 * ハイブリッドモード — 「実データ × 崩れない身体」。
 *
 * MocapFigure は関節の**位置**をそのまま描くので、観測できなかった関節でボーンが消え、
 * 骨の長さもフレームごとに変わる。ゲームや mocap 製品がこの作りをしないのは、
 * 位置ではなく**回転**を保存し、固定長のリグに流すからで、そうすれば
 * 「穴が空く」という状態が原理的に存在しない。ここは同じ考え方で作る。
 *
 *   - リグ（固定長の人型）を用意し、実データは**関節の目標位置**として渡す
 *   - 目標に届かない/観測が無い関節は IK と手続きアニメが埋める（消さない）
 *
 * 実データから取る量は観測率で選別している（2fda2815 実測）:
 *   耳ほぼ100% → 頭の向き（スポッティング）／腰100% → 動線・体の向き・腰の高さ
 *   足首59〜82% → 脚のIK（実際のステップ）／つま先52〜75% → 足の向き
 *   手首37〜57% → 低すぎるので使わず、技イベント（hold/Turn/CBL）由来の手続きアニメ
 */

// クリップの joints 並び（MocapFigure の J と同じ）
const LSHO = 1, RSHO = 2, LHIP = 7, RHIP = 8;
const LANK = 11, RANK = 12, LEAR = 13, REAR = 14, LTOE = 17, RTOE = 18;

// リグの寸法[m]（export の --target-height 1.70 に合わせた固定長）
const L_THIGH = 0.46, L_SHIN = 0.44;
const HIP_DX = 0.10;          // 股関節の左右オフセット
const LEG_MAX = L_THIGH + L_SHIN;

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

/** 値 + 信頼度のチャンネル。信頼度は手続きアニメとの混ぜ率になる */
type Chan = { v: Float32Array; w: Float32Array };
/** 足首の目標（体ローカル座標。y は床基準の絶対高さ） */
type AnkleChan = { x: Float32Array; y: Float32Array; z: Float32Array; w: Float32Array };

type Guide = {
  ts: Float32Array;
  x: Float32Array;
  z: Float32Array;
  yaw: Float32Array;   // unwrap + 平滑化済み
  speed: Float32Array; // 平滑化後の水平速度 [m/s]
  hipY: Float32Array;  // 実データの腰の高さ（沈み込みがそのまま出る）
  headYaw: Chan;       // 体に対する頭の相対ヨー = スポッティング
  ankL: AnkleChan; ankR: AnkleChan;
  footYawL: Chan; footYawR: Chan;
};

/**
 * クリップから信頼できる量だけを抜き出す。
 * 観測が無いフレームは直前の値を保持し、信頼度 0 を立てて呼び出し側に判断させる
 * （0 に落とすと平滑化がそこへ引っぱられて偽の動きが出る）。
 */
function buildGuide(clip: MotionClip, pid: number): Guide {
  const ts: number[] = [], xs: number[] = [], zs: number[] = [], yaws: number[] = [];
  const hipYs: number[] = [];
  const hYaw: number[] = [], hYawW: number[] = [];
  const aL = { x: [] as number[], y: [] as number[], z: [] as number[], w: [] as number[] };
  const aR = { x: [] as number[], y: [] as number[], z: [] as number[], w: [] as number[] };
  const fL: number[] = [], fLW: number[] = [], fR: number[] = [], fRW: number[] = [];
  let prevYaw: number | null = null;

  // 19関節クリップでのみ取れる関節。旧13関節クリップは手続きアニメだけで踊る
  const ext = clip.joints.length >= 19;

  for (const f of clip.frames) {
    const p = f.p[String(pid)];
    if (!p) continue;
    const j = p.j, v = p.v;
    if (v[LHIP] <= 0 || v[RHIP] <= 0) continue;
    const hx = (j[LHIP * 3] + j[RHIP * 3]) / 2;
    const hy = (j[LHIP * 3 + 1] + j[RHIP * 3 + 1]) / 2;
    const hz = (j[LHIP * 3 + 2] + j[RHIP * 3 + 2]) / 2;
    // 向き: 腰ライン（左→右）に垂直な水平ベクトル = up × (rHip - lHip)。
    // 肩ラインが取れるフレームは腰と平均して上体のひねりも少し反映する
    let dx = j[RHIP * 3] - j[LHIP * 3];
    let dz = j[RHIP * 3 + 2] - j[LHIP * 3 + 2];
    if (v[LSHO] > 0 && v[RSHO] > 0) {
      dx = (dx + (j[RSHO * 3] - j[LSHO * 3])) / 2;
      dz = (dz + (j[RSHO * 3 + 2] - j[LSHO * 3 + 2])) / 2;
    }
    // up × (dx,0,dz) = (dz, 0, -dx) が前方。three の rotation.y=θ は前方 (sinθ, cosθ)
    let yaw = Math.atan2(dz, -dx);
    if (prevYaw !== null) {
      // unwrap: 直前との差が最短になる分岐を選ぶ（連続ターンで一周が消えないように）
      while (yaw - prevYaw > Math.PI) yaw -= Math.PI * 2;
      while (yaw - prevYaw < -Math.PI) yaw += Math.PI * 2;
    }
    prevYaw = yaw;

    ts.push(f.t); xs.push(hx); zs.push(hz); yaws.push(yaw);
    hipYs.push(clamp(hy, 0.55, 1.15));

    // ワールド → 体ローカル（腰中点が原点・前方が +Z）
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const toLocal = (wx: number, wz: number): [number, number] => {
      const dX = wx - hx, dZ = wz - hz;
      return [dX * cy - dZ * sy, dX * sy + dZ * cy];
    };

    // ── 頭の向き（スポッティング）: 耳ラインは肩ラインと同じ式で前方が出る
    const last = <T,>(a: T[], fb: T): T => (a.length ? a[a.length - 1] : fb);
    if (ext && v[LEAR] > 0 && v[REAR] > 0) {
      const ex = j[REAR * 3] - j[LEAR * 3], ez = j[REAR * 3 + 2] - j[LEAR * 3 + 2];
      // 首の可動域を超える値は復元ノイズなので頭打ちにする
      hYaw.push(clamp(wrapPi(Math.atan2(ez, -ex) - yaw), -1.35, 1.35));
      hYawW.push(Math.min(v[LEAR], v[REAR]) >= 1 ? 1 : 0.5);
    } else {
      hYaw.push(last(hYaw, 0)); hYawW.push(0);
    }

    // ── 足首（脚IKの目標）と足の向き
    const foot = (ankIdx: number, toeIdx: number,
                  dst: typeof aL, fv: number[], fw: number[]) => {
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
    foot(LANK, LTOE, aL, fL, fLW);
    foot(RANK, RTOE, aR, fR, fRW);
  }

  const x = smooth(xs, 7), z = smooth(zs, 7), yaw = smooth(yaws, 7);
  const speed = new Float32Array(ts.length);
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    speed[i] = dt > 1e-6 && dt < 0.5
      ? Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]) / dt
      : speed[i - 1];
  }
  // 信頼度は値より広い窓で均す = 手続きアニメとの切り替わりが滑らかになる
  const chan = (v: number[], w: number[]): Chan => ({ v: smooth(v, 5), w: smooth(w, 11) });
  const ank = (a: typeof aL): AnkleChan => ({
    x: smooth(a.x, 5), y: smooth(a.y, 5), z: smooth(a.z, 5), w: smooth(a.w, 11),
  });

  return {
    ts: new Float32Array(ts), x, z, yaw, speed: smooth(Array.from(speed), 5),
    hipY: smooth(hipYs, 7),
    headYaw: chan(hYaw, hYawW),
    ankL: ank(aL), ankR: ank(aR),
    footYawL: chan(fL, fLW), footYawR: chan(fR, fRW),
  };
}

// IK の作業用（毎フレーム確保しない）
const tmp = {
  dir: new THREE.Vector3(),
  axis: new THREE.Vector3(),
  ex: new THREE.Vector3(), ey: new THREE.Vector3(), ez: new THREE.Vector3(),
  m: new THREE.Matrix4(),
  q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
};
const FWD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * 2ボーンIK。股関節ローカルの目標 (tx,ty,tz) へ足首を運ぶ。
 * 太ももの姿勢は基底を明示して組む — setFromUnitVectors だけだとロールが不定になり、
 * 膝の曲がる面が毎フレーム変わって脚がねじれる。
 */
function solveLeg(
  thigh: THREE.Object3D, knee: THREE.Object3D,
  tx: number, ty: number, tz: number,
) {
  const d = Math.hypot(tx, ty, tz);
  // 完全に伸びきる/畳みきる手前で止める（acos の端で姿勢が飛ぶのを防ぐ）
  const dc = clamp(d, Math.abs(L_THIGH - L_SHIN) + 0.02, LEG_MAX - 0.02);
  const kneeAngle = Math.PI - Math.acos(
    clamp((L_THIGH * L_THIGH + L_SHIN * L_SHIN - dc * dc) / (2 * L_THIGH * L_SHIN), -1, 1));
  const hipOff = Math.acos(
    clamp((L_THIGH * L_THIGH + dc * dc - L_SHIN * L_SHIN) / (2 * L_THIGH * dc), -1, 1));

  tmp.dir.set(tx, ty, tz).normalize();
  // 膝を出す面の法線。脚がまっすぐ下なら (-1,0,0) = 膝は前(+Z)へ曲がる
  tmp.axis.crossVectors(tmp.dir, FWD);
  if (tmp.axis.lengthSq() < 1e-8) tmp.axis.set(-1, 0, 0); else tmp.axis.normalize();
  tmp.ey.copy(tmp.dir).applyAxisAngle(tmp.axis, hipOff).negate(); // ボーンの +Y（付け根向き）
  tmp.ex.copy(tmp.axis).negate();
  tmp.ex.addScaledVector(tmp.ey, -tmp.ex.dot(tmp.ey)).normalize();  // 直交化
  tmp.ez.crossVectors(tmp.ex, tmp.ey);
  tmp.m.makeBasis(tmp.ex, tmp.ey, tmp.ez);
  thigh.quaternion.setFromRotationMatrix(tmp.m);
  knee.rotation.x = kneeAngle; // +X 回転で すねが後ろへ = 人の膝の向き
}

export function HybridFigure({
  clip, pid, role, color, timeRef,
}: {
  clip: MotionClip;
  pid: number;
  role: 'leader' | 'follower';
  color: string;
  timeRef: { current: number };
}) {
  const root = useRef<THREE.Group>(null!);
  const hips = useRef<THREE.Group>(null!);
  const spine = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const thighL = useRef<THREE.Group>(null!);
  const thighR = useRef<THREE.Group>(null!);
  const kneeL = useRef<THREE.Group>(null!);
  const kneeR = useRef<THREE.Group>(null!);
  const footL = useRef<THREE.Group>(null!);
  const footR = useRef<THREE.Group>(null!);
  const shldrL = useRef<THREE.Group>(null!);
  const shldrR = useRef<THREE.Group>(null!);
  const elbowL = useRef<THREE.Group>(null!);
  const elbowR = useRef<THREE.Group>(null!);
  const cursor = useRef(0);

  const guide = useMemo(() => buildGuide(clip, pid), [clip, pid]);
  const mirror = role === 'follower' ? -1 : 1;

  // イベントの hold（例: "リーダー右手×フォロワー左手"）から、この役がつないでいる手を引く
  const holdSide = (hold?: string | null): 'L' | 'R' | null => {
    if (!hold) return null;
    const m = role === 'leader' ? /リーダー(右|左)手/.exec(hold) : /フォロワー(右|左)手/.exec(hold);
    return m ? (m[1] === '右' ? 'R' : 'L') : null;
  };

  useFrame(() => {
    const g = guide;
    if (g.ts.length < 2 || !root.current) return;
    const t = timeRef.current;

    // 現在時刻を挟む2サンプルへカーソルを寄せる（MocapFigure と同じ走査）
    let i = cursor.current;
    if (i >= g.ts.length) i = g.ts.length - 1;
    while (i > 0 && g.ts[i] > t) i--;
    while (i < g.ts.length - 1 && g.ts[i + 1] <= t) i++;
    cursor.current = i;
    const i2 = Math.min(i + 1, g.ts.length - 1);
    const gap = g.ts[i2] - g.ts[i];
    // 欠測で間隔が開いた区間は補間せず手前の値を保持（無い移動を作らない）
    const w = gap > 1e-6 && gap < 0.5 ? Math.min(1, Math.max(0, (t - g.ts[i]) / gap)) : 0;
    const lerp = (a: Float32Array) => a[i] * (1 - w) + a[i2] * w;

    const inRange = t >= g.ts[0] - 0.4 && t <= g.ts[g.ts.length - 1] + 0.4;
    root.current.visible = inRange;
    if (!inRange) return;

    const x = lerp(g.x), z = lerp(g.z), yaw = lerp(g.yaw), speed = lerp(g.speed);
    const hipY = lerp(g.hipY);

    // ── 拍: クリップ同梱の beatGrid（解析BPM）。無ければサルサ標準寄りの仮値。
    // 足首の実データが取れているフレームでは脚は実データが動かすので、拍は
    // 「観測が無い区間を埋める手続きアニメ」と上体の躍動だけに効く
    const bg = clip.beatGrid;
    const beat = bg
      ? (t - bg.firstBeatSec) / bg.beatIntervalSec
      : t * (172 / 60);
    const local = beat - Math.floor(beat);
    const dip = (1 - Math.cos(local * Math.PI * 2)) / 2;

    // ── 動線と向き: 実データ（平滑化済み）をそのまま流す
    root.current.position.x = damp(root.current.position.x, x, 0.35);
    root.current.position.z = damp(root.current.position.z, z, 0.35);
    root.current.rotation.y = damp(root.current.rotation.y, yaw, 0.4);
    // 腰の高さも実データ。沈み込み（膝の使い方）が動画そのままに出る
    hips.current.position.y = damp(hips.current.position.y, hipY, 0.3);

    // ── 脚: 足首の実観測があればそこへIKで運び、無ければ拍のステップで埋める。
    // サルサの休符: 4拍目・8拍目はステップしない（1,2,3 − 5,6,7 −）
    const rest = ((Math.floor(beat) % 4) + 4) % 4 === 3;
    const amp = rest ? 0 : 0.16 + Math.min(0.3, speed * 0.28);
    const stepPhase = Math.sin(beat * Math.PI) * mirror;

    const leg = (
      thigh: THREE.Object3D, knee: THREE.Object3D, foot: THREE.Object3D,
      ank: AnkleChan, fyaw: Chan, side: 1 | -1,
    ) => {
      const aw = clamp(ank.w[i] * (1 - w) + ank.w[i2] * w, 0, 1);
      // 手続きの足位置（股関節ローカル）: 前後に振って、振り出す側を少し浮かす
      const sw = stepPhase * side * amp * 0.55;
      const px = 0, pz = sw;
      const py = -(LEG_MAX * 0.97) + Math.max(0, stepPhase * side) * 0.05;
      // 実データの足位置（股関節ローカル）
      const rx = lerp(ank.x) - side * HIP_DX, ry = lerp(ank.y) - hipY, rz = lerp(ank.z);
      solveLeg(thigh, knee,
        px + (rx - px) * aw, py + (ry - py) * aw, pz + (rz - pz) * aw);

      // 足の向き: 体ローカルでの目標をそのまま作り、脚の回転ぶんを打ち消して足に入れる
      const fw = clamp(fyaw.w[i] * (1 - w) + fyaw.w[i2] * w, 0, 1);
      tmp.q.setFromAxisAngle(UP, lerp(fyaw.v) * fw);
      tmp.q2.copy(thigh.quaternion).multiply(knee.quaternion).invert().multiply(tmp.q);
      foot.quaternion.slerp(tmp.q2, 0.3);
    };
    // 前方 = +Z・上 = +Y の右手系なので **+X は本人の左**（体の向きの式 forward=(dz,-dx) と整合）
    leg(thighL.current, kneeL.current, footL.current, g.ankL, g.footYawL, 1);
    leg(thighR.current, kneeR.current, footR.current, g.ankR, g.footYawR, -1);

    // ── 頭: 耳から取れる相対ヨー = スポッティング（ターンで顔だけ残る動き）。
    // 観測が無いフレームは正面へ戻す
    const hw = clamp(g.headYaw.w[i] * (1 - w) + g.headYaw.w[i2] * w, 0, 1);
    head.current.rotation.y = damp(head.current.rotation.y, lerp(g.headYaw.v) * hw, 0.35);

    // ── 上体のわずかな縦揺れ
    spine.current.position.y = damp(spine.current.position.y, -dip * 0.02, 0.3);

    // ── 腕: 実観測率が低すぎるので使わない。基本は前方フレームで、
    // 技イベントの前後だけアクセント（回転そのものは yaw の実データが担う）
    let armUpL = 0, armUpR = 0, armTuck = 0;
    for (const ev of clip.events) {
      const dur = 1.6 + ((ev.rotations ?? 1) - 1) * 0.5;
      const prog = (t - (ev.t - 0.4)) / dur;
      if (prog < 0 || prog > 1) continue;
      const arc = Math.sin(prog * Math.PI);
      const side = holdSide(ev.hold);
      if (ev.type === 'Turn' && ev.by === 'follower') {
        // つないだ手を上げて回す/回る（hold 不明時は従来どおり右手）
        const up = arc * (role === 'follower' ? 0.9 : 1.1);
        if (side === 'L') armUpL = Math.max(armUpL, up);
        else armUpR = Math.max(armUpR, up);
      } else if (ev.type === 'Turn' && ev.by === 'leader') {
        // リーダーの単独ターン: 腕を体に畳む
        if (role === 'leader') armTuck = Math.max(armTuck, arc);
      } else if (ev.type === 'CBL') {
        if (role === 'leader') {
          const up = arc * 0.5; // 道を空けて相手を通すリード
          if (side === 'L') armUpL = Math.max(armUpL, up);
          else armUpR = Math.max(armUpR, up);
        } else if (side) {
          const up = arc * 0.35; // つないだ手を前に預けて通過
          if (side === 'L') armUpL = Math.max(armUpL, up);
          else armUpR = Math.max(armUpR, up);
        }
      }
    }
    const frame = -1.15 + dip * 0.06;                 // 基本の前方フレーム
    const base = frame + (-0.35 - frame) * armTuck;   // ターン中は畳んだ位置へ寄せる
    shldrL.current.rotation.x = damp(shldrL.current.rotation.x, base - armUpL, 0.2);
    shldrR.current.rotation.x = damp(shldrR.current.rotation.x, base - armUpR, 0.2);
    // 肘: 上げた手はほぼ伸ばし、フレームのときは軽く曲げる（棒に見えないように）
    elbowL.current.rotation.x = damp(elbowL.current.rotation.x, -0.55 + armUpL * 0.45, 0.2);
    elbowR.current.rotation.x = damp(elbowR.current.rotation.x, -0.55 + armUpR * 0.45, 0.2);
  });

  const limbMat = <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />;
  const skinMat = <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />;
  const darkMat = <meshStandardMaterial color="#101528" roughness={0.6} metalness={0.05} />;

  // 固定長のリグ。group の階層＝ボーンで、useFrame は回転だけを与える
  return (
    <group ref={root}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <circleGeometry args={[0.34, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} />
      </mesh>

      <group ref={hips} position={[0, 0.9, 0]}>
        {/* 骨盤 */}
        <mesh>
          <capsuleGeometry args={[0.135, 0.1, 6, 14]} />
          {skinMat}
        </mesh>

        {/* 脚（太もも → すね → 足）。IK が太ももの姿勢と膝角を書き込む */}
        {([[1, thighL, kneeL, footL], [-1, thighR, kneeR, footR]] as const).map(
          ([s, th, kn, ft]) => (
            <group key={s} ref={th} position={[s * HIP_DX, 0, 0]}>
              <mesh position={[0, -L_THIGH / 2, 0]} castShadow>
                <capsuleGeometry args={[0.078, L_THIGH - 0.1, 6, 12]} />
                {limbMat}
              </mesh>
              <group ref={kn} position={[0, -L_THIGH, 0]}>
                <mesh position={[0, -L_SHIN / 2, 0]} castShadow>
                  <capsuleGeometry args={[0.062, L_SHIN - 0.1, 6, 12]} />
                  {limbMat}
                </mesh>
                {/* 足: つま先が +Z（体の前方）を向く向きで作る */}
                <group ref={ft} position={[0, -L_SHIN, 0]}>
                  <mesh position={[0, 0.03, 0.05]} castShadow>
                    <boxGeometry args={[0.095, 0.06, 0.23]} />
                    {darkMat}
                  </mesh>
                </group>
              </group>
            </group>
          ),
        )}

        {/* 胴 + 頭 + 腕 */}
        <group ref={spine} position={[0, 0, 0]}>
          <mesh position={[0, 0.24, 0]}>
            <capsuleGeometry args={[0.135, 0.32, 6, 14]} />
            {skinMat}
          </mesh>
          {/* 首 */}
          <mesh position={[0, 0.47, 0]}>
            <capsuleGeometry args={[0.045, 0.06, 4, 8]} />
            {skinMat}
          </mesh>

          {/* 頭（耳から取れる相対ヨーで回る = スポッティング） */}
          <group ref={head} position={[0, 0.58, 0]}>
            <mesh>
              <sphereGeometry args={[0.115, 20, 16]} />
              {skinMat}
            </mesh>
            {/* 顔の向きが読めるように鼻先を出す */}
            <mesh position={[0, -0.01, 0.105]}>
              <sphereGeometry args={[0.032, 12, 10]} />
              {darkMat}
            </mesh>
          </group>

          {/* 腕（肩 → 肘 → 手） */}
          {([[1, shldrL, elbowL], [-1, shldrR, elbowR]] as const).map(([s, sh, el]) => (
            <group key={s} ref={sh} position={[s * 0.185, 0.4, 0]}>
              <mesh position={[0, -0.14, 0]}>
                <capsuleGeometry args={[0.052, 0.2, 6, 10]} />
                {limbMat}
              </mesh>
              <group ref={el} position={[0, -0.28, 0]}>
                <mesh position={[0, -0.13, 0]}>
                  <capsuleGeometry args={[0.044, 0.18, 6, 10]} />
                  {limbMat}
                </mesh>
                <mesh position={[0, -0.27, 0]}>
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

export default HybridFigure;
