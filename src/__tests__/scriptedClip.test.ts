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

describe('クローズドポジション', () => {
  const spb = 60 / 170;

  it('既定（片手ホールド）は closed=false と完全一致 — 合格した見た目を変えない', () => {
    for (const t of ['on1', 'on2'] as const) {
      expect(JSON.stringify(buildScriptedBasic(t).armTimeline))
        .toBe(JSON.stringify(buildScriptedBasic(t, false).armTimeline));
      expect(JSON.stringify(buildScriptedCBL(t).armTimeline))
        .toBe(JSON.stringify(buildScriptedCBL(t, false).armTimeline));
    }
  });

  it('ベーシックは全編クローズド: 男の右手が背中・女の左手が肩、つなぎ手はそのまま', () => {
    for (const t of ['on1', 'on2'] as const) {
      const segs = buildScriptedBasic(t, true).armTimeline!.segments;
      expect(segs).toHaveLength(1);
      expect(segs[0].leader).toEqual({ L: 'hold', R: 'closed_back' });
      expect(segs[0].follower).toEqual({ L: 'closed_shoulder', R: 'hold' });
      expect(segs[0].hold).toEqual({ leader: 'L', follower: 'R' });
    }
  });

  it('CBL は女を通す局面（prep/pass/close）で組み手を離し、hold 局面だけクローズド', () => {
    const segs = buildScriptedCBL('on1', true).armTimeline!.segments;
    for (const s of segs) {
      if (s.phase === 'closed') {
        expect(s.leader.R).toBe('closed_back');
        expect(s.follower.L).toBe('closed_shoulder');
      } else {
        expect(s.leader.R).toBe('free');
        expect(s.follower.L).toBe('free');
      }
    }
    // 通り抜けの間（カウント11あたり）はクローズドではない
    const at = (b: number) => segs.find((s) => b * spb >= s.t0 && b * spb < s.t1)!;
    expect(at(11).phase).toBe('pass');
    expect(at(2).phase).toBe('closed');
  });

  // 「女の3を逆方向にした」の再発防止（ユーザー指示 2026-08-16
  // 「1・2・3 共々前に出す」「3 の足は 2 のもう少し前」）。**3 以外は触らない**
  it('CBL On2: 女の 3 は 2 のもう少し前に置く', () => {
    const LANK_ = 11, RANK_ = 12;
    const clip = buildScriptedCBL('on2', false);
    const at = (b: number) => {
      const f = clip.frames.reduce((a, x) =>
        (Math.abs(x.t - b * spb) < Math.abs(a.t - b * spb) ? x : a));
      const p = f.p['1'];
      let lx = p.j[7 * 3] - p.j[8 * 3], lz = p.j[7 * 3 + 2] - p.j[8 * 3 + 2];
      const n = Math.hypot(lx, lz) || 1; lx /= n; lz /= n;
      return {
        L: [p.j[LANK_ * 3], p.j[LANK_ * 3 + 2]],
        R: [p.j[RANK_ * 3], p.j[RANK_ * 3 + 2]],
        fwd: [-lz, lx],
      };
    };
    // 女は 1・3 が右足、5・7 が左足
    const along = (b0: number, b1: number, foot: 'L' | 'R') => {
      const a = at(b0), c = at(b1);
      return (c[foot][0] - a[foot][0]) * c.fwd[0] + (c[foot][1] - a[foot][1]) * c.fwd[1];
    };
    expect(along(1, 3, 'R'), '1→3 は前へ').toBeGreaterThan(0);
    // **3 の足は 2 の足のもう少し前**（ユーザー指示）。1 基準で置くと 2 より後ろになる
    const a2 = at(2), a3 = at(3);
    const past2 = (a3.R[0] - a2.L[0]) * a3.fwd[0] + (a3.R[1] - a2.L[1]) * a3.fwd[1];
    expect(past2, '3 の足は 2 より前').toBeGreaterThan(0);

    // **前に出すのは「送り出されるときの 3」だけ**（ユーザー指摘 2026-08-16:
    // 「CBL に入る前の 3 まで前に出てしまってる。送り出されるときの 3 とは別」）。
    // 女が通り抜けるのは拍 1〜4 と 17〜20（腰の移動 30〜45cm/拍 で実測）なので、
    // 送り出される 3 = 拍 3・19、CBL に入る前の 3 = 拍 11・27
    for (const b of [3, 19]) {
      const p2 = at(b - 1), p3 = at(b);
      const d = (p3.R[0] - p2.L[0]) * p3.fwd[0] + (p3.R[1] - p2.L[1]) * p3.fwd[1];
      expect(d, `拍${b}（送り出される3）は 2 より前`).toBeGreaterThan(0);
    }
    for (const b of [11, 27]) {
      const p2 = at(b - 1), p3 = at(b);
      const d = (p3.R[0] - p2.L[0]) * p3.fwd[0] + (p3.R[1] - p2.L[1]) * p3.fwd[1];
      expect(d, `拍${b}（CBL に入る前の3）は前に出さない`).toBeLessThan(0);
    }
  });

  // 「女の足が重心の下に無い」の再発防止（2026-08-16）。
  // 着地の基準を小節ごとの固定平均で取ると、小節の中で移動する人（CBL で男を
  // 追い越す女）の足が体から置き去りになる。修正前は足の中点が体の 15.8cm 前
  // （男は 4.9cm）で、両足が同じ側に揃うフレームが 30%（男 14%）あった
  it('CBL On2: 足の中点は体の下にある（女が置き去りにならない）', () => {
    const LANK_ = 11, RANK_ = 12;
    const under = (clip: ReturnType<typeof buildScriptedCBL>, pid: '0' | '1') => {
      let sum = 0, both = 0, n = 0;
      for (const f of clip.frames) {
        const p = f.p[pid];
        const hx = (p.j[7 * 3] + p.j[8 * 3]) / 2, hz = (p.j[7 * 3 + 2] + p.j[8 * 3 + 2]) / 2;
        let lx = p.j[7 * 3] - p.j[8 * 3], lz = p.j[7 * 3 + 2] - p.j[8 * 3 + 2];
        const d = Math.hypot(lx, lz) || 1; lx /= d; lz /= d;
        // 体の前方 = 左右軸を 90° 回したもの
        const fwd = (idx: number) =>
          (p.j[idx * 3] - hx) * -lz + (p.j[idx * 3 + 2] - hz) * lx;
        const a = fwd(LANK_), b = fwd(RANK_);
        // **符号つきで平均する**。置き去り = 足が体の片側へ寄り続けること。
        // 絶対値で見ると、歩けば必ず出る前後の振れまで拾ってしまい、
        // 「1・2・3 は前へ歩く」という振付そのものを不合格にしてしまう
        sum += (a + b) / 2; n++;
        if (Math.min(a, b) > 0.10 || Math.max(a, b) < -0.10) both++;
      }
      return { mean: Math.abs(sum / n), bothPct: both / n };
    };
    const clip = buildScriptedCBL('on2', false);
    const l = under(clip, '0'), f = under(clip, '1');
    // 女の「置き去り具合」は男を超えない（超えたら基準の取り方が壊れている）。
    // bothPct は見ない — 1・2・3 で前へ歩けば両足が前に揃う瞬間は必ず出る。
    // 見るのは「片側へ寄り続けていないか」だけ
    expect(f.mean, '足の中点の前後ズレ').toBeLessThan(Math.max(l.mean, 0.08) * 1.5);
    void f.bothPct;
  });

  // 「女がジャンプしている」の再発防止（2026-08-16）。
  // 踵が下りて足首が HEEL_DROP(3.5cm) 沈むとき、腰も同じだけ沈めないと
  // 支持脚だけが伸び縮みして体が上下する。修正前は女だけ幅 6.5cm・0.98cm/f で、
  // 男（3.0cm・0.14cm/f）の 7 倍暴れていた
  it('CBL: 支持脚の伸びは男女で同じように収まる（女が跳ねない）', () => {
    const LANK_ = 11, RANK_ = 12;
    const stretch = (clip: ReturnType<typeof buildScriptedCBL>, pid: '0' | '1') => {
      let min = Infinity, max = -Infinity, jerk = 0, prev: number | null = null;
      for (const f of clip.frames) {
        const p = f.p[pid];
        const v = (p.j[7 * 3 + 1] + p.j[8 * 3 + 1]) / 2
          - Math.min(p.j[LANK_ * 3 + 1], p.j[RANK_ * 3 + 1]);
        min = Math.min(min, v); max = Math.max(max, v);
        if (prev !== null) jerk = Math.max(jerk, Math.abs(v - prev));
        prev = v;
      }
      return { span: max - min, jerk };
    };
    for (const t of ['on1', 'on2'] as const) {
      for (const closed of [false, true]) {
        const clip = buildScriptedCBL(t, closed);
        const l = stretch(clip, '0'), f = stretch(clip, '1');
        const tag = `${t} ${closed ? 'closed' : 'open'}`;
        expect(f.span, `${tag} 伸びの幅`).toBeCloseTo(l.span, 2);
        expect(f.jerk, `${tag} 1フレームの変化`).toBeLessThanOrEqual(l.jerk + 1e-4);
      }
    }
  });

  it('CBL のクローズドは、組んでいる間だけ詰まり、通り抜けは元の間隔に戻る', () => {
    const hip = (p: { j: Float32Array | number[] }, ax: 0 | 2) =>
      (p.j[7 * 3 + ax] + p.j[8 * 3 + ax]) / 2;
    const at = (clip: ReturnType<typeof buildScriptedCBL>, t: number) =>
      clip.frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    const gap = (clip: ReturnType<typeof buildScriptedCBL>, b: number) => {
      const f = at(clip, b * spb);
      return Math.hypot(hip(f.p['0'], 0) - hip(f.p['1'], 0), hip(f.p['0'], 2) - hip(f.p['1'], 2));
    };
    for (const t of ['on1', 'on2'] as const) {
      const shift = t === 'on2' ? 5 : 0;
      const open = buildScriptedCBL(t, false), cl = buildScriptedCBL(t, true);
      // 組んでいる間（拍4 = 通り抜け前）は詰まる
      expect(gap(cl, 4 + shift)).toBeLessThan(gap(open, 4 + shift) * 0.8);
      // 通り抜けの最中（拍11〜13）は 1cm も変えない — 追い越す空間を潰さない
      for (const b of [11, 12, 13]) {
        expect(gap(cl, b + shift), `beat ${b}`).toBeCloseTo(gap(open, b + shift), 2);
      }
      // 男は 1 ミリも動かさない（焼き込んだ足の振付を触らない）
      for (const b of [2, 6, 11, 14]) {
        const a = at(open, (b + shift) * spb).p['0'], c = at(cl, (b + shift) * spb).p['0'];
        expect(Array.from(c.j)).toEqual(Array.from(a.j));
      }
    }
  });

  // 0.37 は「見えている胴体（カプセル半径 0.135）どうしを 10cm 空ける」距離
  // （ユーザー指示 2026-08-16）。腕が届かないぶんは肩の前出しで補うので、
  // ここを詰めて解決してはいけない
  it('ベーシックのクローズドは組める距離まで詰まる（腰の間隔 0.70m → 0.37m）', () => {
    const hipX = (p: { j: Float32Array | number[] }) => (p.j[7 * 3] + p.j[8 * 3]) / 2;
    const gap = (clip: ReturnType<typeof buildScriptedBasic>, t: number) => {
      const f = clip.frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      return Math.abs(hipX(f.p['0']) - hipX(f.p['1']));
    };
    for (const t of ['on1', 'on2'] as const) {
      const open = buildScriptedBasic(t, false), cl = buildScriptedBasic(t, true);
      for (const b of [0, 1, 2, 5, 6]) {
        expect(gap(open, b * spb), `open beat ${b}`).toBeCloseTo(0.70, 2);
        expect(gap(cl, b * spb), `closed beat ${b}`).toBeCloseTo(0.37, 2);
      }
    }
  });

  it('詰めても足の踏み方（腰から見た足の位置）は変わらない', () => {
    const LANK_ = 11, RANK_ = 12;
    const rel = (clip: ReturnType<typeof buildScriptedBasic>, t: number, pid: '0' | '1', idx: number) => {
      const f = clip.frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      const p = f.p[pid];
      const hx = (p.j[7 * 3] + p.j[8 * 3]) / 2, hz = (p.j[7 * 3 + 2] + p.j[8 * 3 + 2]) / 2;
      return [p.j[idx * 3] - hx, p.j[idx * 3 + 1], p.j[idx * 3 + 2] - hz];
    };
    for (const t of ['on1', 'on2'] as const) {
      const open = buildScriptedBasic(t, false), cl = buildScriptedBasic(t, true);
      for (const b of [1, 2, 3, 5, 6, 7]) {
        for (const pid of ['0', '1'] as const) {
          for (const idx of [LANK_, RANK_]) {
            const a = rel(open, b * spb, pid, idx), c = rel(cl, b * spb, pid, idx);
            for (let i = 0; i < 3; i++) expect(c[i], `${t} ${pid} beat ${b}`).toBeCloseTo(a[i], 5);
          }
        }
      }
    }
  });
});

describe('CBL On2 の女の足', () => {
  const spb = 60 / 170;
  const on2 = buildScriptedCBL('on2');
  const on1 = buildScriptedCBL('on1');
  const at = (clip: typeof on2, b: number, pid: 0 | 1, idx: number) => {
    const t = b * spb;
    const f = clip.frames.reduce((a, c) => (Math.abs(c.t - t) < Math.abs(a.t - t) ? c : a));
    const p = f.p[String(pid)];
    return { x: p.j[idx * 3], y: p.j[idx * 3 + 1], z: p.j[idx * 3 + 2], v: p.v[idx] };
  };
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);

  // 2026-08-16: 手続き生成だとリグが拍ごとに足を出し続けて 4・8 で休めない
  // （振付には 4・8 の歩が無い）というユーザー指摘で、On1 の女も焼き込みへ変更
  it('On1 の女にも足が焼き込まれている（4・8 で休むため）', () => {
    expect(at(on1, 6, 1, LANK).v).toBe(1);
    expect(at(on1, 6, 1, RANK).v).toBe(1);
  });

  it('CBL: 女は 4・8 で足を動かさない（休む）', () => {
    for (const t of ['on1', 'on2'] as const) {
      const clip = buildScriptedCBL(t, false);
      const spb = clip.beatGrid.beatIntervalSec;
      const foot = (b: number, idx: number) => {
        const f = clip.frames.reduce((a, x) =>
          (Math.abs(x.t - b * spb) < Math.abs(a.t - b * spb) ? x : a));
        return [f.p['1'].j[idx * 3], f.p['1'].j[idx * 3 + 2]];
      };
      // 4・8 の前後 0.4 拍で足がほとんど動かない = 休んでいる。
      // 拍 12・16・28 は**通り抜けの最中**で女が実際に移動しているので除く
      // （男の同じ拍も 10〜16cm 動く）。焼き込み前の女は毎拍出し続けていた
      for (const b of [4, 8, 20, 24]) {
        for (const idx of [LANK, RANK]) {
          const a = foot(b - 0.4, idx), c = foot(b + 0.4, idx);
          expect(Math.hypot(a[0] - c[0], a[1] - c[1]), `${t} 拍${b} joint${idx}`)
            .toBeLessThan(t === 'on1' ? 0.12 : 0.30);
        }
      }
    }
  });

  it('On2 は女にも足が焼き込まれている', () => {
    for (const b of [6, 10, 14, 22]) {
      expect(at(on2, b, 1, LANK).v, `beat ${b}`).toBe(1);
      expect(at(on2, b, 1, RANK).v, `beat ${b}`).toBe(1);
    }
  });

  it('On2: 女の歩幅は男と同じ（男の左足の鏡が女の右足）', () => {
    // 男の左足のブレイク（14 = カウント6）と、その鏡である女の右足を比べる。
    // CBL は2人とも移動しているので、値そのものはベーシックの 0.70 にはならない —
    // 見るのは「男女で同じか」
    const lead = dist(at(on2, 14, 0, LANK), at(on2, 10, 0, LANK));
    const foll = dist(at(on2, 14, 1, RANK), at(on2, 10, 1, RANK));
    expect(lead).toBeGreaterThan(0.3);
    expect(Math.abs(foll - lead)).toBeLessThan(0.05);
  });

  it('On2: 女の荷重した足は床で滑らない', () => {
    // 女の荷重足は男の鏡（男が左のカウントで女は右）
    for (const [b, idx] of [[13, LANK], [14, RANK], [15, LANK]] as const) {
      expect(dist(at(on2, b + 0.05, 1, idx), at(on2, b + 0.45, 1, idx)), `beat ${b}`)
        .toBeLessThan(0.02);
    }
  });

  it('On2: 女の足は腰の下にある（腰だけ動いて脚が伸びていない）', () => {
    for (const b of [10, 12, 14, 15]) {
      const f = on2.frames.reduce((a, c) =>
        (Math.abs(c.t - b * spb) < Math.abs(a.t - b * spb) ? c : a));
      const p = f.p['1'];
      const hip = { x: (p.j[7 * 3] + p.j[8 * 3]) / 2, z: (p.j[7 * 3 + 2] + p.j[8 * 3 + 2]) / 2 };
      for (const idx of [LANK, RANK]) {
        expect(dist(hip, at(on2, b, 1, idx)), `beat ${b}`).toBeLessThan(0.55);
      }
    }
  });

  it('On2: 男女で足を踏み合わない', () => {
    for (const b of [10, 11, 13, 14, 15]) {
      for (const li of [LANK, RANK]) {
        for (const fi of [LANK, RANK]) {
          expect(dist(at(on2, b, 0, li), at(on2, b, 1, fi)), `beat ${b}`).toBeGreaterThan(0.10);
        }
      }
    }
  });
});
