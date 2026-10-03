import { describe, it, expect } from 'vitest';
import { makeYouTubeClock, buildTabShareExport, tabShareFileName, type YtPlayerLike } from '../engine/tabShare';
import { canEmitAfterCooldown, resolveAnalysisTime, isTimeCacheable } from '../hooks/usePoseEstimation';

function fakePlayer(init: { t: number; rate?: number; state?: number }) {
  const s = { rate: 1, state: 1, ...init };
  const p: YtPlayerLike = {
    getCurrentTime: () => s.t,
    getPlaybackRate: () => s.rate,
    getPlayerState: () => s.state,
  };
  return { s, p };
}

describe('makeYouTubeClock', () => {
  it('プレイヤーが無ければ NaN', () => {
    expect(makeYouTubeClock(() => null, () => 0)()).toBeNaN();
  });

  it('値が更新されない間は再生速度ぶん補間する（0.25x）', () => {
    const { p } = fakePlayer({ t: 10, rate: 0.25 });
    let now = 1000;
    const clock = makeYouTubeClock(() => p, () => now);
    expect(clock()).toBe(10);
    now += 400; // 0.4 秒 × 0.25 = 0.1 秒進む
    expect(clock()).toBeCloseTo(10.1, 6);
  });

  it('補間は 1 秒で頭打ち', () => {
    const { p } = fakePlayer({ t: 5 });
    let now = 0;
    const clock = makeYouTubeClock(() => p, () => now);
    clock();
    now += 10_000;
    expect(clock()).toBeCloseTo(6, 6);
  });

  it('一時停止中は補間しない', () => {
    const { p } = fakePlayer({ t: 5, state: 2 });
    let now = 0;
    const clock = makeYouTubeClock(() => p, () => now);
    clock();
    now += 500;
    expect(clock()).toBe(5);
  });

  it('ループで時刻が戻ったら生の値を返す', () => {
    const { s, p } = fakePlayer({ t: 20 });
    let now = 0;
    const clock = makeYouTubeClock(() => p, () => now);
    clock();
    now += 300;
    s.t = 12;
    expect(clock()).toBe(12);
  });
});

describe('buildTabShareExport', () => {
  it('YouTube 秒で時刻順に並べ、beatNum が無いイベントには付けない', () => {
    const out = buildTabShareExport({
      videoId: 'abcdefghijk',
      title: 'Salsa',
      playbackRate: 0.25,
      createdAt: new Date('2026-10-03T01:02:03.456Z'),
      events: [
        { id: 2, time: 12.34567, action: 'Turn', quality: 0.81234, beatNum: 3 },
        { id: 1, time: 4.5, action: 'CBL', quality: 1 },
      ],
    });
    expect(out).toEqual({
      videoId: 'abcdefghijk',
      title: 'Salsa',
      playbackRate: 0.25,
      createdAt: '2026-10-03T01:02:03.456Z',
      events: [
        { t: 4.5, action: 'CBL', quality: 1 },
        { t: 12.346, action: 'Turn', quality: 0.812, beatNum: 3 },
      ],
    });
  });

  it('title が無ければキーを出さない', () => {
    const out = buildTabShareExport({ videoId: 'x', playbackRate: 1, createdAt: new Date(0), events: [] });
    expect('title' in out).toBe(false);
  });

  it('ファイル名', () => {
    expect(tabShareFileName('abc', new Date('2026-10-03T01:02:03.456Z')))
      .toBe('tabshare_abc_2026-10-03T01-02-03-456Z.json');
  });
});

describe('usePoseEstimation の時刻源ヘルパー', () => {
  it('getTime が無ければ video.currentTime', () => {
    expect(resolveAnalysisTime({ currentTime: 7 })).toBe(7);
  });

  it('getTime があればそちら、非有限値・例外ならフォールバック', () => {
    expect(resolveAnalysisTime({ currentTime: 7 }, () => 42)).toBe(42);
    expect(resolveAnalysisTime({ currentTime: 7 }, () => NaN)).toBe(7);
    expect(resolveAnalysisTime({ currentTime: 7 }, () => { throw new Error('x'); })).toBe(7);
  });

  it('ライブ映像（srcObject）や外部時刻源では時刻キャッシュを使わない', () => {
    expect(isTimeCacheable({ srcObject: null }, {})).toBe(true);
    expect(isTimeCacheable({}, {})).toBe(true);
    expect(isTimeCacheable({ srcObject: {} }, {})).toBe(false);
    expect(isTimeCacheable({ srcObject: null }, { getTime: () => 0 })).toBe(false);
    expect(isTimeCacheable({ srcObject: null }, { disableTimeCache: true })).toBe(false);
  });

  it('クールダウン: 既定は時刻が戻っても再検出しない（従来どおり）', () => {
    expect(canEmitAfterCooldown(10, 9)).toBe(false);
    expect(canEmitAfterCooldown(10.5, 9)).toBe(true);
    expect(canEmitAfterCooldown(3, 9)).toBe(false);
  });

  it('クールダウン: allowRewind ならループで戻ったとき再検出できる', () => {
    expect(canEmitAfterCooldown(3, 9, true)).toBe(true);
    expect(canEmitAfterCooldown(10, 9, true)).toBe(false);
  });
});
