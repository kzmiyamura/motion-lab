import * as THREE from 'three';
import type { Rig } from './coupleSolver';
import {
  L_UPARM, L_FOREARM, L_THIGH, L_SHIN, SIDE_SIGN,
  TORSO_Y, TORSO_R, TORSO_LEN, PELVIS_R, PELVIS_LEN, NECK_Y, NECK_R, NECK_LEN, HEAD_R,
  UPARM_R, FOREARM_R, HAND_R, THIGH_R, SHIN_R,
} from './rigDims';

/**
 * リグの「見えている体」を測る道具。姿勢の良し悪しを目視ではなく数字で決めるために使う
 * （rigQuality.test.ts が全クリップを回してこれで採点する）。
 *
 * 体は**描画しているメッシュと同じ寸法のカプセル**で表す（rigDims.ts）。
 * 旧実装の当たり判定（root 軸の円柱・半径 0.17/0.13・腰〜肩の高さ帯だけ）は
 * 見た目と別物で、胸の上・首・頭・スカート・脚は誰も見ていなかった。
 */

export type Part =
  | 'torso' | 'pelvis' | 'neck' | 'head' | 'skirt'
  | 'upperarm' | 'forearm' | 'hand' | 'thigh' | 'shin';

/** 線分 a-b を芯にした半径 r のカプセル（a=b なら球）。座標はワールド */
export type Capsule = {
  a: THREE.Vector3; b: THREE.Vector3; r: number;
  part: Part; owner: 0 | 1; side: 0 | 1 | -1;
};

/**
 * スカート（円錐台: 上端 r0.155・下端 r0.28・高さ 0.36・腰から -0.16 中心）を
 * 2本の短いカプセルで近似する（hips ローカルの y 区間と半径）。
 * 上は腰まわりにぴったり、下は裾の広がりを 2〜5cm 内側に見積もる（取りこぼし側の誤差）
 */
export const SKIRT_CAPS: readonly (readonly [number, number, number])[] = [
  [-0.06, -0.12, 0.18],
  [-0.22, -0.26, 0.24],
];

const v3 = () => new THREE.Vector3();
const cap = (
  o: THREE.Object3D, ay: number, by: number, r: number, part: Part, owner: 0 | 1, side: 0 | 1 | -1,
): Capsule => ({
  a: o.localToWorld(v3().set(0, ay, 0)),
  b: o.localToWorld(v3().set(0, by, 0)),
  r, part, owner, side,
});

/** 手首（＝手の球の中心）のワールド位置 */
export function wristWorld(rig: Rig, k: number, out = v3()) {
  return rig.elbow[k].localToWorld(out.set(0, -L_FOREARM, 0));
}

/**
 * 胴・骨盤・首・頭（＋スカート）だけ。手足が避けるべき「体」。**先頭は必ず胴**。
 * CoupleSolver の当たり判定もこれを使う（見えている体 = 当たる体）
 */
export function bodyCapsules(rig: Rig, owner: 0 | 1, dress = owner === 1): Capsule[] {
  const out: Capsule[] = [
    cap(rig.spine, TORSO_Y - TORSO_LEN / 2, TORSO_Y + TORSO_LEN / 2, TORSO_R, 'torso', owner, -1),
    cap(rig.hips, -PELVIS_LEN / 2, PELVIS_LEN / 2, PELVIS_R, 'pelvis', owner, -1),
    cap(rig.spine, NECK_Y - NECK_LEN / 2, NECK_Y + NECK_LEN / 2, NECK_R, 'neck', owner, -1),
    cap(rig.head, 0, 0, HEAD_R, 'head', owner, -1),
  ];
  if (dress) for (const [a, b, r] of SKIRT_CAPS) out.push(cap(rig.hips, a, b, r, 'skirt', owner, -1));
  return out;
}

/**
 * 1人ぶんの体と手足をカプセルの列にする。ワールド行列は呼び出し側で確定させておくこと
 * （rig.root.updateMatrixWorld(true)）。
 * @param dress スカートを持つか（フォロワー）
 */
export function capsules(rig: Rig, owner: 0 | 1, dress = owner === 1): Capsule[] {
  const out = bodyCapsules(rig, owner, dress);
  for (const k of [0, 1] as const) {
    out.push(cap(rig.shldr[k], 0, -L_UPARM, UPARM_R, 'upperarm', owner, k));
    out.push(cap(rig.elbow[k], 0, -L_FOREARM, FOREARM_R, 'forearm', owner, k));
    out.push(cap(rig.elbow[k], -L_FOREARM, -L_FOREARM, HAND_R, 'hand', owner, k));
    out.push(cap(rig.thigh[k], 0, -L_THIGH, THIGH_R, 'thigh', owner, k));
    out.push(cap(rig.knee[k], 0, -L_SHIN, SHIN_R, 'shin', owner, k));
  }
  return out;
}

/**
 * 2線分の最短距離（Ericson, Real-Time Collision Detection 5.1.9）。
 * 点（a=b）どうし・点と線分・平行な線分もそのまま扱える。
 * cp1/cp2 を渡すと最近点を書き込む
 */
export function segSegDist(
  p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3,
  cp1?: THREE.Vector3, cp2?: THREE.Vector3,
): number {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const x1 = p1.x + d1x * s, y1 = p1.y + d1y * s, z1 = p1.z + d1z * s;
  const x2 = p2.x + d2x * t, y2 = p2.y + d2y * t, z2 = p2.z + d2z * t;
  cp1?.set(x1, y1, z1);
  cp2?.set(x2, y2, z2);
  return Math.hypot(x1 - x2, y1 - y2, z1 - z2);
}

/** カプセルどうしの食い込み[m]（正 = 貫通） */
export const capDepth = (A: Capsule, B: Capsule) => A.r + B.r - segSegDist(A.a, A.b, B.a, B.b);

export type PenCategory = 'armPartner' | 'armSelf' | 'legPartner' | 'legSelf';
export const PEN_CATEGORIES: PenCategory[] = ['armPartner', 'armSelf', 'legPartner', 'legSelf'];

/** 意図した接触。closedBack = クローズドで女の背中に置いているリーダーの手（0/1, -1 = なし） */
export type AllowList = { closedBack?: number };
/** 背中に置いた手の許容（見た目で「触れている」範囲） */
export const CLOSED_BACK_ALLOW = 0.01;
/**
 * 自分の上腕は付け根が胴に埋まっているのが正しい形（肩関節は胴の中）。
 * 肩から上腕の 35% までは自胴との判定から外す
 */
export const OWN_UPARM_SKIP = 0.35;

const BODY: Part[] = ['torso', 'pelvis', 'neck', 'head', 'skirt'];
const ARM: Part[] = ['upperarm', 'forearm', 'hand'];
const LEG: Part[] = ['thigh', 'shin'];

export type PenHit = { cat: PenCategory; depth: number; who: 0 | 1; limb: Part; side: number; body: Part };

/**
 * このフレームの食い込みをカテゴリごとの最大値で返す（無ければ 0）。
 * - armPartner: 腕（上腕・前腕・手）→ 相手の胴・骨盤・首・頭・スカート
 * - armSelf:    腕 → 自分の胴・骨盤・首・頭・スカート（上腕の付け根は除く）
 * - legPartner: 脚（太もも・すね）→ 相手の脚・スカート
 * - legSelf:    左脚 ↔ 右脚
 * 手と手（つないだ手）は数えない（そもそもカテゴリに無い）。
 */
export function penetrations(
  rigs: [Rig, Rig], allow: AllowList = {}, hits?: PenHit[],
): Record<PenCategory, number> {
  const caps = [capsules(rigs[0], 0), capsules(rigs[1], 1)];
  const res: Record<PenCategory, number> = { armPartner: 0, armSelf: 0, legPartner: 0, legSelf: 0 };
  const note = (cat: PenCategory, depth: number, who: 0 | 1, limb: Capsule, body: Capsule) => {
    if (depth > res[cat]) res[cat] = depth;
    if (hits && depth > 0) hits.push({ cat, depth, who, limb: limb.part, side: limb.side, body: body.part });
  };
  const tmpA = v3();
  for (const d of [0, 1] as const) {
    const mine = caps[d], other = caps[1 - d];
    for (const A of mine) {
      if (ARM.includes(A.part)) {
        for (const B of other) {
          if (!BODY.includes(B.part)) continue;
          let depth = capDepth(A, B);
          // クローズドの背中の手（と前腕）は女の胴に触れていてよい
          if (d === 0 && allow.closedBack === A.side && (A.part === 'hand' || A.part === 'forearm') &&
              (B.part === 'torso' || B.part === 'neck')) depth -= CLOSED_BACK_ALLOW;
          note('armPartner', depth, d, A, B);
        }
        for (const B of mine) {
          if (!BODY.includes(B.part)) continue;
          let depth: number;
          if (A.part === 'upperarm') {
            tmpA.lerpVectors(A.a, A.b, OWN_UPARM_SKIP);
            depth = A.r + B.r - segSegDist(tmpA, A.b, B.a, B.b);
          } else depth = capDepth(A, B);
          note('armSelf', depth, d, A, B);
        }
      } else if (LEG.includes(A.part)) {
        for (const B of other) {
          if (!LEG.includes(B.part) && B.part !== 'skirt') continue;
          note('legPartner', capDepth(A, B), d, A, B);
        }
        if (A.side === 0) {
          for (const B of mine) {
            if (LEG.includes(B.part) && B.side === 1) note('legSelf', capDepth(A, B), d, A, B);
          }
        }
      }
    }
  }
  return res;
}

// ── 関節角
const R2D = 180 / Math.PI;
const DOWN = new THREE.Vector3(0, -1, 0);
const qa = new THREE.Quaternion();
const va = v3(), vb = v3(), vc = v3(), vd = v3();

/** u まわりに from → to が回る符号付き角[rad]（両方を u に垂直な面へ射影して測る） */
function signedAngleAbout(from: THREE.Vector3, to: THREE.Vector3, u: THREE.Vector3) {
  const f = vc.copy(from).addScaledVector(u, -from.dot(u));
  const t = vd.copy(to).addScaledVector(u, -to.dot(u));
  if (f.lengthSq() < 1e-10 || t.lengthSq() < 1e-10) return NaN;
  const cross = va.crossVectors(f, t).dot(u);
  return Math.atan2(cross, f.dot(t));
}

/**
 * 骨の「捻り」[deg]: 骨を真下から u へ最短で振った（swing）ときに、基準の向き ref が
 * 行く先と、実際の「関節の出っ張り」（骨ローカル +Z = solve2Bone のポール側 =
 * 肘頭・膝頭）との角度差。正 = 外旋。
 */
function twistDeg(q: THREE.Quaternion, sign: number, ref: THREE.Vector3) {
  const u = vb.copy(DOWN).applyQuaternion(q);
  const c = v3().set(0, 0, 1).applyQuaternion(q);
  qa.setFromUnitVectors(DOWN, u);
  const r = v3().copy(ref).applyQuaternion(qa);
  const a = signedAngleAbout(r, c, u);
  return -sign * a * R2D;
}

/**
 * 肩（上腕の向きと捻り）が LIMITS の範囲を超えた量の合計[deg]。jointAngles / limitExcess と
 * 同じ測り方。ソルバーが肘の振りを選ぶときに「可動域を超える振り」を避けるのに使う
 */
export function shoulderExcess(rig: Rig, k: number): number {
  const sign = SIDE_SIGN[k];
  const q = rig.shldr[k].quaternion;
  const u = v3().copy(DOWN).applyQuaternion(q);
  const elev = Math.acos(Math.max(-1, Math.min(1, -u.y))) * R2D;
  const ext = Math.asin(Math.max(0, Math.min(1, -u.z))) * R2D;
  const cross = Math.asin(Math.max(0, Math.min(1, -u.x * sign))) * R2D;
  let sum = Math.max(0, elev - LIMITS.shoulderFlex) + Math.max(0, ext - LIMITS.shoulderExt) +
    Math.max(0, cross - LIMITS.shoulderCross) +
    (u.z < -0.3 ? Math.max(0, elev - LIMITS.shoulderForbiddenElev) : 0);
  if (elev <= 160) {
    const tw = twistDeg(q, sign, v3().set(0, 0, -1));
    if (Number.isFinite(tw)) sum += Math.max(0, LIMITS.twistMin - tw, tw - LIMITS.twistMax);
  }
  return sum;
}

export type ArmAngles = {
  /** 上腕の挙上（0 = 真下、90 = 水平、180 = 真上） */
  elev: number;
  /** 伸展（上腕が胸の面より後ろへ出た角） */
  ext: number;
  /** 体を横切る内転（正中を越えた角） */
  cross: number;
  /** 上腕の捻り（正 = 外旋）。腕がほぼ真上（挙上 > 160°）では NaN */
  twist: number;
  /** 肘の含む角（180 = まっすぐ） */
  elbow: number;
  /** 上腕の向き（胸郭ローカル）の z。負 = 肘が背中側 */
  backZ: number;
};
export type LegAngles = {
  /** 屈曲（正）/ 伸展（負）。矢状面へ射影 */
  flex: number;
  /** 外転（正）/ 内転（負）。前額面へ射影 */
  abd: number;
  /** 回旋（正 = 外旋）。膝頭の向き */
  rot: number;
};
export type JointAngles = {
  arm: [ArmAngles, ArmAngles];
  leg: [LegAngles, LegAngles];
  /** 骨盤に対する胸郭のヨー（絶対値） */
  trunkTwist: number;
  /** 胸郭に対する頭の回転角（絶対値） */
  headChest: number;
};

/**
 * 関節角を解剖学の言葉で測る。肩は胸郭ローカル、股関節は骨盤ローカル
 * （どちらも +X = 本人の左・+Y = 上・+Z = 前）。
 */
export function jointAngles(rig: Rig): JointAngles {
  const arm = [0, 1].map((k) => {
    const sign = SIDE_SIGN[k];
    const q = rig.shldr[k].quaternion;
    const u = v3().copy(DOWN).applyQuaternion(q);
    const elev = Math.acos(Math.max(-1, Math.min(1, -u.y))) * R2D;
    // 中立: 腕を下ろして肘を曲げたとき、肘頭は真後ろ（-Z）
    const twist = elev > 160 ? NaN : twistDeg(q, sign, v3().set(0, 0, -1));
    return {
      elev,
      ext: Math.asin(Math.max(0, Math.min(1, -u.z))) * R2D,
      cross: Math.asin(Math.max(0, Math.min(1, -u.x * sign))) * R2D,
      twist,
      elbow: 180 - rig.elbow[k].rotation.x * R2D,
      backZ: u.z,
    };
  }) as [ArmAngles, ArmAngles];
  const leg = [0, 1].map((k) => {
    const sign = SIDE_SIGN[k];
    const q = rig.thigh[k].quaternion;
    const u = v3().copy(DOWN).applyQuaternion(q);
    return {
      flex: Math.atan2(u.z, -u.y) * R2D,
      abd: Math.atan2(u.x * sign, -u.y) * R2D,
      // 中立: 膝頭は前（+Z）
      rot: twistDeg(q, sign, v3().set(0, 0, 1)),
    };
  }) as [LegAngles, LegAngles];
  const f = v3().set(0, 0, 1).applyQuaternion(rig.spine.quaternion);
  const trunkTwist = Math.abs(Math.atan2(f.x, f.z)) * R2D;
  const hq = rig.head.quaternion;
  const headChest = 2 * Math.acos(Math.min(1, Math.abs(hq.w))) * R2D;
  return { arm, leg, trunkTwist, headChest };
}

/** 関節の可動域（ユーザー合意前の目安。超えた量を数えるだけで、丸めはしない） */
export const LIMITS = {
  shoulderFlex: 170,       // 挙上の上限
  shoulderExt: 50,
  shoulderCross: 40,
  shoulderForbiddenElev: 100,   // これより上げて肘が背中側（backZ < -0.3）は人体で不可
  twistMin: -70, twistMax: 90,
  elbowMin: 30,
  hipFlex: 120, hipExt: 20, hipAbd: 45, hipAdd: 25, hipRot: 40,
  trunkTwist: 50,
  headChest: 75,
} as const;

export type LimitKey =
  | 'shoulderFlex' | 'shoulderExt' | 'shoulderCross' | 'shoulderForbidden' | 'humeralTwist'
  | 'elbow' | 'hipFlex' | 'hipExt' | 'hipAbd' | 'hipAdd' | 'hipRot' | 'trunkTwist' | 'headChest';
export const LIMIT_KEYS: LimitKey[] = [
  'shoulderFlex', 'shoulderExt', 'shoulderCross', 'shoulderForbidden', 'humeralTwist',
  'elbow', 'hipFlex', 'hipExt', 'hipAbd', 'hipAdd', 'hipRot', 'trunkTwist', 'headChest',
];

/**
 * 可動域の超過量[deg]（0 = 範囲内）を関節インスタンスごとに列挙する。
 * 腕・脚は左右の2件、体幹・首は1件
 */
export function limitExcess(a: JointAngles): [LimitKey, number][] {
  const out: [LimitKey, number][] = [];
  const over = (v: number, lim: number) => Math.max(0, v - lim);
  for (const s of a.arm) {
    out.push(['shoulderFlex', over(s.elev, LIMITS.shoulderFlex)]);
    out.push(['shoulderExt', over(s.ext, LIMITS.shoulderExt)]);
    out.push(['shoulderCross', over(s.cross, LIMITS.shoulderCross)]);
    out.push(['shoulderForbidden',
      s.backZ < -0.3 ? over(s.elev, LIMITS.shoulderForbiddenElev) : 0]);
    if (Number.isFinite(s.twist)) {
      out.push(['humeralTwist',
        Math.max(0, LIMITS.twistMin - s.twist, s.twist - LIMITS.twistMax)]);
    }
    out.push(['elbow', Math.max(0, LIMITS.elbowMin - s.elbow)]);
  }
  for (const l of a.leg) {
    out.push(['hipFlex', over(l.flex, LIMITS.hipFlex)]);
    out.push(['hipExt', over(-l.flex, LIMITS.hipExt)]);
    out.push(['hipAbd', over(l.abd, LIMITS.hipAbd)]);
    out.push(['hipAdd', over(-l.abd, LIMITS.hipAdd)]);
    if (Number.isFinite(l.rot)) out.push(['hipRot', over(Math.abs(l.rot), LIMITS.hipRot)]);
  }
  out.push(['trunkTwist', over(a.trunkTwist, LIMITS.trunkTwist)]);
  out.push(['headChest', over(a.headChest, LIMITS.headChest)]);
  return out;
}

/** つないだ手の離れ[m]。両者の手首（手の球の中心）の距離。つないでいなければ null */
export function holdGap(rigs: [Rig, Rig], linked: (0 | 1 | null)[]): number | null {
  if (linked[0] === null || linked[1] === null) return null;
  return wristWorld(rigs[0], linked[0]).distanceTo(wristWorld(rigs[1], linked[1]));
}
