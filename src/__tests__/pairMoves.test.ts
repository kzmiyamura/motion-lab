import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PairMoveDetector, PAIR_TUNING, measurePerson, type PairMove, type PoseLandmarkLike } from '../engine/pairMoves';
import { isSamePose } from '../hooks/usePoseEstimation';

/**
 * 腰中点 hipX、体の向き angle（0 = カメラ正面、π = 背面）、大きさ scale の人物ランドマーク。
 * handUp = true なら片手（15）を頭より上に上げる
 */
function person(hipX: number, angle = 0, scale = 1, hipY = 0.7, handUp = false): PoseLandmarkLike[] {
  const lm: PoseLandmarkLike[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const torso = 0.25 * scale;
  const half = 0.09 * scale * Math.cos(angle); // 正面向きでは左肩(11)が画面右
  const shY = hipY - torso;
  lm[11] = { x: hipX + half, y: shY, visibility: 0.9 };
  lm[12] = { x: hipX - half, y: shY, visibility: 0.9 };
  lm[23] = { x: hipX + half * 0.7, y: hipY, visibility: 0.9 };
  lm[24] = { x: hipX - half * 0.7, y: hipY, visibility: 0.9 };
  lm[0] = { x: hipX, y: shY - 0.08 * scale, visibility: 0.9 };
  lm[27] = { x: hipX - 0.05 * scale, y: hipY + 0.25 * scale, visibility: 0.9 };
  lm[28] = { x: hipX + 0.05 * scale, y: hipY + 0.25 * scale, visibility: 0.9 };
  if (handUp) lm[15] = { x: hipX + 0.05 * scale, y: shY - 0.2 * scale, visibility: 0.9 };
  return lm;
}

const FPS = 15;
function run(dur: number, frame: (t: number) => PoseLandmarkLike[][]): PairMove[] {
  const det = new PairMoveDetector();
  const out: PairMove[] = [];
  for (let i = 0; i <= dur * FPS; i++) {
    const t = i / FPS;
    out.push(...det.push(t, frame(t)));
  }
  out.push(...det.flush());
  return out;
}

/** 0→1 を時刻 t0〜t1 でなめらかに */
const ramp = (t: number, t0: number, t1: number) =>
  t <= t0 ? 0 : t >= t1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * (t - t0) / (t1 - t0));

/** 時刻 t が [t0, t1) に入るか */
const within = (t: number, t0: number, t1: number) => t >= t0 && t < t1;

describe('PairMoveDetector（CBL）', () => {
  it('2人の左右が入れ替わると CBL を1回検出する（交差時刻付近）', () => {
    const ev = run(10, t => {
      const k = ramp(t, 4, 5);
      return [person(0.3 + 0.4 * k), person(0.7 - 0.4 * k)];
    });
    const cbl = ev.filter(e => e.action === 'CBL');
    expect(cbl).toHaveLength(1);
    expect(Math.abs(cbl[0].t - 4.5)).toBeLessThan(0.5);
    expect(ev.filter(e => e.action === 'Turn')).toHaveLength(0);
  });

  it('交差中に片方が見えなくなっても（検出の途切れ）CBL を検出する', () => {
    const ev = run(10, t => {
      const k = ramp(t, 4, 5);
      const a = person(0.3 + 0.4 * k), b = person(0.7 - 0.4 * k);
      return within(t, 3.8, 5.3) ? [a] : [a, b];
    });
    expect(ev.filter(e => e.action === 'CBL')).toHaveLength(1);
  });

  it('カメラのパン（2人が同じ向きに動く）では CBL にならない', () => {
    const ev = run(10, t => {
      const pan = 0.3 * Math.sin(t);
      return [person(0.35 + pan), person(0.6 + pan)];
    });
    expect(ev).toHaveLength(0);
  });

  it('離れた位置でしか並びが確認できない入れ替わり（ペアではない2人）は CBL にしない', () => {
    // 胴長 0.25 に対して腰の距離 0.9（3.6 胴長）は pairMaxSep を超える。近づいた区間は片方が映っていない
    const ev = run(10, t => {
      const k = ramp(t, 4, 5);
      const a = person(0.05 + 0.9 * k), b = person(0.95 - 0.9 * k);
      return within(t, 3.9, 5.1) ? [a] : [a, b];
    });
    expect(ev.filter(e => e.action === 'CBL')).toHaveLength(0);
  });

  it('1人しか映っていない区間（立ち話・ロゴ）ではイベントを出さない', () => {
    const ev = run(10, t => [person(0.3 + 0.4 * ramp(t, 4, 5), 2 * Math.PI * ramp(t, 6, 7))]);
    expect(ev).toHaveLength(0);
  });

  it('背景（鏡）の小さな人物は主ペアに入らない', () => {
    const ev = run(10, t => {
      const k = ramp(t, 4, 5);
      // 小さい2人が左右に入れ替わっても無視。主ペアは静止
      return [person(0.3), person(0.7), person(0.1 + 0.2 * k, 0, 0.3, 0.3), person(0.3 - 0.2 * k, 0, 0.3, 0.3)];
    });
    expect(ev).toHaveLength(0);
  });

  it('時刻が大きく戻ったら（シーク・ループ）状態を捨てて再検出できる', () => {
    const det = new PairMoveDetector();
    const out: PairMove[] = [];
    const frame = (t: number) => {
      const k = ramp(t, 4, 5);
      return [person(0.3 + 0.4 * k), person(0.7 - 0.4 * k)];
    };
    for (let loop = 0; loop < 2; loop++) {
      for (let i = 0; i <= 10 * FPS; i++) out.push(...det.push(i / FPS, frame(i / FPS)));
    }
    expect(out.filter(e => e.action === 'CBL')).toHaveLength(2);
  });
});

describe('PairMoveDetector（手上げターン）', () => {
  it('手が頭上に一瞬上がると Turn を1回出す', () => {
    const ev = run(10, t => [person(0.3, 0, 1, 0.7, within(t, 5, 5.4)), person(0.6)]);
    const turns = ev.filter(e => e.action === 'Turn');
    expect(turns).toHaveLength(1);
    expect(Math.abs(turns[0].t - 5.4)).toBeLessThan(0.5);
  });

  it('長く手を上げ続ける（説明の身振り）は Turn にしない', () => {
    const ev = run(10, t => [person(0.3, 0, 1, 0.7, within(t, 3, 6)), person(0.6)]);
    expect(ev.filter(e => e.action === 'Turn')).toHaveLength(0);
  });

  it('CBL の直後のターンは CBL と別のイベントとして出す', () => {
    const ev = run(12, t => {
      const k = ramp(t, 4, 5);
      return [person(0.3 + 0.4 * k, 0, 1, 0.7, within(t, 5.8, 6.1)), person(0.7 - 0.4 * k)];
    });
    expect(ev.filter(e => e.action === 'CBL')).toHaveLength(1);
    const turns = ev.filter(e => e.action === 'Turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].t).toBeGreaterThan(5.5);
  });

  it('1人だけ（ペアがいない）なら手を上げても出さない', () => {
    const ev = run(10, t => [person(0.3, 0, 1, 0.7, within(t, 5, 5.4))]);
    expect(ev).toHaveLength(0);
  });
});

describe('PairMoveDetector（向きの反転によるターン: PAIR_TUNING.flip）', () => {
  let saved: boolean;
  beforeEach(() => { saved = PAIR_TUNING.flip; PAIR_TUNING.flip = true; });
  afterEach(() => { PAIR_TUNING.flip = saved; });

  it('一回転（向きの反転2回）を Turn として1回検出し、回った人のスロットを返す', () => {
    const ev = run(10, t => [person(0.3), person(0.7, 2 * Math.PI * ramp(t, 4, 5))]);
    const turns = ev.filter(e => e.action === 'Turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].by).toBe(1);
    expect(turns[0].t).toBeGreaterThan(4);
    expect(turns[0].t).toBeLessThan(5);
  });

  it('ゆっくり半回転して戻るのは Turn にしない', () => {
    const slow = run(12, t => [person(0.3), person(0.7, Math.PI * (ramp(t, 3, 5) - ramp(t, 6, 8)))]);
    expect(slow.filter(e => e.action === 'Turn')).toHaveLength(0);
  });

  it('CBL 直後のフォロワーのターンは CBL に抑制されない', () => {
    const ev = run(12, t => {
      const k = ramp(t, 4, 5);
      return [person(0.3 + 0.4 * k), person(0.7 - 0.4 * k, 2 * Math.PI * ramp(t, 5.6, 6.6))];
    });
    expect(ev.filter(e => e.action === 'CBL')).toHaveLength(1);
    expect(ev.filter(e => e.action === 'Turn')).toHaveLength(1);
  });

  it('2人が同時に回ったら連られ回転として片方だけ残す', () => {
    const ev = run(10, t => [
      person(0.3, 2 * Math.PI * ramp(t, 4.2, 5.0)),
      person(0.7, 2 * Math.PI * ramp(t, 4, 5)),
    ]);
    expect(ev.filter(e => e.action === 'Turn')).toHaveLength(1);
  });

  it('既定では無効（立ち話・パンでの誤検出を避ける）', () => {
    PAIR_TUNING.flip = false;
    const ev = run(10, t => [person(0.3), person(0.7, 2 * Math.PI * ramp(t, 4, 5))]);
    expect(ev.filter(e => e.action === 'Turn')).toHaveLength(0);
  });
});

describe('measurePerson / isSamePose', () => {
  it('手首が頭より上なら handUp', () => {
    expect(measurePerson(person(0.5, 0, 1, 0.7, true))?.handUp).toBe(true);
    expect(measurePerson(person(0.5))?.handUp).toBe(false);
  });

  it('肩が見えない人物は測らない', () => {
    const lm = person(0.5);
    lm[11] = { ...lm[11], visibility: 0.1 };
    expect(measurePerson(lm)).toBeNull();
  });

  it('組んで近くにいる2人は別人、ほぼ同じ骨格は同一人物とみなす', () => {
    const a = person(0.45) as never, b = person(0.55) as never;
    expect(isSamePose(a, b)).toBe(false);
    expect(isSamePose(a, person(0.452) as never)).toBe(true);
  });
});
