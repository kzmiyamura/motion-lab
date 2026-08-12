import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MotionClip } from './MocapFigure';
import { buildFaceGeometry, type FaceAvatar } from '../engine/faceAvatar';

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
const LSHO = 1, RSHO = 2, LHIP = 7, RHIP = 8;
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
  ank: [AnkleChan, AnkleChan];  // [左, 右]
  footYaw: [Chan, Chan];
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
  const mkA = () => ({ x: [] as number[], y: [] as number[], z: [] as number[], w: [] as number[] });
  const aRaw = [mkA(), mkA()];
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
  const chan = (c: { v: number[]; w: number[] }): Chan => ({ v: smooth(c.v, 5), w: smooth(c.w, 11) });
  const ank = (a: ReturnType<typeof mkA>): AnkleChan => ({
    x: smooth(a.x, 5), y: smooth(a.y, 5), z: smooth(a.z, 5), w: smooth(a.w, 11),
  });

  return {
    ts: new Float32Array(ts), x, z, yaw, speed: smooth(Array.from(speed), 5),
    hipY: smooth(hipYs, 7),
    headYaw: chan({ v: hYaw, w: hYawW }),
    ank: [ank(aRaw[0]), ank(aRaw[1])],
    footYaw: [chan(fRaw[0]), chan(fRaw[1])],
  };
}

// ── ガイドのサンプリング（人物ごとにカーソルを持つ）
type Sample = { i: number; i2: number; w: number; inRange: boolean };
function sampleAt(g: Guide, t: number, cur: { current: number }): Sample {
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
  hold: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(),
};
const UP = new THREE.Vector3(0, 1, 0);

/**
 * 2ボーンIK。親ローカルの目標 (tx,ty,tz) へ末端を運ぶ。
 * `pole` は中間関節（膝・肘）を出す向き。姿勢は基底を明示して組む —
 * setFromUnitVectors だけだとロールが不定になり、曲がる面が毎フレーム変わってねじれる。
 */
function solve2Bone(
  j1: THREE.Object3D, j2: THREE.Object3D, l1: number, l2: number,
  tx: number, ty: number, tz: number,
  px: number, py: number, pz: number,
) {
  const d = Math.hypot(tx, ty, tz);
  // 完全に伸びきる/畳みきる手前で止める（acos の端で姿勢が飛ぶのを防ぐ）
  const dc = clamp(d, Math.abs(l1 - l2) + 0.02, l1 + l2 - 0.02);
  const bend = Math.PI - Math.acos(clamp((l1 * l1 + l2 * l2 - dc * dc) / (2 * l1 * l2), -1, 1));
  const off = Math.acos(clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1));

  tmp.dir.set(tx || 1e-6, ty, tz).normalize();
  tmp.pole.set(px, py, pz).normalize();
  // dir を axis まわりに +off 回すと pole 側へ倒れる = 中間関節がそちらへ出る
  tmp.axis.crossVectors(tmp.dir, tmp.pole);
  if (tmp.axis.lengthSq() < 1e-8) tmp.axis.set(1, 0, 0); else tmp.axis.normalize();
  tmp.ey.copy(tmp.dir).applyAxisAngle(tmp.axis, off).negate(); // ボーンの +Y（付け根向き）
  tmp.ex.copy(tmp.axis).negate();
  tmp.ex.addScaledVector(tmp.ey, -tmp.ex.dot(tmp.ey)).normalize();  // 直交化
  tmp.ez.crossVectors(tmp.ex, tmp.ey);
  tmp.m.makeBasis(tmp.ex, tmp.ey, tmp.ez);
  j1.quaternion.setFromRotationMatrix(tmp.m);
  j2.rotation.set(bend, 0, 0);
}

// ── ホールド（つないでいる手）のタイムライン。0=左手, 1=右手
type Hold = { t: number; leader: 0 | 1; follower: 0 | 1 };
function buildHolds(clip: MotionClip): Hold[] {
  const out: Hold[] = [];
  for (const ev of [...clip.events].sort((a, b) => a.t - b.t)) {
    if (!ev.hold) continue;
    const l = /リーダー(右|左)手/.exec(ev.hold);
    const f = /フォロワー(右|左)手/.exec(ev.hold);
    if (!l || !f) continue;
    out.push({ t: ev.t, leader: l[1] === '右' ? 1 : 0, follower: f[1] === '右' ? 1 : 0 });
  }
  // 最初のイベント以前も同じホールドで踊っているものとして前へ伸ばす
  if (out.length) out[0] = { ...out[0], t: -1e9 };
  return out;
}

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

/** 写真から作った顔。後頭部は色つきの球のまま残して「頭」として成立させる */
function PhotoHead({ avatar, color }: { avatar: FaceAvatar; color: string }) {
  const geo = useMemo(() => buildFaceGeometry(avatar), [avatar]);
  const tex = useMemo(() => {
    const t = new THREE.TextureLoader().load(avatar.image);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [avatar.image]);
  useEffect(() => () => { geo.dispose(); tex.dispose(); }, [geo, tex]);

  return (
    <>
      <mesh geometry={geo} position={[0, 0, 0.03]}>
        {/* 三角形の向きは分割の都合で揃わないので両面で描く */}
        <meshStandardMaterial map={tex} roughness={0.85} metalness={0} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0, -0.03]}>
        <sphereGeometry args={[0.105, 20, 16]} />
        <meshStandardMaterial color={color} roughness={0.6} metalness={0.05} />
      </mesh>
    </>
  );
}

/** 1人ぶんの見た目。関節は group 階層＝ボーンで、姿勢は CoupleFigure がまとめて書き込む */
function Body({ rig, color, face }: { rig: Rig; color: string; face?: FaceAvatar | null }) {
  const limbMat = <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />;
  const skinMat = <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />;
  const darkMat = <meshStandardMaterial color="#101528" roughness={0.6} metalness={0.05} />;

  return (
    <group ref={(o) => { if (o) rig.root = o; }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <circleGeometry args={[0.34, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} />
      </mesh>

      <group ref={(o) => { if (o) rig.hips = o; }} position={[0, 0.9, 0]}>
        <mesh>
          <capsuleGeometry args={[0.135, 0.1, 6, 14]} />
          {skinMat}
        </mesh>

        {/* 脚（太もも → すね → 足）。IK が太ももの姿勢と膝角を書き込む */}
        {[0, 1].map((s) => (
          <group
            key={s}
            ref={(o) => { if (o) rig.thigh[s] = o; }}
            position={[SIDE_SIGN[s] * HIP_DX, 0, 0]}
          >
            <mesh position={[0, -L_THIGH / 2, 0]} castShadow>
              <capsuleGeometry args={[0.078, L_THIGH - 0.1, 6, 12]} />
              {limbMat}
            </mesh>
            <group ref={(o) => { if (o) rig.knee[s] = o; }} position={[0, -L_THIGH, 0]}>
              <mesh position={[0, -L_SHIN / 2, 0]} castShadow>
                <capsuleGeometry args={[0.062, L_SHIN - 0.1, 6, 12]} />
                {limbMat}
              </mesh>
              {/* 足: つま先が +Z（体の前方）を向く向きで作る */}
              <group ref={(o) => { if (o) rig.foot[s] = o; }} position={[0, -L_SHIN, 0]}>
                <mesh position={[0, 0.03, 0.05]} castShadow>
                  <boxGeometry args={[0.095, 0.06, 0.23]} />
                  {darkMat}
                </mesh>
              </group>
            </group>
          </group>
        ))}

        {/* 胴 + 頭 + 腕 */}
        <group ref={(o) => { if (o) rig.spine = o; }}>
          <mesh position={[0, 0.24, 0]}>
            <capsuleGeometry args={[0.135, 0.32, 6, 14]} />
            {skinMat}
          </mesh>
          <mesh position={[0, 0.47, 0]}>
            <capsuleGeometry args={[0.045, 0.06, 4, 8]} />
            {skinMat}
          </mesh>

          {/* 頭（耳から取れる相対ヨーで回る = スポッティング） */}
          <group ref={(o) => { if (o) rig.head = o; }} position={[0, 0.58, 0]}>
            {face ? <PhotoHead avatar={face} color={color} /> : (
              <>
                <mesh>
                  <sphereGeometry args={[0.115, 20, 16]} />
                  {skinMat}
                </mesh>
                {/* 顔の向きが読めるように鼻先を出す */}
                <mesh position={[0, -0.01, 0.105]}>
                  <sphereGeometry args={[0.032, 12, 10]} />
                  {darkMat}
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
              <mesh position={[0, -L_UPARM / 2, 0]}>
                <capsuleGeometry args={[0.052, L_UPARM - 0.1, 6, 10]} />
                {limbMat}
              </mesh>
              <group ref={(o) => { if (o) rig.elbow[s] = o; }} position={[0, -L_UPARM, 0]}>
                <mesh position={[0, -L_FOREARM / 2, 0]}>
                  <capsuleGeometry args={[0.044, L_FOREARM - 0.1, 6, 10]} />
                  {limbMat}
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
  clip, timeRef, leaderColor, followerColor, leaderFace, followerFace,
}: {
  clip: MotionClip;
  timeRef: { current: number };
  leaderColor: string;
  followerColor: string;
  leaderFace?: FaceAvatar | null;
  followerFace?: FaceAvatar | null;
}) {
  // 添字 0 = リーダー, 1 = フォロワー
  const pids = useMemo<[number, number]>(
    () => [clip.leaderPid, 1 - clip.leaderPid], [clip.leaderPid]);
  const guides = useMemo(
    () => [buildGuide(clip, pids[0]), buildGuide(clip, pids[1])], [clip, pids]);
  const holds = useMemo(() => buildHolds(clip), [clip]);
  const rigs = useRef<[Rig, Rig]>([newRig(), newRig()]).current;

  useFrame(() => {
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
    if (smp[0].inRange && smp[1].inRange) {
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
      rig.spine.position.y = damp(rig.spine.position.y, -dip * 0.02, 0.3);

      // 脚: 足首の実観測があればそこへIKで運び、無ければ拍のステップで埋める
      const amp = rest ? 0 : 0.16 + Math.min(0.3, at(s, g.speed) * 0.28);
      const mirror = d === 1 ? -1 : 1;
      for (let k = 0; k < 2; k++) {
        const sign = SIDE_SIGN[k], ank = g.ank[k];
        const aw = clamp(at(s, ank.w), 0, 1);
        // 手続きの足位置（股関節ローカル）: 前後に振って、振り出す側を少し浮かす
        const sw = stepPhase * mirror * sign * amp * 0.55;
        const py = -(LEG_MAX * 0.97) + Math.max(0, stepPhase * mirror * sign) * 0.05;
        // 実データの足位置（股関節ローカル）
        const rx = at(s, ank.x) - sign * HIP_DX;
        const ry = at(s, ank.y) - hipY;
        const rz = at(s, ank.z);
        solve2Bone(rig.thigh[k], rig.knee[k], L_THIGH, L_SHIN,
          (rx) * aw, py + (ry - py) * aw, sw + (rz - sw) * aw,
          0, 0, 1); // 膝は前へ

        // 足の向き: 体ローカルでの目標を作り、脚の回転ぶんを打ち消して足に入れる
        const fw = clamp(at(s, g.footYaw[k].w), 0, 1);
        tmp.q.setFromAxisAngle(UP, at(s, g.footYaw[k].v) * fw);
        tmp.q2.copy(rig.thigh[k].quaternion).multiply(rig.knee[k].quaternion)
          .invert().multiply(tmp.q);
        rig.foot[k].quaternion.slerp(tmp.q2, 0.3);
      }

      // 首: 耳から取れる相対ヨー = スポッティング（ターンで顔だけ残る動き）
      const hw = clamp(at(s, g.headYaw.w), 0, 1);
      rig.head.rotation.y = damp(rig.head.rotation.y, at(s, g.headYaw.v) * hw, 0.35);
    }

    // ── レイヤー3: 接続。つないだ手は2人で共有する1点へ運ぶ。
    // ホールド点は両者の「つないでいる肩」の中点に置くので、必ず双方の腕が届く
    let hold: Hold | null = null;
    for (const h of holds) { if (h.t <= t + 0.01) hold = h; else break; }
    const linked: (0 | 1 | null)[] = [null, null];
    if (hold && smp[0].inRange && smp[1].inRange) {
      linked[0] = hold.leader; linked[1] = hold.follower;
      // 技イベント中は手を頭上へ上げる（ターンをくぐらせる/くぐる）
      let lift = 0;
      for (const ev of clip.events) {
        if (ev.type !== 'Turn') continue;
        const dur = 1.6 + ((ev.rotations ?? 1) - 1) * 0.5;
        const prog = (t - (ev.t - 0.4)) / dur;
        if (prog >= 0 && prog <= 1) lift = Math.max(lift, Math.sin(prog * Math.PI));
      }
      shoulderWorld(rigs[0], linked[0]!, tmp.a);
      shoulderWorld(rigs[1], linked[1]!, tmp.b);
      // 中点なら「肩からの距離」が両者で等しく最小になる = いちばん届きやすい点
      tmp.hold.addVectors(tmp.a, tmp.b).multiplyScalar(0.5);
      // 上下オフセットは残りの可動域ぶんしか取れない。ここを無視すると
      // ターンで手を上げた瞬間に腕が伸びきって手が離れる
      const half = tmp.a.distanceTo(tmp.b) / 2;
      const maxOff = Math.sqrt(Math.max(0.0025, ARM_REACH * ARM_REACH - half * half));
      tmp.hold.y += clamp(-0.20 + lift * 0.62, -maxOff, maxOff);

      for (let d = 0; d < 2; d++) {
        const rig = rigs[d], k = linked[d]!, sign = SIDE_SIGN[k];
        // ワールドのホールド点 → 自分の肩ローカル（root は y=0・yaw のみ）
        const dx = tmp.hold.x - rig.root.position.x;
        const dz = tmp.hold.z - rig.root.position.z;
        const cy = Math.cos(rig.root.rotation.y), sy = Math.sin(rig.root.rotation.y);
        const lx = dx * cy - dz * sy, lz = dx * sy + dz * cy;
        const shY = rig.hips.position.y + rig.spine.position.y + SHO_DY;
        solve2Bone(rig.shldr[k], rig.elbow[k], L_UPARM, L_FOREARM,
          lx - sign * SHO_DX, tmp.hold.y - shY, lz,
          sign * 0.5, -1, -0.25); // 肘は下・やや外へ
      }
    }

    // ── レイヤー4: フリーの腕。体側で軽く構えて拍で揺れる
    for (let d = 0; d < 2; d++) {
      const rig = rigs[d];
      for (let k = 0; k < 2; k++) {
        if (linked[d] === k) continue;
        const sign = SIDE_SIGN[k];
        const sh = rig.shldr[k];
        sh.rotation.set(-0.30 + dip * 0.10, 0, sign * (0.42 + dip * 0.06));
        rig.elbow[k].rotation.set(damp(rig.elbow[k].rotation.x, -0.85, 0.2), 0, 0);
      }
    }
  });

  return (
    <>
      <Body rig={rigs[0]} color={leaderColor} face={leaderFace} />
      <Body rig={rigs[1]} color={followerColor} face={followerFace} />
    </>
  );
}

/** 肩 group のワールド位置（root は y=0・yaw のみなので手で展開できる） */
function shoulderWorld(rig: Rig, k: 0 | 1, out: THREE.Vector3) {
  const sign = SIDE_SIGN[k];
  const cy = Math.cos(rig.root.rotation.y), sy = Math.sin(rig.root.rotation.y);
  const lx = sign * SHO_DX;
  out.set(
    rig.root.position.x + lx * cy,
    rig.hips.position.y + rig.spine.position.y + SHO_DY,
    rig.root.position.z - lx * sy,
  );
}

export default CoupleFigure;
