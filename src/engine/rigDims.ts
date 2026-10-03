/**
 * カップルリグ（CoupleFigure）の寸法を1か所に集めたもの[m]。
 *
 * 以前は IK が使う骨の長さ・JSX のメッシュ半径・衝突判定の円柱半径が別々の場所に
 * 散らばっていて、**見えている体と当たり判定の体が別物**になっていた
 * （胴の見た目はカプセル半径 0.135、当たり判定は root 軸の円柱 0.17/0.13）。
 * IK・描画・計測（rigMetrics）は全部ここを参照する。
 *
 * 長さは export の --target-height 1.70 に合わせた固定値。
 */

// ── 骨の長さ
export const L_THIGH = 0.46, L_SHIN = 0.44;
export const L_UPARM = 0.28, L_FOREARM = 0.27;
export const LEG_MAX = L_THIGH + L_SHIN;

// ── 関節の付け根
/** 股関節の左右オフセット */
export const HIP_DX = 0.10;
/** 肩の左右オフセット */
export const SHO_DX = 0.185;
/** 腰（hips 原点）から肩までの高さ */
export const SHO_DY = 0.40;
/** 立ち姿勢での腰の高さ（hips の初期 y） */
export const HIPS_Y0 = 0.9;
/** 胸郭（spine）原点から頭の中心まで */
export const HEAD_Y = 0.58;

// 左右の符号。前方 +Z・上 +Y の右手系なので **+X は本人の左**。0=左, 1=右
export const SIDE_SIGN = [1, -1] as const;

// ── 見た目（メッシュ）の寸法。当たり判定もこれをそのまま使う
/** 胴（spine の子）: 中心 y・半径・円柱部の長さ（カプセルの全高は長さ + 2r） */
export const TORSO_Y = 0.24, TORSO_R = 0.135, TORSO_LEN = 0.32;
/** 骨盤（hips の子、原点中心） */
export const PELVIS_R = 0.135, PELVIS_LEN = 0.1;
/** 首（spine の子） */
export const NECK_Y = 0.47, NECK_R = 0.045, NECK_LEN = 0.06;
/** 頭（球） */
export const HEAD_R = 0.115;
/** スカート（hips の子の円錐台）: 中心 y・上端半径・下端半径・高さ */
export const SKIRT_Y = -0.16, SKIRT_R_TOP = 0.155, SKIRT_R_BOT = 0.28, SKIRT_H = 0.36;
/** 腕: 上腕（袖）・前腕・手（球） */
export const UPARM_R = 0.052, FOREARM_R = 0.044, HAND_R = 0.052;
/** 脚: 太もも・すね */
export const THIGH_R = 0.078, SHIN_R = 0.062;
