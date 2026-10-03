import { describe, it, expect } from 'vitest';
import { composeRoutine, routineFromResult } from '../engine/routineClip';
import { buildScriptedBasic } from '../engine/scriptedClip';
import type { MotionClip } from '../components/MocapFigure';

const LHIP = 7, RHIP = 8;
const hip = (c: MotionClip, i: number, pid: '0' | '1') => {
  const j = c.frames[i].p[pid].j;
  return [(j[LHIP * 3] + j[RHIP * 3]) / 2, (j[LHIP * 3 + 2] + j[RHIP * 3 + 2]) / 2];
};
/** 隣り合うフレーム間の腰の最大移動[m] */
const maxHipJump = (c: MotionClip) => {
  let m = 0;
  for (let i = 1; i < c.frames.length; i++) {
    for (const pid of ['0', '1'] as const) {
      const a = hip(c, i - 1, pid), b = hip(c, i, pid);
      m = Math.max(m, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
  }
  return m;
};

describe('composeRoutine', () => {
  it('ベーシック1小節だけなら合格済みのベーシックと同じ動き', () => {
    for (const timing of ['on1', 'on2'] as const) {
      const { clip, coverage } = composeRoutine({ timing, bpm: 170, moves: [{ move: 'basic' }] });
      const ref = buildScriptedBasic(timing);
      expect(coverage[0].kind).toBe('exact');
      expect(clip.duration).toBeCloseTo(ref.duration, 6);
      for (let i = 0; i < ref.frames.length - 1; i++) {
        const a = clip.frames[i].p['0'].j, b = ref.frames[i].p['0'].j;
        for (let k = 0; k < a.length; k++) expect(a[k]).toBeCloseTo(b[k], 4);
      }
    }
  });

  it('技の継ぎ目で立ち位置が飛ばない（CBL を2回続けても）', () => {
    for (const timing of ['on1', 'on2'] as const) {
      const { clip } = composeRoutine({
        timing, bpm: 170,
        moves: [{ move: 'basic' }, { move: 'cbl' }, { move: 'basic' }, { move: 'cbl' }, { move: 'basic' }],
      });
      // 1フレーム(1/30秒)で 8cm 以上動く = 瞬間移動。CBL の通り抜けでも 1拍 45cm 程度
      expect(maxHipJump(clip)).toBeLessThan(0.08);
    }
  });

  it('CBL のあとは男女の左右が入れ替わり、2回で元に戻る', () => {
    const { clip } = composeRoutine({ timing: 'on1', bpm: 170, moves: [{ move: 'basic' }, { move: 'cbl' }, { move: 'cbl' }] });
    const spb = 60 / 170;
    const frameAt = (beat: number) => Math.round(beat * spb * 30);
    const side = (beat: number) => Math.sign(hip(clip, frameAt(beat), '1')[0] - hip(clip, frameAt(beat), '0')[0]);
    expect(side(4)).toBe(1);        // 女が男の +X 側
    expect(side(16)).toBe(-1);      // 1回目の CBL のあと反対側
    expect(side(24 - 0.01)).toBe(1); // 2回目で戻る
  });

  it('手描きが無い技はベーシックで代用し、近似と申告する', () => {
    const { coverage, clip } = composeRoutine({
      timing: 'on2', moves: [{ move: 'right_turn', name: '右ターン' }, { move: 'cbl', counts: 16 }],
    });
    expect(coverage.map((c) => c.kind)).toEqual(['approx', 'exact']);
    expect(coverage[1].beats).toBe(16);
    expect(clip.events.some((e) => e.type.includes('近似'))).toBe(true);
    // 腕の台本は隙間なく全尺を覆う
    const s = clip.armTimeline!.segments;
    expect(s[0].t0).toBe(0);
    expect(s[s.length - 1].t1).toBeCloseTo(clip.duration, 6);
    for (let i = 1; i < s.length; i++) expect(s[i].t0).toBeCloseTo(s[i - 1].t1, 6);
  });

  it('解析のテンポで再生速度が変わる', () => {
    const { clip } = composeRoutine({ timing: 'on1', bpm: 200, moves: [{ move: 'basic' }] });
    expect(clip.duration).toBeCloseTo(8 * 60 / 200, 6);
    expect(clip.beatGrid?.bpm).toBe(200);
  });
});

describe('routineFromResult', () => {
  it('routine があればそれを使う（未知の技名は other）', () => {
    const r = routineFromResult(JSON.stringify({
      style: { onBeat: 'on2' },
      routine: { timing: 'on2', bpm: 180, moves: [{ move: 'cbl' }, { move: 'spinning_thing' }] },
    }));
    expect(r?.timing).toBe('on2');
    expect(r?.bpm).toBe(180);
    expect(r?.moves.map((m) => m.move)).toEqual(['cbl', 'other']);
  });

  it('旧形式は確定イベントから並べる（doubtful は使わない）', () => {
    const r = routineFromResult(JSON.stringify({
      style: { onBeat: 'unclear' },
      events: [
        { t: 1, type: 'CBL', by: 'pair', verdict: 'ok' },
        { t: 2, type: 'Turn', by: 'follower', verdict: 'ok' },       // 同じ小節 → 捨てる
        { t: 5, type: 'Turn', by: 'follower', verdict: 'doubtful' },
        { t: 9, type: 'Turn', by: 'follower', verdict: 'ok' },
      ],
    }));
    expect(r?.timing).toBe('unclear');
    // 1小節 = 8拍 = 2.82秒（170BPM）。CBL(1秒)の小節が 3.82秒で終わり、9秒のターンまでに丸1小節空く
    expect(r?.moves.map((m) => m.move)).toEqual(['basic', 'cbl', 'basic', 'right_turn', 'basic']);
  });

  it('壊れた JSON・技なしは null', () => {
    expect(routineFromResult('{')).toBeNull();
    expect(routineFromResult(JSON.stringify({ events: [] }))).toBeNull();
    expect(routineFromResult(null)).toBeNull();
  });
});
