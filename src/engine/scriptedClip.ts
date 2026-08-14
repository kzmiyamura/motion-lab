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
// 【重要】CBL は席の交換ではない（ユーザー指摘 2026-08-14）。
//   「空男女空」→ CBL →「女男空空」。**男はその場に残り**、女が男を追い越して
//   反対側へ抜ける。以前は「空女男空」= 2人が席を交換していて誤りだった。
// そのため男の x は PIVOT_X のまま戻る。z の逃げ方（道の開け方）は変えない。
const PIVOT_X = -0.30;   // 男の立ち位置 = 後半を 180° 回すときの回転中心
const KEY_L: [number, number, number][] = [
  [-0.30, 0.00,  90], // 0  基本ホールド
  [-0.18, 0.00,  90], // 1  前進ブレイク（左足）
  [-0.28, 0.00,  90], // 2  戻す
  [-0.30, 0.00,  90], // 3
  [-0.30, 0.00,  90], // 4  休符
  [-0.42, 0.00,  90], // 5  後退ブレイク
  [-0.32, 0.00,  90], // 6
  [-0.30, 0.00,  90], // 7
  [-0.30, 0.00,  90], // 8  休符（CBL へ）
  [-0.18, 0.02,  95], // 9  前進ブレイク = CBL の合図
  [-0.28, 0.12, 120], // 10 スロットの外へ開き始める
  [-0.23, 0.45, 180], // 11 スロット脇・通り道を向く（肩幅ぶんしっかり空ける）
  [-0.23, 0.45, 180], // 12 休符
  [-0.20, 0.46, 215], // 13 フォロワーを通しながら回り込む
  [-0.22, 0.28, 245], // 14 その場へ戻りながら回る（女の席へは行かない）
  [-0.27, 0.06, 265], // 15
  [-0.30, 0.00, 270], // 16 = 後半の頭（PIVOT_X まわりに180°回した 0 拍目と一致）
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
  // 旋回は **+ 方向**（ユーザー指摘: 回る向きが逆だった）。
  // 終端 +90 は -270 と同じ向きなので、着地の向きは変えずに回り方だけ反転する
  // 男を追い越して**反対側まで**抜ける（-0.95）。男は -0.30 に残るので
  //   「空男女空」→「女男空空」になる
  [-0.20, 0.00,  -85], // 13 スロットを通過
  [-0.55, 0.00,  -40], // 14 通過しながら向き直り始める
  [-0.85, 0.00,   50], // 15 180° ターン
  [-0.95, 0.00,   90], // 16 = 後半の頭（PIVOT_X まわりに回すと 0 拍目 +0.35 に戻る）
];
// 腰の高さ。通過中は膝を使って少し沈む
const KEY_HIPY = [0.96, 0.96, 0.96, 0.96, 0.96, 0.96, 0.96, 0.96,
  0.96, 0.96, 0.95, 0.94, 0.94, 0.93, 0.94, 0.95, 0.96];

const D2R = Math.PI / 180;
const smoothstep = (u: number) => u * u * (3 - 2 * u);

/**
 * 周期テーブルの単調エルミート中割り（Fritsch–Carlson）。
 * 節点で速度が 0 に落ちないので流れは止まらないが、**行き過ぎない** —
 * Catmull-Rom だとブレイクの底が拍の後ろへずれて音から遅れて見える。
 * 折り返しの節点だけ接線 0（＝そこが極値）なので、2・6 の底はぴったり拍の上に来る。
 */
function monotoneCyclic(vals: number[], x: number): number {
  const n = vals.length;
  const t = ((x % n) + n) % n;
  const i = Math.floor(t), u = t - i;
  const p1 = vals[i], p2 = vals[(i + 1) % n];
  const d = (k: number) => vals[(k + 1) % n] - vals[k % n];   // 区間 k の傾き
  const tangent = (k: number) => {
    const a = d((k - 1 + n) % n), b = d(k % n);
    return a * b <= 0 ? 0 : (a + b) / 2;   // 折り返しなら 0 = そこが極値
  };
  const m1 = tangent(i), m2 = tangent((i + 1) % n);
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1
    + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}

// ── 足運び ───────────────────────────────────────────────
// サルサの足は「カウントに合わせて1歩ずつ踏む。それ以外は床に着いたまま」。
// キーは [着地拍, 前後位置(体ローカルz, +が前), 移動拍数?]。既定は拍の 0.35 拍前から
// 動き出して拍ちょうどに着地（AND で動き出す歩は 0.5 を指定）。移動中だけ足首が浮く。
// taps は「同じ場所で踏み直す」拍 — 位置は変えず、小さく浮かせて荷重の入れ替えを見せる
// 4番目の 'charge' は「ため」— 前半はほとんど動かず溜め、AND で放って拍に着地する
type FootKey = [number, number, number?, 'charge'?];
// heelDown は「踵が床に着く拍」。サルサは 1235 67 をボールで踊り、4・8 だけ踵が下りる
type FootSpec = { keys: FootKey[]; taps: number[]; flow?: boolean; heelDown?: number[] };
const CHARGE_POW = 2.4;         // 「ため」の強さ。大きいほど後半に動きが寄る
const HEEL_FALL = 1;            // 踵が下りきるまでの拍数（＝ため）
const HEEL_RISE = 0.5;          // 踵が抜けるまでの拍数（＝AND で蹴る）
const STEP_DUR = 0.35;          // 1歩にかける既定の拍数
const TAP_DUR = 0.25;           // 踏み直しの浮き時間
const ANKLE_Y = 0.115;          // ボールで立っているときの足首高さ（踵が浮いている）
const HEEL_DROP = 0.035;        // 踵が下りたときに足首が沈む量 → ベタ足で 0.08
const STEP_LIFT = 0.07;         // 移動中に浮く高さ
const TAP_LIFT = 0.04;          // 踏み直しの浮き
const FOOT_LATERAL = 0.09;      // 足のスタンス幅（体ローカルx）
const FULL_STEP = 0.15;         // この距離を「一歩ぶん」として浮きの高さを按分する

/**
 * 足の移動区間。flow スペックでは区間が隙間なく連なるので、
 * つなぎ目の速度を前後の平均に合わせて **着地しても止まらない** ようにする。
 */
type FootSeg = {
  b0: number; b1: number; z0: number; z1: number; m0: number; m1: number; charge: boolean;
};

function buildSegs(spec: FootSpec): FootSeg[] {
  const ks = spec.keys;
  const n = ks.length;
  const raw = ks.map((k, i) => {
    const dur = k[2] ?? STEP_DUR;
    const z0 = ks[(i - 1 + n) % n][1];
    return { b0: k[0] - dur, b1: k[0], z0, z1: k[1], v: (k[1] - z0) / dur };
  });
  // 直前のキーの着地拍と自分の踏み出し拍が一致していれば「止まらずに続く」区間
  const cont = raw.map((s, i) => {
    const prevEnd = ks[(i - 1 + n) % n][0];
    return Math.abs(((s.b0 - prevEnd) % 8 + 8) % 8) < 1e-6;
  });
  return raw.map((s, i) => ({
    b0: s.b0, b1: s.b1, z0: s.z0, z1: s.z1,
    m0: cont[i] ? (raw[(i - 1 + n) % n].v + s.v) / 2 : 0,
    m1: cont[(i + 1) % n] ? (s.v + raw[(i + 1) % n].v) / 2 : 0,
    charge: ks[i][3] === 'charge',
  }));
}

const segCache = new WeakMap<FootSpec, FootSeg[]>();
const segsOf = (spec: FootSpec) => {
  let s = segCache.get(spec);
  if (!s) { s = buildSegs(spec); segCache.set(spec, s); }
  return s;
};

/**
 * 踵の下り具合（0 = ボール立ち、1 = 踵接地）。
 * 拍の 1 拍前から下り始めて拍でベタ足、その後 AND までに抜けてボールへ戻る。
 * この 1 拍が「ため」の中身で、静止しているように見えないのはこの上下があるから。
 */
function heelAt(spec: FootSpec, beat8: number): number {
  let h = 0;
  for (const hb of spec.heelDown ?? []) {
    for (const off of [0, 8, -8]) {
      const b = beat8 + off;
      if (b > hb - HEEL_FALL && b <= hb) h = Math.max(h, smoothstep((b - (hb - HEEL_FALL)) / HEEL_FALL));
      if (b > hb && b < hb + HEEL_RISE) h = Math.max(h, 1 - smoothstep((b - hb) / HEEL_RISE));
    }
  }
  return h;
}

/** 8拍周期の足前後位置と浮き */
function footAt(spec: FootSpec, beat8: number): { z: number; lift: number } {
  if (!spec.flow) {
    let z = spec.keys[spec.keys.length - 1][1];   // 周回前の最後の位置から始まる
    let lift = 0;
    for (const [kb, kz, kd] of spec.keys) {
      const dur = kd ?? STEP_DUR;
      if (beat8 >= kb) { z = kz; continue; }
      if (beat8 >= kb - dur) {
        const u = smoothstep((beat8 - (kb - dur)) / dur);
        lift = Math.sin(u * Math.PI) * STEP_LIFT;
        z = z + (kz - z) * u;
      }
      break;
    }
    for (const tb of spec.taps) {
      if (beat8 >= tb - TAP_DUR && beat8 <= tb) {
        lift = Math.max(lift, Math.sin(((beat8 - (tb - TAP_DUR)) / TAP_DUR) * Math.PI) * TAP_LIFT);
      }
    }
    return { z, lift };
  }
  // 速度連続（エルミート）。キー拍は「通過点」であって止まる場所ではない
  for (const s of segsOf(spec)) {
    for (const off of [0, 8, -8]) {           // 拍0をまたぐ区間も拾う
      const b = beat8 + off;
      if (b < s.b0 || b > s.b1) continue;
      const dur = s.b1 - s.b0;
      const u = (b - s.b0) / dur, u2 = u * u, u3 = u2 * u;
      // 進み具合。charge 区間は前半を溜めて後半（AND）で放つ
      const f = s.charge
        ? Math.pow((2 * u3 - 3 * u2 + 1) * 0 + (-2 * u3 + 3 * u2) * 1, CHARGE_POW)
        : null;
      const z = f === null
        ? (2 * u3 - 3 * u2 + 1) * s.z0 + (u3 - 2 * u2 + u) * dur * s.m0
          + (-2 * u3 + 3 * u2) * s.z1 + (u3 - u2) * dur * s.m1
        : s.z0 + (s.z1 - s.z0) * f;
      const scale = Math.min(1, Math.abs(s.z1 - s.z0) / FULL_STEP);
      // 浮きは実際の進み具合に従う → 溜めの間は足が床の近くに残る
      return { z, lift: Math.sin((f ?? u) * Math.PI) * STEP_LIFT * scale };
    }
  }
  // どの区間にも入らない＝荷重して床に着いたまま。直近に着地したキーの位置
  let z = spec.keys[spec.keys.length - 1][1];
  for (const [kb, kz] of spec.keys) if (beat8 >= kb) z = kz;
  return { z, lift: 0 };
}

export type Timing = 'on1' | 'on2';
const BREAK = 0.28;             // ブレイクの歩幅
const QUARTER = 0.06;           // 靴の 1/4。3・7 はこのぶんだけずらして踏む

/**
 * ベーシックの足運び（8拍・リーダー基準、z+ = 前）。フォロワーは足を入れ替えて
 * 前後を反転する — 動く足が常に「リーダー左⇔フォロワー右」の対なので踏み合わない。
 *
 * On1（3・4・7・8 でニュートラルに戻る）:
 *   1 左足前ブレイク → 3 戻す。5 右足後ろブレイク → 7 戻す
 *
 * On2（Eddie Torres 系。**両足が揃う瞬間は一度もない** — ユーザー確認済み）:
 *   大きく位置が変わる歩は 1・2・5・6。3 は 1 の**靴1/4だけ前**、7 は 5 の**靴1/4だけ後ろ**
 *   — その場の踏み直しではなく、わずかに進み続けることで流れを切らない。
 *   8AND から左足が動き出して 1 で右足の少し後ろへ、2 は 1 の足の後ろ（ブレイク）、
 *   4AND から右足が動き出して 5 で前へ、6 はさらに前（ブレイク）。
 *
 *   **On2 の肝は「足が止まらない」こと**（ユーザー談）。On1 のように拍の直前だけ
 *   素早く動いて残りを静止で埋めるとぶつ切りに見える。そこで遊脚の移動区間を
 *   拍間いっぱいに広げ、区間どうしを隙間なく連ねて速度を繋いだ（flow: true）。
 *   床で止まっているのは常に荷重した1本だけで、もう1本は必ず動いている。
 */
function basicFootKeys(role: 'leader' | 'follower', timing: Timing): [FootSpec, FootSpec] {
  let L: FootSpec, R: FootSpec;
  if (timing === 'on1') {
    // On1 も踊るのはボールの上。4・8 のニュートラルで両足とも踵が下りる
    L = { keys: [[0, 0], [1, BREAK], [3, 0]], taps: [6], heelDown: [4, 8] };
    R = { keys: [[0, 0], [5, -BREAK], [7, 0]], taps: [2], heelDown: [4, 8] };
  } else {
    // 数値は「1 で左足は右足(+0.05)の少し後ろ = -0.05」「2 は 1 の 0.3 後ろ」
    // 「6 は 5(+0.05) の 0.3 前」を全体が中心 0 で振動するよう配置したもの。
    // 3 は 1 の QUARTER 前、7 は 5 の QUARTER 後ろ。
    // 荷重した足は床で止まり、遊脚は**空いている窓をまるごと使って**移動する。
    // 荷重: 1・3・4=左 / 2・5・7・8=右 → 遊脚の窓は
    //   左 7→1(2拍) / 2→3(1拍) / 5→6(1拍)、右 1→2(1拍) / 3→5(2拍) / 6→7(1拍)
    // 窓が拍を隙間なく敷き詰めるので、どの瞬間も必ずどちらかの足が動いている
    // 1・5 へ向かう歩は 7・3 の直後から窓を取るが 'charge'（ため）— 前半は溜めて
    // ほとんど動かず、8AND・4AND で放って拍ちょうどに着地する。
    // 溜めの間は足首も床の近くに残るので、AND の踏み出しがはっきり見える
    // 踵が下りるのは荷重している足だけ。4 は左（3 で荷重）、8 は右（7 で荷重）
    L = {
      keys: [[1, -0.05, 2, 'charge'], [3, -0.05 + QUARTER, 1], [6, 0.35, 1]],
      taps: [], flow: true, heelDown: [4],
    };
    R = {
      keys: [[2, -0.35, 1], [5, 0.05, 2, 'charge'], [7, 0.05 - QUARTER, 1]],
      taps: [], flow: true, heelDown: [8],
    };
  }
  if (role === 'leader') return [L, R];
  const flip = (s: FootSpec): FootSpec =>
    ({
      keys: s.keys.map(([b, z, d, e]) => [b, -z, d, e] as FootKey),
      taps: [...s.taps], flow: s.flow, heelDown: s.heelDown ? [...s.heelDown] : undefined,
    });
  return [flip(R), flip(L)];   // [左足, 右足]
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
  // 後半は 180° 回した同じ振付。回転中心は原点ではなく **男の立ち位置**（PIVOT_X）。
  // 原点まわりに回すと男まで反対側へ飛んでしまい、席の交換になってしまう
  if (flip) { x = 2 * PIVOT_X - x; z = -z; yaw += Math.PI; }
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
  // [左, 右] 体ローカル。heel は踵の下り具合（0 = ボール立ち、1 = 踵接地）
  feet?: [{ z: number; lift: number; heel?: number }, { z: number; lift: number; heel?: number }],
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
    const putFoot = (idx: number, lx: number, f: { z: number; lift: number; heel?: number }) => {
      j[idx * 3] = ax + lx * cy + f.z * sy;
      // 踵が下りると足首は沈む。接地点（ボール）は動かさないので踏んだ場所は変わらない
      j[idx * 3 + 1] = ANKLE_Y - HEEL_DROP * (f.heel ?? 0) + f.lift;
      j[idx * 3 + 2] = az - lx * sy + f.z * cy;
      v[idx] = 1;
    };
    putFoot(LANK, FOOT_LATERAL, feet[0]);
    putFoot(RANK, -FOOT_LATERAL, feet[1]);
  }
  return { r: [], j, v };
}

/**
 * placeJoints のワールド足版。CBL は体が回りながら進むので、足は体ローカルではなく
 * 「踏んだワールド座標」で持つ（回っても進んでも床を滑らない）。
 */
function placeJointsWorld(
  x: number, z: number, yaw: number, hipY: number,
  lookX: number, lookZ: number,
  feet: [{ x: number; z: number; lift: number; heel: number },
    { x: number; z: number; lift: number; heel: number }],
): { r: number[]; j: number[]; v: number[] } {
  const out = placeJoints(x, z, yaw, hipY, lookX, lookZ);
  const put = (idx: number, f: { x: number; z: number; lift: number; heel: number }) => {
    out.j[idx * 3] = f.x;
    out.j[idx * 3 + 1] = ANKLE_Y - HEEL_DROP * f.heel + f.lift;
    out.j[idx * 3 + 2] = f.z;
    out.v[idx] = 1;
  };
  put(LANK, feet[0]);
  put(RANK, feet[1]);
  return out;
}

// ── CBL の足 ─────────────────────────────────────────────
// 体（腰の位置と向き）は既存のキーポーズのまま **一切触らない**。
// 各カウントで荷重する足をその瞬間の腰の真下（スタンス幅ぶん横）に置き、
// 着地したらワールドで固定する。ボール立ち・4/8 の踵・ため・遊脚が拍間を
// 埋める仕組みは、合格済みのベーシック On2 からそのまま引き継ぐ。
//
// clipBeat 1 = カウント1（KEY_L[1] が 1 拍目のブレイク）。8拍ごとに繰り返す。
// fwd は腰の真下からさらに踏み込む量（体ローカル・前が +）。
// 1 と 6 は「もう少し大きく踏み込んで」というユーザー指摘ぶん深く入る
const CBL_FOOT_SPEC = [
  { count: 1, foot: 'L' as const, dur: 2, charge: true, fwd: 0.14 },  // 8AND から放って着地
  { count: 2, foot: 'R' as const, dur: 1, fwd: 0 },
  { count: 3, foot: 'L' as const, dur: 1, fwd: 0 },
  { count: 5, foot: 'R' as const, dur: 2, charge: true, fwd: 0 },     // 4AND から放って着地
  { count: 6, foot: 'L' as const, dur: 1, fwd: 0.12 },
  { count: 7, foot: 'R' as const, dur: 1, fwd: 0 },
];
// CBL のスタンス幅。ベーシックの 0.09 では狭いというユーザー指摘で広げた
const CBL_LATERAL = 0.13;
// 踵が下りるカウント（荷重している足だけ）。4 = 左、8 = 右
const CBL_HEEL: Record<'L' | 'R', number> = { L: 4, R: 8 };

type CblLand = {
  beat: number; foot: 'L' | 'R'; x: number; z: number; dur: number; charge: boolean;
};

/** 体のキーポーズから、各カウントの「踏む場所」をワールドで出す */
function cblLandings(keys: [number, number, number][]): CblLand[] {
  const out: CblLand[] = [];
  for (let bar = 0; bar < LOOP_BEATS / 8; bar++) {
    for (const s of CBL_FOOT_SPEC) {
      const beat = s.count + bar * 8;
      const [hx, hz, yaw] = poseAt(keys, beat);
      const lat = s.foot === 'L' ? CBL_LATERAL : -CBL_LATERAL;
      out.push({
        beat, foot: s.foot,
        // 腰の真下（スタンス幅ぶん横）＋ 踏み込みぶん前
        x: hx + lat * Math.cos(yaw) + s.fwd * Math.sin(yaw),
        z: hz - lat * Math.sin(yaw) + s.fwd * Math.cos(yaw),
        dur: s.dur, charge: !!s.charge,
      });
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

/** ワールドでの足首。着地したらその場に固定、移動中だけ前の着地点から運ぶ */
function cblFootAt(lands: CblLand[], foot: 'L' | 'R', beat: number) {
  const mine = lands.filter((f) => f.foot === foot);
  const n = mine.length;
  for (let i = 0; i < n; i++) {
    const f = mine[i], prev = mine[(i - 1 + n) % n];
    for (const off of [0, LOOP_BEATS, -LOOP_BEATS]) {
      const b = beat + off;
      if (b < f.beat - f.dur || b > f.beat) continue;
      const s = smoothstep((b - (f.beat - f.dur)) / f.dur);
      const p = f.charge ? Math.pow(s, CHARGE_POW) : s;   // ため → AND で放つ
      const dist = Math.hypot(f.x - prev.x, f.z - prev.z);
      return {
        x: prev.x + (f.x - prev.x) * p,
        z: prev.z + (f.z - prev.z) * p,
        lift: Math.sin(p * Math.PI) * STEP_LIFT * Math.min(1, dist / FULL_STEP),
      };
    }
  }
  let cur = mine[n - 1];
  for (const f of mine) if (beat >= f.beat) cur = f;
  return { x: cur.x, z: cur.z, lift: 0 };
}

/** 踵の下り具合。1235 67 はボール立ち、4・8 だけ荷重足の踵が下りる */
function cblHeelAt(foot: 'L' | 'R', beat: number): number {
  const c = CBL_HEEL[foot];
  const phase = ((beat % 8) + 8) % 8;      // 0 = カウント8、1 = カウント1 …
  let h = 0;
  for (const off of [0, 8, -8]) {
    const b = phase + off;
    if (b > c - HEEL_FALL && b <= c) h = Math.max(h, smoothstep((b - (c - HEEL_FALL)) / HEEL_FALL));
    if (b > c && b < c + HEEL_RISE) h = Math.max(h, 1 - smoothstep((b - c) / HEEL_RISE));
  }
  return h;
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
    // 通り抜けで背中を支える動き（back_support）はユーザー却下 —
    // リーダーが途中で手を挙げるように見えるため。腕は終始
    // 「リーダー左手 × フォロワー右手」の片手ホールドだけにする
    seg(o + 10, o + 13, 'pass', 'free'),
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
  // 体の重心の前後（リーダーの前方成分。フォロワーはワールドで同方向へ揺れる）。
  // On1: 1 で前・5 で後ろ。On2: 2 で後ろ・6 で前（ブレイクに同期）。
  // On2 は足が揃わないぶん重心も完全な中立に戻らない（先頭と末尾を同値にしてループを繋ぐ）
  // On2 は荷重した足の位置に重心が乗る（1・3=左足-0.05、2=右足-0.35、5・7=右足+0.05、6=左足+0.35）
  // On2 は荷重足の z の半分を重心に乗せる（1=左-0.05, 2=右-0.35, 3=左+0.01,
  // 5=右+0.05, 6=左+0.35, 7=右-0.01。4・8 は荷重が変わらないので直前と同値）
  const SWAY = timing === 'on1'
    ? [0, 0.12, 0.02, 0, 0, -0.12, -0.02, 0, 0]
    : [-0.005, -0.025, -0.175, 0.005, 0.005, 0.025, 0.175, -0.005, -0.005];
  const footL = basicFootKeys('leader', timing);
  const footF = basicFootKeys('follower', timing);
  // 足の状態に踵を足す。踵が下りると腰もその分だけ沈む＝ためが「上下の動き」になる
  const foot = (spec: FootSpec, b: number) => ({ ...footAt(spec, b), heel: heelAt(spec, b) });
  const heelSink = (fs: [FootSpec, FootSpec], b: number) =>
    HEEL_DROP * Math.max(heelAt(fs[0], b), heelAt(fs[1], b));
  const frames: MotionClip['frames'] = [];
  const n = Math.round(duration * FPS);
  for (let i = 0; i <= n; i++) {
    const t = i / FPS;
    const b = (t / SPB) % 8;
    const bi = Math.floor(b);
    // On1 は拍ごとに落ち着くので smoothstep。On2 は重心も止めない（速度連続の中割り）
    const sway = timing === 'on1'
      ? SWAY[bi] + (SWAY[bi + 1] - SWAY[bi]) * smoothstep(b - bi)
      : monotoneCyclic(SWAY.slice(0, 8), b);
    // リーダーは +X を向く。前方 = +X。フォロワーは鏡（後退ブレイク）なので同じ +sway
    const lx = -0.35 + sway, fx = 0.35 + sway;
    frames.push({
      t,
      p: {
        '0': placeJoints(lx, 0, 90 * D2R, 0.96 - heelSink(footL, b), fx, 0,
          [foot(footL[0], b), foot(footL[1], b)], [-0.35, 0]),
        '1': placeJoints(fx, 0, -90 * D2R, 0.92 - heelSink(footF, b), lx, 0,
          [foot(footF[0], b), foot(footF[1], b)], [0.35, 0]),
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
  // 男の足だけを振付として焼き込む（体は既存のキーポーズのまま）。女は次の段階
  const landsL = cblLandings(KEY_L);
  for (let i = 0; i <= n; i++) {
    const t = i / FPS;
    const beat = t / SPB;
    const [lx, lz, lyaw] = poseAt(KEY_L, beat);
    const [fx, fz, fyaw] = poseAt(KEY_F, beat);
    const hy = hipYAt(beat);
    const heelL = cblHeelAt('L', beat), heelR = cblHeelAt('R', beat);
    frames.push({
      t,
      p: {
        '0': placeJointsWorld(lx, lz, lyaw, hy - HEEL_DROP * Math.max(heelL, heelR), fx, fz, [
          { ...cblFootAt(landsL, 'L', beat), heel: heelL },
          { ...cblFootAt(landsL, 'R', beat), heel: heelR },
        ]),
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
