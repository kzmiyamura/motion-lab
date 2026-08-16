import { describe, it, expect } from 'vitest';
import { NEUTRAL_HAND, armSolve, SHO_DY, L_UPARM, L_FOREARM } from '../engine/armPose';

/**
 * ニュートラルポジションの再発防止（ユーザー確認済み 2026-08-16）。
 * 「手は体の正面・へその高さ、肘は 90° に曲げて下と外へ張る」。
 * 一度これを「手を真横へ張り出す（肘角 121°・脇 13.4cm）」で作って指摘された。
 */
describe('フォロワーのニュートラルポジション', () => {
  const target = [
    -NEUTRAL_HAND[0], SHO_DY + NEUTRAL_HAND[1], NEUTRAL_HAND[2],
  ] as const;                                   // 女の左手（sign = -1）
  const r = armSolve(-1, target);

  it('肘は 90〜120° に曲がっている（伸び切っていない）', () => {
    expect(r.bend).toBeGreaterThan(80);
    expect(r.bend).toBeLessThan(125);
  });

  it('手は体の正面にある（真横へ張り出さない）', () => {
    // 前へ出した量が、横へ出した量より大きい
    expect(NEUTRAL_HAND[2]).toBeGreaterThan(NEUTRAL_HAND[0] * 1.5);
  });

  it('手は胸の高さ（腰から 25〜34cm・肩よりは下）', () => {
    const y = SHO_DY + NEUTRAL_HAND[1];
    expect(y, '腰やへその高さまで下がっていない').toBeGreaterThan(0.25);
    expect(y, '肩の高さまで上がっていない').toBeLessThan(0.34);
  });

  it('脇が開いている（肘が肩の真下より外にある）— ここが空くから背中に手が入る', () => {
    expect(r.armpit).toBeGreaterThan(0.05);
  });

  it('肘は肩より下（手を挙げて見えない）', () => {
    expect(r.elbow[1]).toBeLessThan(SHO_DY - 0.15);
  });

  it('腕を伸ばし切らずに届く', () => {
    expect(r.reach).toBeLessThan((L_UPARM + L_FOREARM) * 0.95);
  });
});
