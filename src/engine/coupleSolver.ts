import * as THREE from 'three';
import type { MotionClip, ArmSegment } from '../components/MocapFigure';
import { NEUTRAL_HAND } from './armPose';
import {
  L_THIGH, L_SHIN, L_UPARM, L_FOREARM, HIP_DX, SHO_DX, SHO_DY, LEG_MAX, SIDE_SIGN, HIPS_Y0, HEAD_Y,
  TORSO_R, HAND_R,
} from './rigDims';
import {
  type Guide, type PairGuide, type Hold, buildGuide, buildPair, buildHolds, sampleAt, at, segAt,
  damp, clamp, PAIR_MIN, PAIR_MAX, ARM_REACH, HOLD_LAG,
} from './coupleGuide';
import { type Capsule, bodyCapsules, segSegDist, CLOSED_BACK_ALLOW } from './rigMetrics';
import { measureArms, dumpArms } from './rigDebug';

/**
 * カップルダンスを「2体」ではなく **1つのペア** として組むリグのソルバー。
 * （2026-10-03 に CoupleFigure.tsx の useFrame から切り出した。描画は CoupleFigure、
 *   毎フレームの姿勢計算はここ。node のテストからそのまま回せる）
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

// IK の作業用（毎フレーム確保しない）
const tmp = {
  dir: new THREE.Vector3(), pole: new THREE.Vector3(), axis: new THREE.Vector3(),
  ex: new THREE.Vector3(), ey: new THREE.Vector3(), ez: new THREE.Vector3(),
  m: new THREE.Matrix4(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
  qs: new THREE.Quaternion(),
  hold: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(),
  v: new THREE.Vector3(), v2: new THREE.Vector3(), w2: new THREE.Vector3(),
  pl: new THREE.Vector3(), sh: new THREE.Vector3(), ca: new THREE.Vector3(),
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
  // 肩からの距離が腕の長さを超えたら、その肩へ寄せる。
  // 作業用は clampToArm 専用（tmp.ca）。以前は tmp.v を使っていて、呼び出し側が
  // tmp.v を的として渡す経路（フリーの腕・クローズドの手・背中支え）では
  // **的そのものが「的 − 肩」に上書きされていた**（2026-10-03 発見）。
  // フォロワーのニュートラルが胸ではなく腰の正中に出ていた（「今こしあたりにあるぞ」
  // 「何も変わっていない気がする」）のはこれ
  tmp.ca.subVectors(world, shoulder);
  const len = tmp.ca.length();
  if (len > ARM_REACH) world.copy(shoulder).addScaledVector(tmp.ca, ARM_REACH / len);
  spine.localToWorld(world);
}

type ArmBase = { spine: THREE.Object3D; shoulder: THREE.Vector3 };
/** clampToArm で動かない（＝その腕の届く範囲の中にある）か */
function reachable(arms: ArmBase[], p: THREE.Vector3) {
  for (const a of arms) {
    cv.rc.copy(p);
    clampToArm(a.spine, a.shoulder, cv.rc);
    if (cv.rc.distanceToSquared(p) > 1e-6) return false;
  }
  return true;
}

/**
 * 仕上げの検証。可動域へ丸めた（clampToArm）あとの点が、まだ誰かの体に入っていないかを
 * 最後に確かめる。丸めは体を知らないので、それまでの回避を平気で打ち消す。
 * 押し出した点が腕の届く範囲を外れるなら、「今の点 → 押し出した点」の線上で
 * **届く範囲のうち一番外**（＝食い込みが最小）の点を二分探索で取る
 */
function settleOutside(p: THREE.Vector3, bodies: Capsule[][], limbR: number, arms: ArmBase[]) {
  cv.po.copy(p);
  for (const caps of bodies) pushOutOfBody(cv.po, caps, limbR);
  if (cv.po.distanceToSquared(p) < 1e-10) return;
  if (reachable(arms, cv.po)) { p.copy(cv.po); return; }
  cv.pa.copy(p);
  let lo = 0, hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    cv.pm.lerpVectors(cv.pa, cv.po, m);
    if (reachable(arms, cv.pm)) lo = m; else hi = m;
  }
  p.lerpVectors(cv.pa, cv.po, lo);
}

/**
 * 当たり判定の余白[m]。見えている体の表面から、手・前腕の表面までこれだけ空ける。
 *
 * 体は**描画しているメッシュと同じカプセル**（rigMetrics.bodyCapsules: 胴・骨盤・首・頭・
 * スカート）で見る。旧実装は「root 軸の垂直円柱・半径 0.17（自分は 0.13）・腰〜肩の高さ帯」で、
 * 見た目（胴カプセル 0.135、胸郭はねじれ・左右シフトで root 軸からずれる）と別物だった上に、
 * 手・前腕の太さを足していなかった。胸の上・首・頭・スカートは誰も見ていなかった。
 */
const MARGIN = 0.01;
/**
 * 自分の胴を「肩→手の線」が横切るかを見るときの半径。肩関節は胴の表面から 5cm しか
 * 外に無いので、手の太さまで足すと肩自体が中に入って接線が引けない。線の判定だけは
 * 胴そのもの + 3cm で見る（旧 CYL_R_SELF_PASS と同じ 0.165）。手そのものは
 * 他と同じ式（胴 + 手 + 余白）で押し出す
 */
const SELF_ROUTE_R = TORSO_R + 0.03;
/** back_support で手を置く、女の腰中点からの距離（旧 胴円柱 0.17 + 0.05） */
const BACK_SUPPORT_R = 0.22;
// フォロワーのニュートラルポジションは engine/armPose.ts（テストから測れるように分離した）
// リーダーの手を置く肩甲骨。女の腰中点から見た極座標（半径[m]・真後ろから左へ回した角度）。
// 半径は**見えている胴体（カプセル半径 0.135）の外側**に取る。内側だと手が女の体の
// 中で止まり、背中へ回っていないように見える。実測 0.195/40° で手首は女の背面より
// 2cm 奥・体から 6cm 外、肘角 64°（＝回り込んだ形）
const CLOSED_BACK_R = 0.195;
const CLOSED_BACK_ANG = 40 * (Math.PI / 180);
// 相手を抱くと肩甲骨が外転して肩が前へ出る[m]。
// 体を 10cm 空けると肩から肩甲骨まで 0.55m あり、腕 0.522m では届かない。
// ここで 8cm 稼いで 0.47m にする（肘が 64° 曲がる余地が生まれる）
const CLOSED_SHO_FWD = 0.08;
// クローズドで男が上体を**左へ振る**角度[rad]（ユーザー図 2026-08-17 の読み取り値 40°）。
// 上から見て、女への直線から 40° ずらす = 女は男の正面ではなく**やや右前**に立つ。
// - 顔が正対しない（正対したまま近いのは「気持ち悪い」と却下された）
// - 右肩が前に出るので、女の背中へ回す右手が届きやすい
// 回すのは胸郭（spine）だけ。骨盤は女を向いたままなので足運びは変わらない
const CLOSED_YAW = 40 * (Math.PI / 180);
const cv = {
  p: new THREE.Vector3(), q: new THREE.Vector3(),
  po: new THREE.Vector3(), pa: new THREE.Vector3(), pm: new THREE.Vector3(), rc: new THREE.Vector3(),
};

/** 線分 a-b 上で p に最も近い点 */
function closestOnSeg(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const u = l2 > 1e-12
    ? clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2, 0, 1) : 0;
  return out.set(a.x + abx * u, a.y + aby * u, a.z + abz * u);
}

/**
 * 手（腕IKの目標）を体の外へ押し出す。**体は空間を占有している**。
 * 半径は「体のカプセル + 手足の太さ（limbR）+ 余白」で、自分の体にも相手の体にも同じ式。
 *
 * 押し出しは**水平方向だけ**。上へは逃がさない（手を上へ逃がすと「手を挙げて見える」、
 * back_support の却下と同じ失敗になる）。真上・真下に乗ったときは fallback の水平方向へ
 */
function pushOutOfBody(
  p: THREE.Vector3, caps: Capsule[], limbR: number, fbx = 1, fbz = 0,
) {
  for (let pass = 0; pass < 2; pass++) {
    for (const c of caps) {
      const cp = closestOnSeg(p, c.a, c.b, cv.p);
      const R = c.r + limbR + MARGIN;
      const dx = p.x - cp.x, dy = p.y - cp.y, dz = p.z - cp.z;
      if (dx * dx + dy * dy + dz * dz >= R * R) continue;
      // 同じ高さのまま、横へ「斜めの距離が R になる」ところまで出す
      const need = Math.sqrt(Math.max(0, R * R - dy * dy));
      const h = Math.hypot(dx, dz);
      if (h > 1e-5) { p.x = cp.x + (dx / h) * need; p.z = cp.z + (dz / h) * need; }
      else { p.x = cp.x + fbx * need; p.z = cp.z + fbz * need; }
    }
  }
}

/**
 * 手の目標を、肩から**まっすぐ届く**位置へ回り込ませる。
 *
 * pushOutOfBody だけでは足りない。目標を体の外へ出しても、肩と手を結ぶ線が
 * 相手の体を横切っていれば、そこへ腕を運ぶ IK は必ず体を貫通する
 * （端点が2つとも外にあることは、線分が外にあることを意味しない）。
 *
 * 横切っていたら（肩→手の線分とカプセルの芯の距離が r 未満）、芯の最近点を通る
 * 垂直な円柱とみなして、肩からの**接線**の方向へ目標を寄せる。
 */
function routeAroundBody(p: THREE.Vector3, sh: THREE.Vector3, c: Capsule, r: number) {
  if (segSegDist(sh, p, c.a, c.b, cv.p, cv.q) >= r) return;
  routeAroundCyl(p, sh.x, sh.z, cv.q.x, cv.q.z, r);
}

function routeAroundCyl(
  p: THREE.Vector3, sx: number, sz: number, cx: number, cz: number, r: number,
) {
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
// 手の前後（旧 ARM_BACK_MIN = -0.04「胸の面より奥へは入れない」）は丸めない。
// 箱の面は体の形を知らないので、通り抜けで2人が横に並ぶと両者の「胸の前」が交わらず、
// つないだ手が離れていた。手が自分の体に入らないことは胴のカプセル（pushOutOfBody）が受け持つ
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

// フェーズごとの「手を頭上へ運ぶ量」の目標。damp で滑らかに繋ぐ
const LIFT_BY_PHASE: Record<string, number> = {
  prep: 0.25, initiate: 0.8, rotate: 1, settle: 0.2,
};



/** 1人ぶんの関節（group 階層＝ボーン）。見た目のメッシュは CoupleFigure がここへ付ける */
export type Rig = {
  root: THREE.Group; hips: THREE.Group; spine: THREE.Group; head: THREE.Group;
  thigh: THREE.Group[]; knee: THREE.Group[]; foot: THREE.Group[];
  shldr: THREE.Group[]; elbow: THREE.Group[];
  cursor: { current: number };
};

/**
 * リグの関節階層を作る。位置は CoupleFigure の旧 JSX（Body）と同じ — IK はこの寸法で解く。
 *   root ─ hips(y 0.9) ┬ thigh(±HIP_DX) ─ knee(-L_THIGH) ─ foot(-L_SHIN)
 *                      └ spine ┬ head(y 0.58)
 *                              └ shldr(±SHO_DX, SHO_DY) ─ elbow(-L_UPARM)
 */
export function buildRigObjects(): Rig {
  const g = () => new THREE.Group();
  const rig: Rig = {
    root: g(), hips: g(), spine: g(), head: g(),
    thigh: [], knee: [], foot: [], shldr: [], elbow: [],
    cursor: { current: 0 },
  };
  rig.hips.position.set(0, HIPS_Y0, 0);
  rig.root.add(rig.hips);
  for (const s of [0, 1]) {
    const th = g(), kn = g(), ft = g();
    th.position.set(SIDE_SIGN[s] * HIP_DX, 0, 0);
    kn.position.set(0, -L_THIGH, 0);
    ft.position.set(0, -L_SHIN, 0);
    rig.hips.add(th); th.add(kn); kn.add(ft);
    rig.thigh[s] = th; rig.knee[s] = kn; rig.foot[s] = ft;
  }
  rig.hips.add(rig.spine);
  rig.head.position.set(0, HEAD_Y, 0);
  rig.spine.add(rig.head);
  for (const s of [0, 1]) {
    const sh = g(), el = g();
    sh.position.set(SIDE_SIGN[s] * SHO_DX, SHO_DY, 0);
    el.position.set(0, -L_UPARM, 0);
    rig.spine.add(sh); sh.add(el);
    rig.shldr[s] = sh; rig.elbow[s] = el;
  }
  return rig;
}

export type SolverOptions = {
  /** キーポーズ方式（既定 true）。false = 観測追従（`?keyPose=0`） */
  keyPose?: boolean;
  /** armTimeline を無視して holds/events 走査へ（`?armTimeline=0`） */
  noArmTimeline?: boolean;
  /** `?armDump=` の時刻窓（URL の解釈は呼び出し側） */
  dumpWindow?: number | [number, number] | null;
};

/** 直近の step で決まった腕の割り当て（計測・テスト用） */
export type SolverOut = {
  linked: (0 | 1 | null)[];
  closedL: number; closedF: number; bsHand: number;
  passing: boolean; turner: number; lift: number;
};

/**
 * 毎フレームの姿勢計算。クリップごとに1つ作り、`step(rigs, t, dt)` を呼ぶ。
 * 状態（カーソル・共有ホールド点の鈍り）はインスタンスが持つ。
 */
export class CoupleSolver {
  readonly clip: MotionClip;
  readonly guides: [Guide, Guide];
  readonly holds: Hold[];
  readonly armSegs: ArmSegment[] | undefined;
  readonly keyPose: boolean;
  readonly scripted: boolean;
  readonly pair: PairGuide;
  readonly dumpWindow: number | [number, number] | null;
  readonly armCur = { current: 0 };
  readonly liftCur = { current: 0 };
  readonly pairCur = { current: 0 };
  // つないだ手の共有点（前フレーム）。ここで鈍らせるので腕は目標をそのまま解ける
  readonly holdPos = { current: new THREE.Vector3() };
  readonly holdSame = { current: null as unknown };
  out: SolverOut = {
    linked: [null, null], closedL: -1, closedF: -1, bsHand: -1, passing: false, turner: -1, lift: 0,
  };

  constructor(clip: MotionClip, opts: SolverOptions = {}) {
    this.clip = clip;
    // 添字 0 = リーダー, 1 = フォロワー
    const pids: [number, number] = [clip.leaderPid, 1 - clip.leaderPid];
    this.guides = [buildGuide(clip, pids[0]), buildGuide(clip, pids[1])];
    this.holds = buildHolds(clip);
    // armTimeline があればそれが唯一の腕の台本（実装順序3）。無い旧クリップは holds/events 走査
    this.armSegs = opts.noArmTimeline ? undefined : clip.armTimeline?.segments;
    // キーポーズ方式（既定ON）: 関節は手書きポーズ＋拍の手続きだけで決め、
    // 観測データは「技イベント・立ち位置・向き・腰の高さ」の選択にだけ使う。
    // 腕・足首の生観測を追いかけない = ノイズ由来の絡まり・貫通が原理的に出ない
    this.keyPose = opts.keyPose ?? true;
    // 手描きクリップ（scriptedClip.ts 産）は関節データ自体が振付の正解
    this.scripted = clip.armTimeline?.source === 'scripted';
    this.pair = buildPair(clip, pids[0], pids[1]);
    this.dumpWindow = opts.dumpWindow ?? null;
  }

  /** クリップを差し替えたとき、前のソルバーの鈍り状態を引き継ぐ（手が飛ばないように） */
  inherit(prev: CoupleSolver) {
    this.armCur.current = prev.armCur.current;
    this.liftCur.current = prev.liftCur.current;
    this.pairCur.current = prev.pairCur.current;
    this.holdPos.current.copy(prev.holdPos.current);
    this.holdSame.current = prev.holdSame.current;
  }

  step(rigs: [Rig, Rig], t: number, dt: number) {
    const {
      guides, clip, holds, armSegs, keyPose, scripted, armCur, liftCur, pair, pairCur,
      holdPos, holdSame,
    } = this;
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

    // 腕の台本は上体の向き（クローズドで斜めに構える）にも要るので、ここで先に引く
    const seg = armSegs ? segAt(armSegs, t, armCur) : null;
    // クローズドで男が上体を斜めに構えている度合い（0〜1）。手を女の背中へ回すのは
    // 男だけなので、振るのも男だけ
    const closedAmt = seg && seg.phase === 'closed' &&
      (seg.leader.L === 'closed_back' || seg.leader.R === 'closed_back') ? 1 : 0;

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
      // クローズドでは男だけ上体を左へ振る（ユーザー図 2026-08-17）。骨盤は動かさないので
      // 合格済みの足運びはそのまま。顔（head は spine の子）も一緒に振れるので、
      // 「顔が正対したまま近い」不快さが消える
      const closedYaw = d === 0 ? CLOSED_YAW * closedAmt : 0;
      rig.spine.rotation.y = damp(rig.spine.rotation.y, twist + closedYaw, 0.3);

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
      // 前傾（rotation.x）は入れない。顔が正対したまま女へ近づくので、
      // ユーザーに「気持ち悪い」と却下された（2026-08-17）。斜めは**上から見た向き**

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
    // 2人の体（胴・骨盤・首・頭・スカート）。腕は体を動かさないので、このフレームはこれで固定
    const bodies = [bodyCapsules(rigs[0], 0), bodyCapsules(rigs[1], 1)];
    const torsoOf = (d: number) => bodies[d][0];   // bodyCapsules の先頭は胴

    // ── レイヤー3: 接続。つないだ手は2人で共有する1点へ運ぶ。
    // 目標生成は armTimeline（オフライン確定済みの台本）を再生する。旧クリップのみ
    // holds/events 走査へフォールバック
    const linked: (0 | 1 | null)[] = [null, null];
    let lift = 0, turner = -1, bsHand = -1;
    // クローズドポジションで相手に置く手（-1 = 置かない）
    let closedL = -1, closedF = -1;
    // 入れ替わり中（女が男を追い越す prep/pass/close）。腕を自胴から余分に逃がす
    let passing = false;
    let holdKey: unknown = null;
    if (armSegs) {
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
      passing = seg?.phase === 'prep' || seg?.phase === 'pass' || seg?.phase === 'close';
      // クローズドポジション: リーダーの手 → フォロワーの肩甲骨 / フォロワーの手 → リーダーの肩
      closedL = seg?.leader.L === 'closed_back' ? 0 : seg?.leader.R === 'closed_back' ? 1 : -1;
      closedF = seg?.follower.L === 'closed_shoulder' ? 0
        : seg?.follower.R === 'closed_shoulder' ? 1 : -1;
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
          const rig = rigs[d];
          // 手そのものを体の外へ（自分の体。相手の体は相手の番で押す）
          pushOutOfBody(tmp.hold, bodies[d], HAND_R);
          // 「肩から手までの線が体を横切らない」位置へ回り込ませる。
          // 相手の体だけでなく**自分の胴**にも当てる（実測: つなぎ腕の前腕が
          // 自胴へ 4cm 食い込んでいた）
          tmp.sh.copy(rig.shldr[linked[d]!].position);
          rig.spine.localToWorld(tmp.sh);
          for (const c of bodies[1 - d]) routeAroundBody(tmp.hold, tmp.sh, c, c.r + HAND_R + MARGIN);
          routeAroundBody(tmp.hold, tmp.sh, torsoOf(d), SELF_ROUTE_R);
          clampToArm(rig.spine, rig.shldr[linked[d]!].position, tmp.hold);
        }
      }
      // 最後に丸めたのは clampToArm（体を知らない）なので、体の外にいるかを検証して仕上げる
      settleOutside(tmp.hold, bodies, HAND_R, [
        { spine: rigs[0].spine, shoulder: rigs[0].shldr[linked[0]!].position },
        { spine: rigs[1].spine, shoulder: rigs[1].shldr[linked[1]!].position },
      ]);
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
        fRoot.x - Math.sin(fy) * BACK_SUPPORT_R,
        yLo + SHO_DY * 0.6,
        fRoot.z - Math.cos(fy) * BACK_SUPPORT_R,
      );
      clampToArm(rig.spine, rig.shldr[k].position, tmp.v);
      rig.spine.worldToLocal(tmp.v);
      const ty = tmp.v.y - rig.shldr[k].position.y;
      armPole(sign, ty, tmp.pl);
      solve2Bone(rig.shldr[k], rig.elbow[k], L_UPARM, L_FOREARM,
        tmp.v.x - rig.shldr[k].position.x, ty, tmp.v.z,
        tmp.pl.x, tmp.pl.y, tmp.pl.z, 0.35);
    }

    // ── レイヤー3.6: クローズドポジション。
    // リーダーの手はフォロワーの左肩甲骨（背面・肩より 10cm 下）、
    // フォロワーは肘を下ろしたニュートラルポジションで脇を開けて待つ。
    // **どちらの手も肩より上へは行かない**
    // （back_support が「手を挙げて見える」で却下された教訓）
    if ((closedL >= 0 || closedF >= 0) && smp[0].inRange && smp[1].inRange) {
      const place = (d: 0 | 1, k: number, target: THREE.Vector3, fwd = 0, avoid = false) => {
        const rig = rigs[d], sign = SIDE_SIGN[k];
        // 肩を前へ出す（肩甲骨の外転）。組みに入る瞬間に飛ばないよう鈍らせる
        rig.shldr[k].position.set(
          sign * SHO_DX, SHO_DY, damp(rig.shldr[k].position.z, fwd, 0.25),
        );
        // 相手の体を避ける。クローズドは腰の間隔が 0.45m しかないので、
        // 体の前 0.30m に置くニュートラルの手は**そのままだと相手の胸にめり込む**。
        // リーダーの背中へ回す手は「相手の体を回り込む」のが目的なので回り込ませないが、
        // 触れている（≤1cm）より深くは入れない
        if (avoid) {
          pushOutOfBody(target, bodies[1 - d], HAND_R);
          tmp.sh.copy(rig.shldr[k].position);
          rig.spine.localToWorld(tmp.sh);
          for (const c of bodies[1 - d]) routeAroundBody(target, tmp.sh, c, c.r + HAND_R + MARGIN);
          pushOutOfBody(target, bodies[d], HAND_R);
        } else {
          pushOutOfBody(target, bodies[1 - d], HAND_R - CLOSED_BACK_ALLOW - MARGIN);
        }
        clampToArm(rig.spine, rig.shldr[k].position, target);
        if (avoid) {
          settleOutside(target, [bodies[1 - d], bodies[d]], HAND_R,
            [{ spine: rig.spine, shoulder: rig.shldr[k].position }]);
        }
        rig.spine.worldToLocal(target);
        const ty = Math.min(target.y - rig.shldr[k].position.y, 0);   // 肩より上へは上げない
        armPole(sign, ty, tmp.pl);
        // 肩の z も引く。引かないと肩を前へ出したぶんだけ手が奥へ行き過ぎる
        solve2Bone(rig.shldr[k], rig.elbow[k], L_UPARM, L_FOREARM,
          target.x - rig.shldr[k].position.x, ty, target.z - rig.shldr[k].position.z,
          tmp.pl.x, tmp.pl.y, tmp.pl.z, 0.35);
      };
      if (closedL >= 0) {
        // フォロワーの背中側（前方の逆）、肩甲骨の高さ。左肩甲骨なので体の左へ寄せる
        const f = rigs[1], fy = f.root.rotation.y;
        const yLo = f.root.position.y + f.hips.position.y;
        // 肩甲骨の下あたり（肩より 10cm 下）。ここより高いと腕が水平に伸びて
        // 「手を挙げている」ように見える。
        // 左右は「背中の真後ろ」ではなく**背中の左寄り**（CLOSED_BACK_ANG）に置く。
        // 真後ろだと肩から一直線で、肘が伸び切って突き刺さったように見える
        const ca = Math.cos(CLOSED_BACK_ANG), sa = Math.sin(CLOSED_BACK_ANG);
        // 背中の向き = 前方の逆、左の向き = 女から見た左
        const bx = -Math.sin(fy), bz = -Math.cos(fy);
        const lx = Math.cos(fy), lz = -Math.sin(fy);
        tmp.v.set(
          f.root.position.x + (bx * ca + lx * sa) * CLOSED_BACK_R,
          yLo + SHO_DY - 0.10,
          f.root.position.z + (bz * ca + lz * sa) * CLOSED_BACK_R,
        );
        place(0, closedL, tmp.v, CLOSED_SHO_FWD);
      }
      if (closedF >= 0) {
        // フォロワーはニュートラルポジション（ユーザー指示）。
        // 肘を下ろしたまま**脇を開けて**構えると、そこが空くのでリーダーの手が
        // 背中へ回せる。相手の肩を掴みに行かせない — 掴ませると腕が上がる
        tmp.v.set(
          SIDE_SIGN[closedF] * NEUTRAL_HAND[0],
          rigs[1].shldr[closedF].position.y + NEUTRAL_HAND[1],
          NEUTRAL_HAND[2],
        );
        rigs[1].spine.localToWorld(tmp.v);
        place(1, closedF, tmp.v, 0, true);   // 相手の胴を避ける（組むと 0.37m しか離れていない）
      }
    }

    // ── レイヤー4: フリーの腕。実データがあればそれを目標に、無ければ体側で軽く構えて拍で揺れる
    for (let d = 0; d < 2; d++) {
      const rig = rigs[d], g = guides[d], s = smp[d];
      for (let k = 0; k < 2; k++) {
        if (linked[d] === k) continue;
        if (d === 0 && k === bsHand) continue;   // back_support 中の手はレイヤー3.5が持つ
        if (d === 0 && k === closedL) continue;  // クローズドの手はレイヤー3.6が持つ
        if (d === 1 && k === closedF) continue;
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
          } else if (d === 1) {
            // **フォロワーの空き手は常にニュートラルポジション**（ユーザー指示 2026-08-16:
            // 「基本的に女性は何もしてないときはニュートラルに。脇を開けてないと
            //   クローズドで背中に手を回せない」）。
            // クローズド中（レイヤー3.6）と同じ的なので、組む前後で手が飛ばない
            tmp.v.set(
              sign * NEUTRAL_HAND[0], SHO_DY + NEUTRAL_HAND[1] + dip * 0.03, NEUTRAL_HAND[2],
            );
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
          pushOutOfBody(tmp.v, bodies[o], HAND_R);
          // 自分の胴体にも適用する。目標を外へ出すだけでは、肩→手の線分が
          // 自分の胴を横切るケース（実測: 前腕が自胴へ 12cm 食い込む）を防げない
          if (o === d) routeAroundBody(tmp.v, tmp.sh, torsoOf(d), SELF_ROUTE_R);
          else for (const c of bodies[o]) routeAroundBody(tmp.v, tmp.sh, c, c.r + HAND_R + MARGIN);
        }
        settleOutside(tmp.v, bodies, HAND_R, [{ spine: rig.spine, shoulder: sh.position }]);
        rig.spine.worldToLocal(tmp.v);
        const ty = tmp.v.y - sh.position.y;
        armPole(sign, ty, tmp.pl);
        solve2Bone(sh, rig.elbow[k], L_UPARM, L_FOREARM,
          tmp.v.x - sh.position.x, ty, tmp.v.z,
          tmp.pl.x, tmp.pl.y, tmp.pl.z, w);
      }
    }

    measureArms(rigs, linked, dt);
    dumpArms(rigs, linked, t, holdPos.current, this.dumpWindow);
    this.out = { linked, closedL, closedF, bsHand, passing, turner, lift };
  }
}
