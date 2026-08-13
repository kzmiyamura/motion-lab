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

  it('On2: カウント1は同じ足で方向が逆（男左足が後ろ・女右足が前）', () => {
    const c = buildScriptedBasic('on2');
    const lL = ankle(c, spb, 0, LANK), lR = ankle(c, spb, 0, RANK);
    const fL = ankle(c, spb, 1, LANK), fR = ankle(c, spb, 1, RANK);
    expect(lL.x - lR.x).toBeLessThan(-0.2);     // 男: 左足が後ろ
    expect(fR.x - fL.x).toBeLessThan(-0.2);     // 女: 右足が前
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
