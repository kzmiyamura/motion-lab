import { describe, it, expect } from 'vitest';
import { buildScriptedBasic } from '../engine/scriptedClip';

// 関節インデックス（MocapFigure の J と同じ）
const LANK = 11, RANK = 12;

const ankle = (
  clip: ReturnType<typeof buildScriptedBasic>, t: number, pid: 0 | 1, idx: number,
) => {
  const f = clip.frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const p = f.p[String(pid)];
  return { x: p.j[idx * 3], y: p.j[idx * 3 + 1], z: p.j[idx * 3 + 2], v: p.v[idx] };
};

describe('手描きベーシックの足運び', () => {
  // リーダーは -X 側に立ち +X（フォロワー）を向く。リーダーの前 = ワールド +X。
  // フォロワーの前 = ワールド -X（後ろ = +X）
  const spb = 60 / 170;

  it('On1: カウント1でリーダー左足が前・フォロワー右足が後ろ（踏み合わない）', () => {
    const c = buildScriptedBasic('on1');
    const lL = ankle(c, spb, 0, LANK), lR = ankle(c, spb, 0, RANK);
    const fL = ankle(c, spb, 1, LANK), fR = ankle(c, spb, 1, RANK);
    expect(lL.v).toBe(1);
    expect(lL.x - lR.x).toBeGreaterThan(0.2);   // 男: 左足が右足より前（+X）
    expect(fR.x - fL.x).toBeGreaterThan(0.2);   // 女: 右足が左足より後ろ（+X = 女の後方）
    // 2人の動いた足は同方向へ逃げるので間隔が保たれる = 踏まない
    expect(fR.x - lL.x).toBeGreaterThan(0.3);
  });

  it('On1: カウント5でリーダー右足が後ろ・フォロワー左足が前', () => {
    const c = buildScriptedBasic('on1');
    const lL = ankle(c, 5 * spb, 0, LANK), lR = ankle(c, 5 * spb, 0, RANK);
    const fL = ankle(c, 5 * spb, 1, LANK), fR = ankle(c, 5 * spb, 1, RANK);
    expect(lR.x - lL.x).toBeLessThan(-0.2);     // 男: 右足が後ろ（-X）
    expect(fL.x - fR.x).toBeLessThan(-0.2);     // 女: 左足が前（-X = 女の前方）
  });

  it('On2: カウント1で男左足・女右足が動く（後ろへの通り抜け）', () => {
    const c = buildScriptedBasic('on2');
    // 前の周期の 6 で前(+0.35)に居た左足が、1 で後ろ(-0.05)へ通り抜けて着地する
    const before = ankle(c, 0.6 * spb, 0, LANK);
    const after = ankle(c, 1.1 * spb, 0, LANK);
    expect(before.x - after.x).toBeGreaterThan(0.2);  // 男: 左足が前→後ろへ大きく移動
    const fBefore = ankle(c, 0.6 * spb, 1, RANK);
    const fAfter = ankle(c, 1.1 * spb, 1, RANK);
    // 女はリーダーの鏡: カウント1で右足が**前**（ワールドでは -X）へ通り抜ける
    expect(fBefore.x - fAfter.x).toBeGreaterThan(0.2);
  });

  it('On2: ブレイクは2と6（男右足が2で後ろへ、左足が6で前へ）', () => {
    const c = buildScriptedBasic('on2');
    const lR2 = ankle(c, 2 * spb, 0, RANK), lL2 = ankle(c, 2 * spb, 0, LANK);
    expect(lR2.x - lL2.x).toBeLessThan(-0.2);   // 2: 右足が左足よりはっきり後ろ
    const lL6 = ankle(c, 6 * spb, 0, LANK), lR6 = ankle(c, 6 * spb, 0, RANK);
    expect(lL6.x - lR6.x).toBeGreaterThan(0.2); // 6: 左足が右足よりはっきり前
    const fL2 = ankle(c, 2 * spb, 1, LANK), fR2 = ankle(c, 2 * spb, 1, RANK);
    expect(fL2.x - fR2.x).toBeLessThan(-0.2);   // 女: 2で左足が前（世界座標では -X）
  });

  it('On2: 3は1と同じ場所・7は5と同じ場所で踏み直す（位置が変わる歩は1,2,5,6だけ）', () => {
    const c = buildScriptedBasic('on2');
    expect(Math.abs(ankle(c, 3.4 * spb, 0, LANK).x - ankle(c, 1.3 * spb, 0, LANK).x)).toBeLessThan(0.02);
    expect(Math.abs(ankle(c, 7.4 * spb, 0, RANK).x - ankle(c, 5.3 * spb, 0, RANK).x)).toBeLessThan(0.02);
    // カウント1: 左足は右足の「少し後ろ」（右足は7=5の位置 +0.05、左足は -0.05）
    const lL = ankle(c, 1.3 * spb, 0, LANK), lR = ankle(c, 1.3 * spb, 0, RANK);
    expect(lR.x - lL.x).toBeGreaterThan(0.05);
    expect(lR.x - lL.x).toBeLessThan(0.2);
  });

  it('On2: 両足が揃う瞬間が一度もない（着地中は常に前後スタッガー）', () => {
    const c = buildScriptedBasic('on2');
    // 移動窓（拍の0.35拍前〜拍）を外した見本拍で、前後差が常に残ることを確かめる
    for (const b of [0.3, 1.3, 2.3, 3.5, 4.3, 5.3, 6.3, 7.5]) {
      const lL = ankle(c, b * spb, 0, LANK), lR = ankle(c, b * spb, 0, RANK);
      expect(Math.abs(lL.x - lR.x), `beat ${b}`).toBeGreaterThan(0.08);
      const fL = ankle(c, b * spb, 1, LANK), fR = ankle(c, b * spb, 1, RANK);
      expect(Math.abs(fL.x - fR.x), `beat ${b}`).toBeGreaterThan(0.08);
    }
  });

  it('移動中だけ足首が浮き、着地中は接地している', () => {
    const c = buildScriptedBasic('on1');
    const mid = ankle(c, 0.83 * spb, 0, LANK);  // カウント1へ移動中
    const planted = ankle(c, 2 * spb, 0, LANK); // カウント2（着地保持）
    expect(mid.y).toBeGreaterThan(0.1);
    expect(planted.y).toBeLessThan(0.1);
  });

  it('休符（4拍目）は両足とも動いていない', () => {
    const c = buildScriptedBasic('on1');
    const a = ankle(c, 3.5 * spb, 0, LANK), b = ankle(c, 4.4 * spb, 0, LANK);
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.02);
    expect(a.y).toBeLessThan(0.1);
  });
});
