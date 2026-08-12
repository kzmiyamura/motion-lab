import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MotionClip } from './MocapFigure';

/**
 * ハイブリッドモード — 「実データの動線 × 手続きアニメの手足」。
 *
 * MocapFigure（関節位置の直流し込み）は腕の実観測率が35〜54%しかなく、補間の腕が
 * どうしても揺れる。一方で復元データのうち **root軌跡・胴体の向き・技イベント・拍** は
 * 剛体拘束・回転頭打ちを通っていて信頼できる。そこで:
 *
 *   - どこへ動くか / どちらを向くか / いつ回るか … 動画の実データから取る
 *   - 手足をどう振るか                         … B方式の手続きアニメで描く
 *
 * 「この動画のルーティンを、崩れない身体で再現する」役割分担。
 * ターンの回転も胴体ヨーの実データがそのまま出るので、振付は捏造しない。
 */

// クリップの joints 並び（MocapFigure の J と同じ）
const LSHO = 1, RSHO = 2, LHIP = 7, RHIP = 8;

type Guide = {
  ts: Float32Array;
  x: Float32Array;
  z: Float32Array;
  yaw: Float32Array;   // unwrap + 平滑化済み
  speed: Float32Array; // 平滑化後の水平速度 [m/s]
};

const damp = (cur: number, target: number, k: number) => cur + (target - cur) * k;

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

/** クリップから信頼できる量（位置・向き・速度）だけを抜き出す */
function buildGuide(clip: MotionClip, pid: number): Guide {
  const ts: number[] = [], xs: number[] = [], zs: number[] = [], yaws: number[] = [];
  let prevYaw: number | null = null;
  for (const f of clip.frames) {
    const p = f.p[String(pid)];
    if (!p) continue;
    const j = p.j, v = p.v;
    if (v[LHIP] <= 0 || v[RHIP] <= 0) continue;
    const hx = (j[LHIP * 3] + j[RHIP * 3]) / 2;
    const hz = (j[LHIP * 3 + 2] + j[RHIP * 3 + 2]) / 2;
    // 向き: 腰ライン（左→右）に垂直な水平ベクトル = up × (rHip - lHip)。
    // 肩ラインが取れるフレームは腰と平均して上体のひねりも少し反映する
    let dx = j[RHIP * 3] - j[LHIP * 3];
    let dz = j[RHIP * 3 + 2] - j[LHIP * 3 + 2];
    if (v[LSHO] > 0 && v[RSHO] > 0) {
      dx = (dx + (j[RSHO * 3] - j[LSHO * 3])) / 2;
      dz = (dz + (j[RSHO * 3 + 2] - j[LSHO * 3 + 2])) / 2;
    }
    // up × (dx,0,dz) = (dz, 0, -dx) が前方
    let yaw = Math.atan2(dz, -dx);
    if (prevYaw !== null) {
      // unwrap: 直前との差が最短になる分岐を選ぶ（連続ターンで一周が消えないように）
      while (yaw - prevYaw > Math.PI) yaw -= Math.PI * 2;
      while (yaw - prevYaw < -Math.PI) yaw += Math.PI * 2;
    }
    prevYaw = yaw;
    ts.push(f.t); xs.push(hx); zs.push(hz); yaws.push(yaw);
  }
  const x = smooth(xs, 7), z = smooth(zs, 7), yaw = smooth(yaws, 7);
  const speed = new Float32Array(ts.length);
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    speed[i] = dt > 1e-6 && dt < 0.5
      ? Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]) / dt
      : speed[i - 1];
  }
  return { ts: new Float32Array(ts), x, z, yaw, speed: smooth(Array.from(speed), 5) };
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
  const spine = useRef<THREE.Group>(null!);
  const thighL = useRef<THREE.Group>(null!);
  const thighR = useRef<THREE.Group>(null!);
  const shldrL = useRef<THREE.Group>(null!);
  const shldrR = useRef<THREE.Group>(null!);
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

    // ── 拍: クリップ同梱の beatGrid（解析BPM）。無ければサルサ標準寄りの仮値
    const bg = clip.beatGrid;
    const beat = bg
      ? (t - bg.firstBeatSec) / bg.beatIntervalSec
      : t * (172 / 60);
    const local = beat - Math.floor(beat);
    const dip = (1 - Math.cos(local * Math.PI * 2)) / 2;

    // ── 動線と向き: 実データ（平滑化済み）をそのまま流す
    root.current.position.x = damp(root.current.position.x, x, 0.35);
    root.current.position.z = damp(root.current.position.z, z, 0.35);
    root.current.position.y = damp(root.current.position.y, 0.02 - dip * 0.05, 0.3);
    root.current.rotation.y = damp(root.current.rotation.y, yaw, 0.4);

    // ── 脚: 拍ごとに接地脚が交替。歩幅は実移動速度で伸縮（止まっていれば足踏み）。
    // サルサの休符: 4拍目・8拍目はステップを踏まない（1,2,3 − 5,6,7 −）
    const rest = ((Math.floor(beat) % 4) + 4) % 4 === 3;
    const amp = rest ? 0 : 0.16 + Math.min(0.3, speed * 0.28);
    const stepPhase = Math.sin(beat * Math.PI) * mirror;
    thighL.current.rotation.x = damp(thighL.current.rotation.x, amp * stepPhase, 0.25);
    thighR.current.rotation.x = damp(thighR.current.rotation.x, -amp * stepPhase, 0.25);

    // ── 上体のわずかな縦揺れ
    spine.current.position.y = damp(spine.current.position.y, 0.9 - dip * 0.02, 0.3);

    // ── 腕: 基本は前方フレーム。技イベントの前後だけアクセント（回転そのものは yaw が担う）。
    // hold からどちらの手をつないでいるか分かるので、その手を動かす
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
        // リーダーの単独ターン: 腕を体に畳む（回転そのものは yaw の実データが描く）
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
  });

  const limbMat = <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />;
  const skinMat = <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />;

  // リグは B方式（SalsaStage3D の Dancer）と同じ手続き生成の人型
  return (
    <group ref={root}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <circleGeometry args={[0.34, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} />
      </mesh>

      <group ref={thighL} position={[-0.11, 0.9, 0]}>
        <mesh position={[0, -0.42, 0]} castShadow>
          <capsuleGeometry args={[0.075, 0.72, 6, 12]} />
          {limbMat}
        </mesh>
      </group>
      <group ref={thighR} position={[0.11, 0.9, 0]}>
        <mesh position={[0, -0.42, 0]} castShadow>
          <capsuleGeometry args={[0.075, 0.72, 6, 12]} />
          {limbMat}
        </mesh>
      </group>

      <group position={[0, 0.9, 0]}>
        <mesh>
          <capsuleGeometry args={[0.14, 0.1, 6, 12]} />
          {skinMat}
        </mesh>
      </group>

      <group ref={spine} position={[0, 0.9, 0]}>
        <mesh position={[0, 0.22, 0]}>
          <capsuleGeometry args={[0.13, 0.34, 6, 12]} />
          {skinMat}
        </mesh>
        <mesh position={[0, 0.62, 0]}>
          <sphereGeometry args={[0.13, 20, 16]} />
          {skinMat}
        </mesh>

        <group ref={shldrL} position={[-0.2, 0.42, 0]}>
          <mesh position={[0, -0.26, 0]}>
            <capsuleGeometry args={[0.055, 0.46, 6, 10]} />
            {limbMat}
          </mesh>
        </group>
        <group ref={shldrR} position={[0.2, 0.42, 0]}>
          <mesh position={[0, -0.26, 0]}>
            <capsuleGeometry args={[0.055, 0.46, 6, 10]} />
            {limbMat}
          </mesh>
        </group>
      </group>
    </group>
  );
}

export default HybridFigure;
