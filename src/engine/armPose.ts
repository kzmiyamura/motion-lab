/**
 * 腕の構えの定数と、その構えが「人としてありえる形か」を測るための純関数。
 *
 * CoupleFigure の IK（solve2Bone）は three のオブジェクトを触るのでテストから
 * 呼びづらい。肘の位置は解析的に決まる（肩から dir を pole 側へ off 回して上腕ぶん進む）ので、
 * **同じ式**をここに純関数として置き、定数を変えたときに肘角と脇の空きを数字で確かめられるようにする。
 */

/** 上腕・前腕の長さ[m]（CoupleFigure と同じ） */
export const L_UPARM = 0.28, L_FOREARM = 0.27;
/** 肩の左右オフセット・腰から肩までの高さ[m]（CoupleFigure と同じ） */
export const SHO_DX = 0.185, SHO_DY = 0.40;

/**
 * フォロワーのニュートラルポジション（胸郭ローカル [横, 肩からの高さ, 前]）。
 *
 * **手は体の正面・胸の高さ、肘は曲げて下と外へ張る**（ユーザー確認済み 2026-08-16）。
 * 前腕が前を向くので肘が体側から離れ、そこが空くからリーダーの手が背中へ回る。
 *
 * 高さは腰から 30cm（肩は 40cm なので肩より 10cm 下＝胸骨の中ほど）。
 * ここを 16cm（へそ）にすると「腰のあたりに手がある」と指摘される。
 * 手を真横へ張り出すのもニュートラルではない（どちらも一度そう作って指摘された）。
 */
export const NEUTRAL_HAND = [0.13, -0.10, 0.30] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** armPole と同じ。手の高さで肘の向きを決める（0 = 肩より下、1 = 頭上） */
function armPole(sign: number, ty: number): [number, number, number] {
  const up = clamp(ty / 0.30, 0, 1);
  return [sign * (0.55 + 0.45 * up), -1 + up, -0.3 + 0.6 * up];
}

/**
 * 肩ローカルの目標から肘の位置と肘角を出す（solve2Bone と同じ式）。
 * @param sign +1 = 左手, -1 = 右手
 * @param target 胸郭ローカルの手の位置 [x, y, z]
 */
export function armSolve(sign: number, target: readonly [number, number, number]) {
  const sh: [number, number, number] = [sign * SHO_DX, SHO_DY, 0];
  const t: [number, number, number] = [target[0] - sh[0], target[1] - sh[1], target[2] - sh[2]];
  const d = Math.hypot(t[0], t[1], t[2]) || 1e-6;
  const dc = clamp(d, Math.abs(L_UPARM - L_FOREARM) + 0.02, L_UPARM + L_FOREARM - 0.02);
  const off = Math.acos(clamp(
    (L_UPARM * L_UPARM + dc * dc - L_FOREARM * L_FOREARM) / (2 * L_UPARM * dc), -1, 1));
  const bend = 180 - Math.acos(clamp(
    (L_UPARM * L_UPARM + L_FOREARM * L_FOREARM - dc * dc) / (2 * L_UPARM * L_FOREARM), -1, 1))
    * 180 / Math.PI;

  const dir: [number, number, number] = [t[0] / d, t[1] / d, t[2] / d];
  const p = armPole(sign, t[1]);
  const dot = p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2];
  const pole: [number, number, number] = [p[0] - dir[0] * dot, p[1] - dir[1] * dot, p[2] - dir[2] * dot];
  const pl = Math.hypot(pole[0], pole[1], pole[2]) || 1e-6;
  pole[0] /= pl; pole[1] /= pl; pole[2] /= pl;
  // 肘の向き = dir を axis まわりに off 回したもの（axis = dir × pole）
  const axis: [number, number, number] = [
    dir[1] * pole[2] - dir[2] * pole[1],
    dir[2] * pole[0] - dir[0] * pole[2],
    dir[0] * pole[1] - dir[1] * pole[0],
  ];
  const al = Math.hypot(axis[0], axis[1], axis[2]) || 1e-6;
  axis[0] /= al; axis[1] /= al; axis[2] /= al;
  const c = Math.cos(off), s = Math.sin(off);
  const kd = axis[0] * dir[0] + axis[1] * dir[1] + axis[2] * dir[2];
  const rot: [number, number, number] = [
    dir[0] * c + (axis[1] * dir[2] - axis[2] * dir[1]) * s + axis[0] * kd * (1 - c),
    dir[1] * c + (axis[2] * dir[0] - axis[0] * dir[2]) * s + axis[1] * kd * (1 - c),
    dir[2] * c + (axis[0] * dir[1] - axis[1] * dir[0]) * s + axis[2] * kd * (1 - c),
  ];
  const elbow: [number, number, number] = [
    sh[0] + rot[0] * L_UPARM, sh[1] + rot[1] * L_UPARM, sh[2] + rot[2] * L_UPARM,
  ];
  return {
    elbow, bend,
    /** 脇の空き = 肘が肩の真下より外へ出ている量[m]。ここが空くと相手の手が入る */
    armpit: Math.abs(elbow[0]) - SHO_DX,
    /** 肩から手までの距離[m]。腕の長さ（0.522）を超えると伸び切って手が届かない */
    reach: d,
  };
}
