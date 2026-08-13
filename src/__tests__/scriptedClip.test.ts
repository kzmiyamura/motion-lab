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
    // 6 で前(+0.35)に居た左足が、7→1 の2拍かけて後ろ(-0.05)へ通り抜けて着地する
    const before = ankle(c, 7 * spb, 0, LANK);
    const after = ankle(c, 1 * spb, 0, LANK);
    expect(before.x - after.x).toBeGreaterThan(0.2);  // 男: 左足が前→後ろへ大きく移動
    const fBefore = ankle(c, 7 * spb, 1, RANK);
    const fAfter = ankle(c, 1 * spb, 1, RANK);
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

  it('On2: 3は1の靴1/4だけ前・7は5の靴1/4だけ後ろ（大きく動く歩は1,2,5,6）', () => {
    const c = buildScriptedBasic('on2');
    const d3 = ankle(c, 3 * spb, 0, LANK).x - ankle(c, 1 * spb, 0, LANK).x;
    expect(d3).toBeGreaterThan(0.03);   // 3 は 1 より前（+X = 男の前方）
    expect(d3).toBeLessThan(0.10);      // ただし靴1/4ぶんだけ
    const d7 = ankle(c, 7 * spb, 0, RANK).x - ankle(c, 5 * spb, 0, RANK).x;
    expect(d7).toBeLessThan(-0.03);     // 7 は 5 より後ろ
    expect(d7).toBeGreaterThan(-0.10);
    // カウント1: 左足は右足の「少し後ろ」（右足は7の位置 ≈ -0.01、左足は -0.05）
    const lL = ankle(c, 1 * spb, 0, LANK), lR = ankle(c, 1 * spb, 0, RANK);
    expect(lR.x - lL.x).toBeGreaterThan(0.02);
    expect(lR.x - lL.x).toBeLessThan(0.2);
  });

  it('On2: 足が止まらない — どの瞬間もどちらかの足が必ず動いている', () => {
    const c = buildScriptedBasic('on2');
    for (let b = 0; b < 8; b += 0.25) {
      const l0 = ankle(c, b * spb, 0, LANK).x, l1 = ankle(c, (b + 0.25) * spb, 0, LANK).x;
      const r0 = ankle(c, b * spb, 0, RANK).x, r1 = ankle(c, (b + 0.25) * spb, 0, RANK).x;
      const moved = Math.max(Math.abs(l1 - l0), Math.abs(r1 - r0));
      expect(moved, `beat ${b}`).toBeGreaterThan(0.005);
    }
  });

  it('On2: 荷重した足は床で滑らない（動くのは常に遊脚だけ）', () => {
    const c = buildScriptedBasic('on2');
    // 荷重: 1・3・4 = 左足 / 2・5・7・8 = 右足。荷重中の足は動かない
    const still = (b: number, idx: number) =>
      Math.abs(ankle(c, (b + 0.4) * spb, 0, idx).x - ankle(c, (b + 0.1) * spb, 0, idx).x);
    for (const b of [1, 3]) expect(still(b, LANK), `beat ${b} 左`).toBeLessThan(0.01);
    for (const b of [2, 5, 7]) expect(still(b, RANK), `beat ${b} 右`).toBeLessThan(0.01);
  });

  it('On2: 両足が揃う瞬間が一度もない（着地中は常に前後スタッガー）', () => {
    const c = buildScriptedBasic('on2');
    // 「揃わない」のは着地した瞬間の話。遊脚が相手の足を追い越す途中は当然すれ違う。
    // 各カウントの着地位置で前後差が必ず残る（最小は 3・7 の靴1/4ぶん）
    for (const b of [1, 2, 3, 5, 6, 7]) {
      const lL = ankle(c, b * spb, 0, LANK), lR = ankle(c, b * spb, 0, RANK);
      expect(Math.abs(lL.x - lR.x), `beat ${b}`).toBeGreaterThan(0.03);
      const fL = ankle(c, b * spb, 1, LANK), fR = ankle(c, b * spb, 1, RANK);
      expect(Math.abs(fL.x - fR.x), `beat ${b}`).toBeGreaterThan(0.03);
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
