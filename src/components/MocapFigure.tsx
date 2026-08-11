import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * 動画から復元した3Dモーション（prototype_lift3d.py 系のパイプライン出力）を再生する骨格。
 *
 * SalsaStage3D の手続きアニメ（B方式）が「技の名前だけ動画由来・動きは手書き」なのに対し、
 * こちらは **関節の3D位置そのものが動画由来**。手続きアニメのリグ（太もも1本・腕1本）では
 * 表現しきれないので、関節間をボーンで結ぶ骨格として描く。
 *
 * ボーンの向きは「+Y を向いた円柱を、関節Aから関節Bへのベクトルに回す」四元数で与える。
 * 円柱の既定は原点中心・高さ1・Y軸方向なので、scale.y にボーン長を入れれば伸縮も一発で決まる。
 */

// クリップの joints 配列の並び（prototype_export_clip.py の NAMES と一致させること）
const J = {
  nose: 0, lShoulder: 1, rShoulder: 2, lElbow: 3, rElbow: 4, lWrist: 5, rWrist: 6,
  lHip: 7, rHip: 8, lKnee: 9, rKnee: 10, lAnkle: 11, rAnkle: 12,
} as const;

const BONES: [number, number][] = [
  [J.lShoulder, J.rShoulder], [J.lHip, J.rHip],
  [J.lShoulder, J.lHip], [J.rShoulder, J.rHip],
  [J.lShoulder, J.lElbow], [J.lElbow, J.lWrist],
  [J.rShoulder, J.rElbow], [J.rElbow, J.rWrist],
  [J.lHip, J.lKnee], [J.lKnee, J.lAnkle],
  [J.rHip, J.rKnee], [J.rKnee, J.rAnkle],
];
// 太さ: 胴は太く、手足は細く
const BONE_R = [0.055, 0.05, 0.052, 0.052, 0.038, 0.032, 0.038, 0.032, 0.05, 0.042, 0.05, 0.042];

export type MotionClip = {
  version: number;
  video?: string;
  fps: number;
  duration: number;
  leaderPid: number;
  joints: string[];
  events: { t: number; type: string; by?: string; rotations?: number }[];
  frames: { t: number; p: Record<string, { r: number[]; j: number[]; v: number[] }> }[];
  // 解析で推定した拍格子（等間隔）。ハイブリッドモードの脚のビート同期に使う
  beatGrid?: { bpm: number; firstBeatSec: number; beatIntervalSec: number; confidence?: number };
};

type Track = { ts: number[]; js: Float32Array[]; vs: Float32Array[] };

const UP = new THREE.Vector3(0, 1, 0);

export function MocapFigure({
  clip, pid, color, timeRef,
}: {
  clip: MotionClip;
  pid: number;
  color: string;
  timeRef: { current: number };
}) {
  const group = useRef<THREE.Group>(null!);
  const bones = useRef<THREE.Mesh[]>([]);
  const head = useRef<THREE.Mesh>(null!);
  const cursor = useRef(0);

  // この pid のフレームだけ抜き出して連続配列にしておく（毎フレームの検索を軽くする）
  const track = useMemo<Track>(() => {
    const ts: number[] = [], js: Float32Array[] = [], vs: Float32Array[] = [];
    for (const f of clip.frames) {
      const p = f.p[String(pid)];
      if (!p) continue;
      ts.push(f.t);
      js.push(new Float32Array(p.j));
      vs.push(new Float32Array(p.v));
    }
    return { ts, js, vs };
  }, [clip, pid]);

  // 再利用するテンポラリ（毎フレームの new を避ける）
  const tmp = useMemo(() => ({
    a: new THREE.Vector3(), b: new THREE.Vector3(),
    dir: new THREE.Vector3(), mid: new THREE.Vector3(), q: new THREE.Quaternion(),
  }), []);

  useFrame(() => {
    const { ts, js, vs } = track;
    if (ts.length === 0 || !group.current) return;
    const t = timeRef.current;

    // 現在時刻を挟む2フレームを探す。時間はほぼ単調に進むのでカーソルから前後に動かす
    let i = cursor.current;
    if (i >= ts.length) i = ts.length - 1;
    while (i > 0 && ts[i] > t) i--;
    while (i < ts.length - 1 && ts[i + 1] <= t) i++;
    cursor.current = i;

    const i2 = Math.min(i + 1, ts.length - 1);
    const t0 = ts[i], t1 = ts[i2];
    // 欠測で間隔が開いた区間は補間せず手前のポーズを保持する（無い動きを作らない）
    const gap = t1 - t0;
    const w = gap > 1e-6 && gap < 0.5 ? Math.min(1, Math.max(0, (t - t0) / gap)) : 0;
    const j0 = js[i], j1 = js[i2], v0 = vs[i], v1 = vs[i2];

    // クリップの範囲外（この人が写っていない時間帯）は非表示
    const inRange = t >= ts[0] - 0.4 && t <= ts[ts.length - 1] + 0.4;
    group.current.visible = inRange;
    if (!inRange) return;

    const px = (k: number, c: number) => j0[k * 3 + c] * (1 - w) + j1[k * 3 + c] * w;

    for (let bi = 0; bi < BONES.length; bi++) {
      const mesh = bones.current[bi];
      if (!mesh) continue;
      const [ai, bidx] = BONES[bi];
      const va = Math.min(v0[ai], v1[ai]);
      const vb = Math.min(v0[bidx], v1[bidx]);
      if (va <= 0 || vb <= 0) { mesh.visible = false; continue; }
      mesh.visible = true;
      // 補間で埋めた関節(0.5)は薄く描き、観測(1.0)と区別する
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = Math.min(va, vb) >= 1 ? 1 : 0.42;
      mat.transparent = mat.opacity < 1;

      tmp.a.set(px(ai, 0), px(ai, 1), px(ai, 2));
      tmp.b.set(px(bidx, 0), px(bidx, 1), px(bidx, 2));
      tmp.dir.subVectors(tmp.b, tmp.a);
      const len = tmp.dir.length();
      if (len < 1e-4) { mesh.visible = false; continue; }
      tmp.mid.addVectors(tmp.a, tmp.b).multiplyScalar(0.5);
      tmp.dir.divideScalar(len);
      tmp.q.setFromUnitVectors(UP, tmp.dir);
      mesh.position.copy(tmp.mid);
      mesh.quaternion.copy(tmp.q);
      mesh.scale.set(1, len, 1);
    }

    // 頭は鼻の少し上に球で置く
    if (head.current) {
      const vn = Math.min(v0[J.nose], v1[J.nose]);
      head.current.visible = vn > 0;
      if (vn > 0) {
        const sx = px(J.lShoulder, 0), sy = px(J.lShoulder, 1), sz = px(J.lShoulder, 2);
        const rx = px(J.rShoulder, 0), ry = px(J.rShoulder, 1), rz = px(J.rShoulder, 2);
        const nx = px(J.nose, 0), ny = px(J.nose, 1), nz = px(J.nose, 2);
        // 首(肩の中点)から鼻へ向かう方向にもう少し伸ばした所を頭の中心にする
        const cxm = (sx + rx) / 2, cym = (sy + ry) / 2, czm = (sz + rz) / 2;
        head.current.position.set(nx + (nx - cxm) * 0.35, ny + (ny - cym) * 0.35, nz + (nz - czm) * 0.35);
      }
    }
  });

  return (
    <group ref={group}>
      {BONES.map((_, i) => (
        <mesh key={i} ref={(m) => { if (m) bones.current[i] = m; }} castShadow>
          <cylinderGeometry args={[BONE_R[i], BONE_R[i], 1, 10]} />
          <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />
        </mesh>
      ))}
      <mesh ref={head}>
        <sphereGeometry args={[0.115, 20, 16]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />
      </mesh>
    </group>
  );
}

export default MocapFigure;
