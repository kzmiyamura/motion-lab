import type { MotionClip, ArmSegment } from '../components/MocapFigure';

/**
 * 手描きの CBL（クロスボディリード）クリップ。動画データは一切使わない。
 *
 * 「復元がきれいに出たらこう見えるはず」という正解を先に作るためのもの。
 * MotionClip の形で合成するので、再生・スロー・シーク・IK・貫通回避は
 * ハイブリッド経路（CoupleFigure + keyPose）がそのまま面倒を見る。
 *
 * 振付（32拍ループ = ベーシック8拍 + CBL8拍 を、立ち位置を入れ替えて2回）:
 *   スロットは X 軸。リーダーは 1-2 で前後のブレイク、3 でスロットの外へ開き、
 *   5-6-7 でフォロワーがスロットを通過して 180° 向き直る。後半 16 拍は
 *   全体を 180° 回した同じ振付なので、ループの継ぎ目が飛ばない。
 */

const BPM = 170;
const SPB = 60 / BPM;          // 1拍の秒数
const LOOP_BEATS = 32;
const FPS = 30;

// 関節インデックス（MocapFigure の J と同じ並び・19関節）
const N_JOINTS = 19;
const LSHO = 1, RSHO = 2, LHIP = 7, RHIP = 8, LEAR = 13, REAR = 14;
const HIP_HALF = 0.10, SHO_HALF = 0.185, EAR_HALF = 0.08;
const SHO_DY = 0.40, EAR_DY = 0.62;

// 拍ごとのキーポーズ [x, z, yaw(度)]。前半16拍ぶんを書き、後半は180°回して再利用
// リーダー: 9 で前進ブレイク → 10-11 でスロット外へ開く → 13-15 で元フォロワー位置へ
const KEY_L: [number, number, number][] = [
  [-0.35, 0.00,  90], // 0  基本ホールド
  [-0.23, 0.00,  90], // 1  前進ブレイク（左足）
  [-0.33, 0.00,  90], // 2  戻す
  [-0.35, 0.00,  90], // 3
  [-0.35, 0.00,  90], // 4  休符
  [-0.47, 0.00,  90], // 5  後退ブレイク
  [-0.37, 0.00,  90], // 6
  [-0.35, 0.00,  90], // 7
  [-0.35, 0.00,  90], // 8  休符（CBL へ）
  [-0.23, 0.02,  95], // 9  前進ブレイク = CBL の合図
  [-0.33, 0.12, 120], // 10 スロットの外へ開き始める
  [-0.28, 0.45, 180], // 11 スロット脇・通り道を向く（肩幅ぶんしっかり空ける）
  [-0.28, 0.45, 180], // 12 休符
  [-0.18, 0.46, 215], // 13 フォロワーを通しながら回り込む
  [ 0.10, 0.28, 245], // 14
  [ 0.30, 0.06, 265], // 15
  [ 0.35, 0.00, 270], // 16 = 後半の頭（180°回した 0 拍目と一致）
];
// フォロワー: 9 で後退ブレイク → 11 でスロットへ前進 → 13-15 で通過し 180° ターン
const KEY_F: [number, number, number][] = [
  [ 0.35, 0.00,  -90],
  [ 0.47, 0.00,  -90], // 1  後退ブレイク（リーダーと鏡）
  [ 0.37, 0.00,  -90],
  [ 0.35, 0.00,  -90],
  [ 0.35, 0.00,  -90],
  [ 0.23, 0.00,  -90], // 5  前進ブレイク
  [ 0.33, 0.00,  -90],
  [ 0.35, 0.00,  -90],
  [ 0.35, 0.00,  -90],
  [ 0.47, 0.00,  -90], // 9  後退ブレイク
  [ 0.38, 0.00,  -90], // 10
  [ 0.25, 0.00,  -90], // 11 スロットへ前進
  [ 0.25, 0.00,  -90], // 12 休符
  [-0.05, 0.00,  -95], // 13 スロットを通過
  [-0.30, 0.00, -140], // 14 通過しながら向き直り始める
  [-0.42, 0.00, -230], // 15 180° ターン
  [-0.35, 0.00, -270], // 16 = 後半の頭
];
// 腰の高さ。通過中は膝を使って少し沈む
const KEY_HIPY = [0.96, 0.96, 0.96, 0.96, 0.96, 0.96, 0.96, 0.96,
  0.96, 0.96, 0.95, 0.94, 0.94, 0.93, 0.94, 0.95, 0.96];

const D2R = Math.PI / 180;
const smoothstep = (u: number) => u * u * (3 - 2 * u);

// ── 足運び ───────────────────────────────────────────────
// サルサの足は「カウントに合わせて1歩ずつ踏む。それ以外は床に着いたまま」。
// キーは [拍, 前後位置(体ローカルz, +が前)]。拍の 0.35 拍前から動き出して
// 拍ちょうどに着地する。移動中だけ足首が浮く。
type FootKey = [number, number];
const STEP_DUR = 0.35;          // 1歩にかける拍数
const ANKLE_Y = 0.08;           // 接地時の足首高さ
const STEP_LIFT = 0.07;         // 移動中に浮く高さ
const FOOT_LATERAL = 0.09;      // 足のスタンス幅（体ローカルx）

/** 8拍周期の足前後位置と浮き。keys は拍順・先頭は「0拍時点の位置」 */
function footAt(keys: FootKey[], beat8: number): { z: number; lift: number } {
  let prev = keys[keys.length - 1][1];   // 周回前の最後の位置から始まる
  for (const [kb, kz] of keys) {
    if (beat8 >= kb) { prev = kz; continue; }
    if (beat8 >= kb - STEP_DUR) {
      const u = smoothstep((beat8 - (kb - STEP_DUR)) / STEP_DUR);
      return { z: prev + (kz - prev) * u, lift: Math.sin(u * Math.PI) * STEP_LIFT };
    }
    return { z: prev, lift: 0 };
  }
  return { z: prev, lift: 0 };
}

export type Timing = 'on1' | 'on2';
const BREAK = 0.28;             // ブレイクの歩幅

/**
 * ベーシックの足運び（8拍）。男女で動かす足と方向が対になっているので
 * 絶対に足を踏み合わない:
 *   On1: カウント1 = リーダー左足を**前**へ / フォロワー右足を**後ろ**へ。5で逆側
 *   On2: 同じ足を**逆方向**へ（リーダー左足は後ろ、フォロワー右足は前）
 * 3・7 で出した足を元へ戻す。4・8 は休符（両足接地のまま）
 */
function basicFootKeys(role: 'leader' | 'follower', timing: Timing): [FootKey[], FootKey[]] {
  // リーダー On1: 左足が 1 で前(+)・3 で戻る。右足が 5 で後ろ(-)・7 で戻る
  let first = BREAK, second = -BREAK;                 // [1で動く足の行き先, 5で動く足の行き先]
  if (role === 'follower') { first = -first; second = -second; }  // 女は鏡
  if (timing === 'on2') { first = -first; second = -second; }     // On2 は方向が逆
  const moveOn1: FootKey[] = [[0, 0], [1, first], [3, 0]];        // 1で出す足
  const moveOn5: FootKey[] = [[0, 0], [5, second], [7, 0]];       // 5で出す足
  // 1で動くのは「リーダー左足・フォロワー右足」。これは On1/On2 共通
  return role === 'leader' ? [moveOn1, moveOn5] : [moveOn5, moveOn1];  // [左足, 右足]
}

/** 拍位置のポーズ。整数拍のキーを smoothstep で中割りし、後半16拍は 180° 回す */
function poseAt(keys: [number, number, number][], beat: number): [number, number, number] {
  const b = ((beat % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  const flip = b >= 16;
  const bb = flip ? b - 16 : b;
  const i = Math.min(15, Math.floor(bb));
  const s = smoothstep(bb - i);
  const a = keys[i], c = keys[i + 1];
  let x = a[0] + (c[0] - a[0]) * s;
  let z = a[1] + (c[1] - a[1]) * s;
  let yaw = (a[2] + (c[2] - a[2]) * s) * D2R;
  if (flip) { x = -x; z = -z; yaw += Math.PI; }
  return [x, z, yaw];
}

function hipYAt(beat: number) {
  const b = ((beat % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  const bb = b >= 16 ? b - 16 : b;
  const i = Math.min(15, Math.floor(bb));
  const s = smoothstep(bb - i);
  return KEY_HIPY[i] + (KEY_HIPY[i + 1] - KEY_HIPY[i]) * s;
}

const wrapPi = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * 1人ぶんの関節を置く。buildGuide が読むのは腰（位置と向き）・肩（ねじれ）・
 * 耳（頭の向き）だけなので、それ以外は v=0 のまま — 腕と脚はキーポーズ側が描く。
 */
const LANK = 11, RANK = 12;

function placeJoints(
  x: number, z: number, yaw: number, hipY: number,
  lookX: number, lookZ: number,
  feet?: [{ z: number; lift: number }, { z: number; lift: number }],  // [左, 右] 体ローカル
  feetAnchor?: [number, number],  // 足の基準点（省略時は腰）。着地した足は体が揺れても
                                  // ワールドで動かない — 基準を腰にすると足が床を滑る
): { r: number[]; j: number[]; v: number[] } {
  const j = new Array<number>(N_JOINTS * 3).fill(0);
  const v = new Array<number>(N_JOINTS).fill(0);
  // 「右-左」= (-cosθ·w, sinθ·w) と置くと buildGuide の式でちょうど yaw=θ が出る
  const put = (li: number, ri: number, half: number, y: number, th: number) => {
    j[li * 3] = x + Math.cos(th) * half; j[li * 3 + 1] = y; j[li * 3 + 2] = z - Math.sin(th) * half;
    j[ri * 3] = x - Math.cos(th) * half; j[ri * 3 + 1] = y; j[ri * 3 + 2] = z + Math.sin(th) * half;
    v[li] = 1; v[ri] = 1;
  };
  put(LHIP, RHIP, HIP_HALF, hipY, yaw);
  put(LSHO, RSHO, SHO_HALF, hipY + SHO_DY, yaw);   // 肩は腰と同じ向き = ねじれ 0
  // 頭は相手を見る（スポッティングの代わり）。体からの相対 ±60° に収める
  const want = Math.atan2(lookX - x, lookZ - z);
  const rel = Math.max(-1.05, Math.min(1.05, wrapPi(want - yaw)));
  put(LEAR, REAR, EAR_HALF, hipY + EAR_DY, yaw + rel);
  // 足首（体ローカル → ワールド）。授けたときだけ v を立て、リグはこれをそのまま踏む
  if (feet) {
    const [ax, az] = feetAnchor ?? [x, z];
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const putFoot = (idx: number, lx: number, f: { z: number; lift: number }) => {
      j[idx * 3] = ax + lx * cy + f.z * sy;
      j[idx * 3 + 1] = ANKLE_Y + f.lift;
      j[idx * 3 + 2] = az - lx * sy + f.z * cy;
      v[idx] = 1;
    };
    putFoot(LANK, FOOT_LATERAL, feet[0]);
    putFoot(RANK, -FOOT_LATERAL, feet[1]);
  }
  return { r: [], j, v };
}

/** ホールドは常時「リーダー左手 × フォロワー右手」の片手。CBL の pass で背中を支える */
function buildSegments(): ArmSegment[] {
  const hold = { leader: 'L', follower: 'R' } as const;
  const free = { L: 'free', R: 'free' } as const;
  const seg = (b0: number, b1: number, phase: string, leaderR: 'free' | 'back_support'): ArmSegment => ({
    t0: b0 * SPB, t1: b1 * SPB, phase, hold,
    leader: { L: 'hold', R: leaderR }, follower: { ...free, R: 'hold' },
    confidence: 'observed',
  });
  const half = (o: number) => [
    seg(o + 0, o + 9, 'hold', 'free'),
    seg(o + 9, o + 10, 'prep', 'free'),
    seg(o + 10, o + 13, 'pass', 'back_support'),
    seg(o + 13, o + 16, 'close', 'free'),
  ];
  return [...half(0), ...half(16)];
}

/**
 * 手描きベーシック（8拍ループ・On1/On2）。動画は使わない。
 * 体の前後の揺れは足のブレイクに同期し、足は正しい側・正しい方向へ踏む。
 */
export function buildScriptedBasic(timing: Timing): MotionClip {
  const duration = 8 * SPB;
  const dir = timing === 'on1' ? 1 : -1;
  // 「1で踏み込む側」への体の揺れ（前方成分）。1で最大、3で戻り、5で逆へ
  const SWAY = [0, 0.12, 0.02, 0, 0, -0.12, -0.02, 0, 0];
  const footL = basicFootKeys('leader', timing);
  const footF = basicFootKeys('follower', timing);
  const frames: MotionClip['frames'] = [];
  const n = Math.round(duration * FPS);
  for (let i = 0; i <= n; i++) {
    const t = i / FPS;
    const b = (t / SPB) % 8;
    const bi = Math.floor(b);
    const s = smoothstep(b - bi);
    const sway = (SWAY[bi] + (SWAY[bi + 1] - SWAY[bi]) * s) * dir;
    // リーダーは +X を向く。前方 = +X。フォロワーは鏡（後退ブレイク）なので同じ +sway
    const lx = -0.35 + sway, fx = 0.35 + sway;
    frames.push({
      t,
      p: {
        '0': placeJoints(lx, 0, 90 * D2R, 0.96, fx, 0,
          [footAt(footL[0], b), footAt(footL[1], b)], [-0.35, 0]),
        '1': placeJoints(fx, 0, -90 * D2R, 0.92, lx, 0,
          [footAt(footF[0], b), footAt(footF[1], b)], [0.35, 0]),
      },
    });
  }
  return {
    version: 1,
    fps: FPS,
    duration,
    leaderPid: 0,
    joints: new Array(N_JOINTS).fill('') as string[],
    events: [],
    frames,
    beatGrid: { bpm: BPM, firstBeatSec: 0, beatIntervalSec: SPB, confidence: 1 },
    armTimeline: {
      version: 1, source: 'scripted',
      segments: [{
        t0: 0, t1: duration, phase: 'hold',
        hold: { leader: 'L', follower: 'R' },
        leader: { L: 'hold', R: 'free' }, follower: { L: 'free', R: 'hold' },
        confidence: 'observed',
      }],
    },
  };
}

/** 手描き CBL クリップを合成する。動画は使わない */
export function buildScriptedCBL(): MotionClip {
  const duration = LOOP_BEATS * SPB;
  const frames: MotionClip['frames'] = [];
  const n = Math.round(duration * FPS);
  for (let i = 0; i <= n; i++) {
    const t = i / FPS;
    const beat = t / SPB;
    const [lx, lz, lyaw] = poseAt(KEY_L, beat);
    const [fx, fz, fyaw] = poseAt(KEY_F, beat);
    const hy = hipYAt(beat);
    frames.push({
      t,
      p: {
        '0': placeJoints(lx, lz, lyaw, hy, fx, fz),
        '1': placeJoints(fx, fz, fyaw, hy - 0.04, lx, lz),
      },
    });
  }
  return {
    version: 1,
    fps: FPS,
    duration,
    leaderPid: 0,
    joints: new Array(N_JOINTS).fill('') as string[],
    events: [
      { t: 9 * SPB, type: 'CBL', by: 'pair' },
      { t: 25 * SPB, type: 'CBL', by: 'pair' },
    ],
    frames,
    beatGrid: { bpm: BPM, firstBeatSec: 0, beatIntervalSec: SPB, confidence: 1 },
    armTimeline: { version: 1, source: 'scripted', segments: buildSegments() },
  };
}
