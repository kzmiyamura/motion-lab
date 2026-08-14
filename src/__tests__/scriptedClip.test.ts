import { describe, it, expect } from 'vitest';
import { buildScriptedBasic, buildScriptedCBL } from '../engine/scriptedClip';

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

  // ある拍区間で「左右どちらかの足」が動いた量
  const moved = (c: ReturnType<typeof buildScriptedBasic>, b0: number, b1: number) => {
    const d = (idx: number) =>
      Math.abs(ankle(c, b1 * spb, 0, idx).x - ankle(c, b0 * spb, 0, idx).x);
    return Math.max(d(LANK), d(RANK));
  };

  it('On2: 3と7に「ため」がある（着いた直後は溜め、AND で放つ）', () => {
    const c = buildScriptedBasic('on2');
    // 3 の直後（ため）より 4AND→5（放ち）のほうがはるかに大きく動く
    expect(moved(c, 4.5, 5)).toBeGreaterThan(moved(c, 3, 3.5) * 5);
    // 7 の直後（ため）より 8AND→1（放ち）のほうがはるかに大きく動く
    // 8AND→1 はループを跨ぐので、同じ位相の 0.5→1 で見る
    expect(moved(c, 0.5, 1)).toBeGreaterThan(moved(c, 7, 7.5) * 5);
  });

  it('On2: ため以外は足が止まらない（どちらかの足が必ず動いている）', () => {
    const c = buildScriptedBasic('on2');
    for (let b = 0; b < 8; b += 0.25) {
      // 3→4 と 7→8 は「ため」なので除く。それ以外はどこを切っても動いている
      if ((b >= 3 && b < 4) || (b >= 7 && b < 8)) continue;
      expect(moved(c, b, b + 0.25), `beat ${b}`).toBeGreaterThan(0.005);
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

  it('On2: ブレイクの底は拍の上（重心が拍から遅れない）', () => {
    const c = buildScriptedBasic('on2');
    const hipX = (b: number) => {
      const f = c.frames.reduce((p, q) =>
        (Math.abs(q.t - b * spb) < Math.abs(p.t - b * spb) ? q : p));
      return (f.p['0'].j[7 * 3] + f.p['0'].j[8 * 3]) / 2;   // 腰中点の x
    };
    // 2 = 最も後ろ、6 = 最も前。前後 0.4 拍を見ても 2・6 を追い越さない
    for (const d of [-0.4, -0.2, 0.2, 0.4]) {
      expect(hipX(2 + d), `2${d}`).toBeGreaterThan(hipX(2) - 1e-9);
      expect(hipX(6 + d), `6${d}`).toBeLessThan(hipX(6) + 1e-9);
    }
  });

  it('On2: 4AND/8AND の歩は他より遅い（それでも 1・5 にぴったり着地）', () => {
    const c = buildScriptedBasic('on2');
    // 1 へ向かう左足は 7 から窓を取るが、溜めている間は床の近く。8AND で浮いて 1 で着地
    expect(ankle(c, 7.4 * spb, 0, LANK).y).toBeLessThan(0.13);      // 7 直後は溜め（床の近く）
    expect(ankle(c, 8.5 * spb, 0, LANK).y).toBeGreaterThan(0.13);   // 8AND で放って浮く
    expect(ankle(c, 1 * spb, 0, LANK).y).toBeLessThan(0.13);        // 1 でぴったり接地
    expect(ankle(c, 3.4 * spb, 0, RANK).y).toBeLessThan(0.13);      // 3 直後は溜め
    expect(ankle(c, 4.5 * spb, 0, RANK).y).toBeGreaterThan(0.13);   // 4AND で放って浮く
    expect(ankle(c, 5 * spb, 0, RANK).y).toBeLessThan(0.13);        // 5 でぴったり接地
    // 2・6 のブレイクは 1 拍の歩 = AND の歩より速い
    expect(ankle(c, 1.5 * spb, 0, RANK).y).toBeGreaterThan(0.13);
    expect(ankle(c, 2 * spb, 0, RANK).y).toBeLessThan(0.13);
  });

  it('On2: 1235 67 はボール立ち・踵が下りるのは 4 と 8 だけ', () => {
    const c = buildScriptedBasic('on2');
    // 4 は左足（3 で荷重）、8 は右足（7 で荷重）の踵が下りる = 足首が沈む
    const ballL = ankle(c, 3 * spb, 0, LANK).y, heelL = ankle(c, 4 * spb, 0, LANK).y;
    expect(heelL).toBeLessThan(ballL - 0.02);
    const ballR = ankle(c, 7 * spb, 0, RANK).y, heelR = ankle(c, 8 * spb, 0, RANK).y;
    expect(heelR).toBeLessThan(ballR - 0.02);
    // 1・2・3・5・6・7 は荷重足もボールのまま（踵は下りない）
    for (const [b, idx] of [[1, LANK], [3, LANK], [2, RANK], [5, RANK], [7, RANK]] as const) {
      expect(ankle(c, b * spb, 0, idx).y, `beat ${b}`).toBeGreaterThan(0.11);
    }
  });

  it('On2: ためは「止まり」ではなく踵の上下（3→4 で腰が沈み 4AND で戻る）', () => {
    const c = buildScriptedBasic('on2');
    const hipY = (b: number) => {
      const f = c.frames.reduce((p, q) =>
        (Math.abs(q.t - b * spb) < Math.abs(p.t - b * spb) ? q : p));
      return (f.p['0'].j[7 * 3 + 1] + f.p['0'].j[8 * 3 + 1]) / 2;
    };
    expect(hipY(4)).toBeLessThan(hipY(3) - 0.02);    // 3→4 で踵が下りて沈む
    expect(hipY(4.5)).toBeGreaterThan(hipY(4));      // 4AND で踵が抜けて戻る
    expect(hipY(8)).toBeLessThan(hipY(7) - 0.02);    // 7→8 も同じ
  });

  it('移動中だけ足首が浮き、着地中は接地している', () => {
    const c = buildScriptedBasic('on1');
    const mid = ankle(c, 0.83 * spb, 0, LANK);  // カウント1へ移動中
    const planted = ankle(c, 2 * spb, 0, LANK); // カウント2（着地保持）
    expect(mid.y).toBeGreaterThan(0.13);
    expect(planted.y).toBeLessThan(0.13);
  });

  it('休符（4拍目）は両足とも動いていない', () => {
    const c = buildScriptedBasic('on1');
    const a = ankle(c, 3.5 * spb, 0, LANK), b = ankle(c, 4.4 * spb, 0, LANK);
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.02);
    expect(a.y).toBeLessThan(0.13);
  });
});

describe('手描き CBL の On1 / On2', () => {
  const spb = 60 / 170;
  const on1 = buildScriptedCBL('on1');
  const on2 = buildScriptedCBL('on2');
  const hipX = (c: typeof on1, b: number, pid: 0 | 1) => {
    const f = c.frames.reduce((p, q) =>
      (Math.abs(q.t - b * spb) < Math.abs(p.t - b * spb) ? q : p));
    const p = f.p[String(pid)];
    return (p.j[7 * 3] + p.j[8 * 3]) / 2;
  };

  it('On1 は合格した振付のまま（引数なしでも同じ）', () => {
    const def = buildScriptedCBL();
    expect(def.frames.length).toBe(on1.frames.length);
    for (const b of [0, 1, 5, 9, 13, 16, 25]) {
      expect(hipX(def, b, 0)).toBeCloseTo(hipX(on1, b, 0), 10);
      expect(hipX(def, b, 1)).toBeCloseTo(hipX(on1, b, 1), 10);
    }
  });

  const SHIFT = 5;   // On2 は On1 を 5 拍後ろへずらしたもの

  it('On2 は On1 を 5 拍後ろへずらしたもの', () => {
    for (const b of [6, 10, 14, 20]) {
      // フレーム量子化（30fps）ぶんの差は許す
      expect(hipX(on2, b, 0)).toBeCloseTo(hipX(on1, b - SHIFT, 0), 2);
      expect(hipX(on2, b, 1)).toBeCloseTo(hipX(on1, b - SHIFT, 1), 2);
    }
  });

  it('On2 のブレイクは 2 と 6（On1 は 1 と 5）', () => {
    // 男の前進ブレイク = 腰がいちばん前（+X）に出る拍。On1 は 1、On2 は 6
    expect(hipX(on1, 1, 0)).toBeGreaterThan(hipX(on1, 2, 0));
    expect(hipX(on2, 6, 0)).toBeGreaterThan(hipX(on2, 7, 0));
    expect(hipX(on2, 6, 0)).toBeGreaterThan(hipX(on2, 5, 0));
    // 後退ブレイク = いちばん後ろ（-X）。On1 は 5、On2 は 10（＝次の小節の2）
    expect(hipX(on1, 5, 0)).toBeLessThan(hipX(on1, 4, 0));
    expect(hipX(on2, 10, 0)).toBeLessThan(hipX(on2, 9, 0));
    expect(hipX(on2, 10, 0)).toBeLessThan(hipX(on2, 11, 0));
  });

  it('On2 でも席は交換せず、女だけが男を追い越す', () => {
    // 男は CBL の前後で同じ立ち位置に戻る（PIVOT_X = -0.30 付近）
    expect(hipX(on2, SHIFT, 0)).toBeCloseTo(hipX(on2, 16 + SHIFT, 0), 1);
    // 女は男を追い越して反対側へ抜ける
    expect(hipX(on2, SHIFT, 1)).toBeGreaterThan(hipX(on2, SHIFT, 0));
    expect(hipX(on2, 16 + SHIFT, 1)).toBeLessThan(hipX(on2, 16 + SHIFT, 0));
  });

  it('On2 の歩幅はベーシック On2 と同じ（6は左足で前・2は右足で後ろ）', () => {
    // 男は 6（前進ブレイク）と 10（＝次の小節の2・後退ブレイク）で +X を向いている
    const basic = buildScriptedBasic('on2');
    const rel = (c: typeof on1, b: number, idx: number) => ankle(c, b * spb, 0, idx).x - hipX(c, b, 0);
    // 歩幅（後退ブレイクの右足 → 前進ブレイクの左足）がベーシック On2 と同じであること
    expect(ankle(on2, 6 * spb, 0, LANK).x - ankle(on2, 10 * spb, 0, RANK).x)
      .toBeCloseTo(ankle(basic, 6 * spb, 0, LANK).x - ankle(basic, 2 * spb, 0, RANK).x, 1);
    // 腰から見た前後もベーシックと同程度（ベーシックは重心が ±0.175 揺れるので rel も ±0.175）
    // CBL の腰の揺れはベーシックとぴったり同じではないので 8cm まで許す
    expect(Math.abs(rel(on2, 6, LANK) - rel(basic, 6, LANK))).toBeLessThan(0.08);
    expect(Math.abs(rel(on2, 10, RANK) - rel(basic, 2, RANK))).toBeLessThan(0.08);
    expect(rel(on2, 6, LANK)).toBeGreaterThan(0.15);    // 6: 左足が腰よりはっきり前
    expect(rel(on2, 10, RANK)).toBeLessThan(-0.15);     // 2: 右足がはっきり後ろ
    // 6 では左足が右足より前、2 では右足が左足より後ろ
    expect(ankle(on2, 6 * spb, 0, LANK).x).toBeGreaterThan(ankle(on2, 6 * spb, 0, RANK).x);
    expect(ankle(on2, 10 * spb, 0, RANK).x).toBeLessThan(ankle(on2, 10 * spb, 0, LANK).x);
  });

  it('On2 のカウント7（その場の踏み直し）は足が上がり、つま先が外を向く', () => {
    const LTOE = 17, RTOE = 18;
    // 男のカウント7 = 右足。2小節目の 15 拍目で見る（着地の 0.5 拍前が最高点）
    const mid = ankle(on2, 14.5 * spb, 0, RANK);
    const land = ankle(on2, 15 * spb, 0, RANK);
    expect(mid.y - land.y).toBeGreaterThan(0.03);   // 3cm 以上は浮く
    // つま先が体の向きから外（右足なので右）へ開いている
    const toe = ankle(on2, 15 * spb, 0, RTOE);
    expect(toe.v).toBe(1);
    const ang = Math.atan2(toe.x - land.x, toe.z - land.z);
    const hipAng = Math.PI / 2;   // 2小節目の 15 拍目で男は概ね +X を向いている
    expect(ang - hipAng).toBeGreaterThan(0.3);      // 17° 以上外向き
    // On1 はつま先を書かない = これまでの見た目のまま
    expect(ankle(on1, 15 * spb, 0, RTOE).v).toBe(0);
    expect(ankle(on1, 15 * spb, 0, LTOE).v).toBe(0);
  });

  it('On2 でも着地した足はワールドで滑らない', () => {
    for (const idx of [LANK, RANK]) {
      // 荷重中（着地の直後 0.05〜0.45 拍）は動かない。左=1,3,6 右=2,5,7（2小節目で見る）
      const beats = idx === LANK ? [9, 11, 14] : [10, 13, 15];
      for (const b of beats) {
        const a = ankle(on2, (b + 0.05) * spb, 0, idx);
        const d = ankle(on2, (b + 0.45) * spb, 0, idx);
        expect(Math.hypot(a.x - d.x, a.z - d.z), `beat ${b}`).toBeLessThan(0.01);
      }
    }
  });
});
