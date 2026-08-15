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

// クリップの joints 配列の並び（prototype_export_clip.py の NAMES と一致させること）。
// 14以降は19関節版クリップのみに存在する（旧13関節クリップも読めるようにガードする）
const J = {
  nose: 0, lShoulder: 1, rShoulder: 2, lElbow: 3, rElbow: 4, lWrist: 5, rWrist: 6,
  lHip: 7, rHip: 8, lKnee: 9, rKnee: 10, lAnkle: 11, rAnkle: 12,
  lEar: 13, rEar: 14, lHeel: 15, rHeel: 16, lToe: 17, rToe: 18,
} as const;

// [関節A, 関節B, 太さ, 追加で可視を要求する関節]。胴は太く、手足は細く。
// 第4要素は「脚とつながっていない足だけが宙に浮く」のを防ぐための前提条件
type BoneDef = [number, number, number, number[]?];
const CORE_BONES: BoneDef[] = [
  [J.lShoulder, J.rShoulder, 0.055], [J.lHip, J.rHip, 0.05],
  [J.lShoulder, J.lHip, 0.052], [J.rShoulder, J.rHip, 0.052],
  [J.lShoulder, J.lElbow, 0.038], [J.lElbow, J.lWrist, 0.032],
  [J.rShoulder, J.rElbow, 0.038], [J.rElbow, J.rWrist, 0.032],
  [J.lHip, J.lKnee, 0.05], [J.lKnee, J.lAnkle, 0.042],
  [J.rHip, J.rKnee, 0.05], [J.rKnee, J.rAnkle, 0.042],
];
// 足の三角形（足首・かかと・つま先）。足の向き = サルサの足元表現。
// すねが描けないフレームでは足だけが地面に浮いて見えるので、膝（と足首）も可視のときだけ描く
const FOOT_BONES: BoneDef[] = [
  [J.lAnkle, J.lHeel, 0.03, [J.lKnee]],
  [J.lHeel, J.lToe, 0.026, [J.lKnee, J.lAnkle]],
  [J.lAnkle, J.lToe, 0.026, [J.lKnee]],
  [J.rAnkle, J.rHeel, 0.03, [J.rKnee]],
  [J.rHeel, J.rToe, 0.026, [J.rKnee, J.rAnkle]],
  [J.rAnkle, J.rToe, 0.026, [J.rKnee]],
];

export type MotionClip = {
  version: number;
  video?: string;
  fps: number;
  duration: number;
  leaderPid: number;
  joints: string[];
  events: { t: number; type: string; by?: string; rotations?: number; hold?: string | null }[];
  frames: { t: number; p: Record<string, { r: number[]; j: number[]; v: number[] }> }[];
  // 解析で推定した拍格子（等間隔）。ハイブリッドモードの脚のビート同期に使う
  beatGrid?: { bpm: number; firstBeatSec: number; beatIntervalSec: number; confidence?: number };
  // オフライン幾何パス（server/analysis/build_arm_timeline.py）が生成する腕タイムライン。
  // あれば CoupleFigure のレイヤー3がこれを再生し、events の hold 走査は使わない
  armTimeline?: ArmTimeline;
};

// closed_back      … クローズドポジション: リーダー右手をフォロワーの左肩甲骨へ
// closed_shoulder  … クローズドポジション: フォロワー左手をリーダーの右肩へ
export type ArmHandState =
  'free' | 'hold' | 'prep' | 'lead_turn' | 'back_support' | 'closed_back' | 'closed_shoulder';
export type ArmSegment = {
  t0: number; t1: number;
  phase: string;                                   // hold/shine/open/pass/close/prep/initiate/rotate/settle
  hold: { leader: 'L' | 'R'; follower: 'L' | 'R' } | null;
  leader: { L: ArmHandState; R: ArmHandState };
  follower: { L: ArmHandState; R: ArmHandState };
  turn?: { turner: 'leader' | 'follower'; rotations: number };
  passSide?: 'left' | 'right' | null;
  confidence?: 'observed' | 'inferred';
};
export type ArmTimeline = { version: number; source: string; segments: ArmSegment[] };

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
  const noseTip = useRef<THREE.Mesh>(null!);
  const cursor = useRef(0);

  // 旧13関節クリップでは足・耳のボーンを描かない（j 配列の範囲外アクセス防止）
  const hasExt = clip.joints.length >= 19;
  const boneDefs = useMemo<BoneDef[]>(
    () => (hasExt ? [...CORE_BONES, ...FOOT_BONES] : CORE_BONES),
    [hasExt],
  );

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

    for (let bi = 0; bi < boneDefs.length; bi++) {
      const mesh = bones.current[bi];
      if (!mesh) continue;
      const [ai, bidx, , requires] = boneDefs[bi];
      const va = Math.min(v0[ai], v1[ai]);
      const vb = Math.min(v0[bidx], v1[bidx]);
      if (va <= 0 || vb <= 0) { mesh.visible = false; continue; }
      if (requires?.some((k) => Math.min(v0[k], v1[k]) <= 0)) { mesh.visible = false; continue; }
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

    // 頭の球。耳が取れる19関節クリップでは耳の中点 = 本当の頭の中心に置き、
    // 鼻を小さな球で突き出して顔の向き（スポッティング）を見せる
    if (head.current) {
      const vn = Math.min(v0[J.nose], v1[J.nose]);
      const earsOk = hasExt
        && Math.min(v0[J.lEar], v1[J.lEar]) > 0 && Math.min(v0[J.rEar], v1[J.rEar]) > 0;
      head.current.visible = vn > 0 || earsOk;
      if (noseTip.current) noseTip.current.visible = false;
      if (earsOk) {
        const ex = (px(J.lEar, 0) + px(J.rEar, 0)) / 2;
        const ey = (px(J.lEar, 1) + px(J.rEar, 1)) / 2;
        const ez = (px(J.lEar, 2) + px(J.rEar, 2)) / 2;
        head.current.position.set(ex, ey, ez);
        if (vn > 0 && noseTip.current) {
          // 頭の中心から鼻方向へ少し伸ばして、球の表面から覗かせる
          noseTip.current.visible = true;
          noseTip.current.position.set(
            ex + (px(J.nose, 0) - ex) * 1.45,
            ey + (px(J.nose, 1) - ey) * 1.45,
            ez + (px(J.nose, 2) - ez) * 1.45,
          );
        }
      } else if (vn > 0) {
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
      {boneDefs.map(([, , r], i) => (
        <mesh key={i} ref={(m) => { if (m) bones.current[i] = m; }} castShadow>
          <cylinderGeometry args={[r, r, 1, 10]} />
          <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />
        </mesh>
      ))}
      <mesh ref={head}>
        <sphereGeometry args={[0.115, 20, 16]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />
      </mesh>
      {/* 顔の向きインジケーター（耳が取れるクリップのみ表示） */}
      <mesh ref={noseTip}>
        <sphereGeometry args={[0.042, 12, 10]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.05} />
      </mesh>
    </group>
  );
}

export default MocapFigure;
