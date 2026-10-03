import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SheetRow } from '../engine/choreoSheet';
import {
  accentOf, BeatScheduler, beatsInRange, buildTimeline, countAtTime, cueAt, gridFromResultJson, isSpokenCount,
  loopStep, prerollStart, rangeOf, segIndexAt, VirtualClock, type Accent, type Timeline,
} from '../engine/practice';

const B = 0.4; // 1 拍 0.4 秒（150 BPM）、8 カウント = 3.2 秒

function row(index: number, start: number | null, end: number | null, name = `技${index + 1}`): SheetRow {
  return {
    index, no: index + 1, start, end, time: '', counts: '1-8', name, steps: [],
    hold: null, turn: null, pass: null, uncertain: false, diagram: null,
  };
}

/** 10 秒から 8 カウントごとに 4 技（#3 は時刻なし）。#4 の頭は格子から 0.05 秒ずれている */
function tl(): Timeline {
  const rows = [
    row(0, 10, 13.2, 'ベーシック'),
    row(1, 13.2, 16.4, 'CBL＋インサイド'),
    row(2, null, null),
    row(3, 16.45, null, 'ヘアコーム'),
  ];
  return buildTimeline(rows, B, { timing: 'on2' })!;
}

describe('練習のカウント計算', () => {
  it('技の頭をカウント 1 として、メディア時刻から 1〜8 を出す（速度に依らない）', () => {
    const t = tl();
    expect(t.segs.map(s => s.index)).toEqual([0, 1, 3]);
    expect(t.segs[2].end).toBeCloseTo(16.45 + 8 * B);
    expect(countAtTime(t, 10)).toBe(1);
    expect(countAtTime(t, 10.39)).toBe(1);
    expect(countAtTime(t, 10.4)).toBe(2);
    expect(countAtTime(t, 12.81)).toBe(8);
    expect(countAtTime(t, 13.2)).toBe(1); // 次の技の頭で数え直す
    expect(countAtTime(t, 13.2 + 5 * B)).toBe(6);
    // 頭が格子からずれた技も、その技の頭から数える（ずれが溜まらない）
    expect(countAtTime(t, 16.45)).toBe(1);
    expect(countAtTime(t, 16.45 + B)).toBe(2);
    // 最初の技の前はカウントイン（5, 6, 7, 8）
    expect(countAtTime(t, 10 - B)).toBe(8);
    expect(countAtTime(t, 10 - 4 * B)).toBe(5);
    // 最後の技の後もそのまま数える
    expect(countAtTime(t, 16.45 + 9 * B)).toBe(2);
  });

  it('On2 は 2 と 6 を強く、1 は中くらい、4 と 8 はごく小さく。声は 4 と 8 を数えない', () => {
    const on2 = [1, 2, 3, 4, 5, 6, 7, 8].map(c => accentOf(c, 'on2'));
    expect(on2).toEqual(['head', 'strong', 'weak', 'ghost', 'weak', 'strong', 'weak', 'ghost']);
    expect(accentOf(1, 'on1')).toBe('strong');
    expect(accentOf(5, 'on1')).toBe('strong');
    expect(accentOf(2, 'on1')).toBe('weak');
    expect([1, 2, 3, 4, 5, 6, 7, 8].filter(isSpokenCount)).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it('beatsInRange: 拍を重複なく並べ、頭のずれた技の手前では半拍以内の拍を出さない', () => {
    const t = tl();
    const beats = beatsInRange(t, 10 - 4 * B, 16.45 + 2 * B);
    // カウントイン 4 + 8 + 8 + 2
    expect(beats.map(b => b.count)).toEqual([5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2]);
    const ts = beats.map(b => b.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThan(B / 2);
    expect(ts[ts.length - 2]).toBeCloseTo(16.45);
    // [from, to) の半開区間
    expect(beatsInRange(t, 10, 10.4).map(b => b.t)).toEqual([10]);
    expect(beatsInRange(t, 10.01, 10.4)).toEqual([]);
    expect(beatsInRange(t, 5, 5)).toEqual([]);
  });

  it('routine.grid から拍と位相、timing を読む（無ければ On2）', () => {
    const g = gridFromResultJson(JSON.stringify({ routine: { timing: 'on2', grid: { beatSec: 0.3125, phaseSec: 1.2, unitSec: 2.5 } } }));
    expect(g).toEqual({ beatSec: 0.3125, phaseSec: 1.2, timing: 'on2' });
    expect(gridFromResultJson(JSON.stringify({ routine: { timing: 'on1' } }))).toEqual({ beatSec: null, phaseSec: null, timing: 'on1' });
    expect(gridFromResultJson('broken').timing).toBe('on2');
    // 拍が分からなければ技の頭の間隔から
    const t = buildTimeline([row(0, 0, null), row(1, 2.8, null), row(2, 5.6, null)], null)!;
    expect(t.beatSec).toBeCloseTo(0.35);
    expect(buildTimeline([row(0, null, null)], B)).toBeNull();
  });
});

describe('範囲ループ', () => {
  it('2 枚のカードから区間を作る（順番は問わない・時刻の無い行は飛ばす）', () => {
    const t = tl();
    const r = rangeOf(t, 3, 1)!;
    expect(r).toEqual({ start: 13.2, end: 16.45 + 8 * B, first: 1, last: 2 });
    expect(rangeOf(t, 2, 2)).toBeNull();
    expect(rangeOf(t, 0, 0)).toEqual({ start: 10, end: 13.2, first: 0, last: 0 });
  });

  it('終わりに着いたらループなら頭へ、しないなら止める。カウントインは 4 拍（動画は 0 秒より前に戻れない）', () => {
    const t = tl();
    const r = rangeOf(t, 1, 3)!;
    expect(loopStep(15, r, true, B)).toEqual({ seekTo: null, done: false });
    expect(loopStep(r.end - 0.01, r, true, B)).toEqual({ seekTo: 13.2, done: false });
    expect(loopStep(r.end, r, false, B)).toEqual({ seekTo: null, done: true });
    // カウントイン中はそのまま、大きく外れたら頭へ
    expect(prerollStart(t, r, false)).toBeCloseTo(13.2 - 4 * B);
    expect(loopStep(13.2 - 4 * B, r, true, B).seekTo).toBeNull();
    expect(loopStep(2, r, true, B).seekTo).toBe(13.2);
    const r0 = { start: 0.5, end: 3.7, first: 0, last: 0 };
    expect(prerollStart(t, r0, false)).toBe(0);
    expect(prerollStart(t, r0, true)).toBeCloseTo(0.5 - 4 * B);
  });

  it('今の技と次の技。次の技は 1 拍前から目立たせ、ループの最後では頭の技を出す', () => {
    const t = tl();
    const all = rangeOf(t, 0, 3)!;
    expect(segIndexAt(t, 11)).toBe(0);
    expect(cueAt(t, 11, all, false)).toEqual({ current: 0, next: 1, soon: false });
    expect(cueAt(t, 13.2 - B, all, false)).toEqual({ current: 0, next: 1, soon: true });
    expect(cueAt(t, 13.3, all, false)).toEqual({ current: 1, next: 2, soon: false });
    // カウントイン中は最初の技が「次」
    expect(cueAt(t, 9, all, false)).toEqual({ current: -1, next: 0, soon: false });
    // 通しの最後は「次」なし、ループなら頭
    expect(cueAt(t, all.end - 0.1, all, false).next).toBe(-1);
    expect(cueAt(t, all.end - 0.1, all, true)).toEqual({ current: 2, next: 0, soon: true });
    // 1 技のループは「次」を出さない
    const one = rangeOf(t, 1, 1)!;
    expect(cueAt(t, 14, one, true).next).toBe(-1);
  });
});

describe('動画なしの時計', () => {
  it('速度を掛けてメディア時刻を進め、止める・シーク・速度変更で位置を保つ', () => {
    let now = 100;
    const c = new VirtualClock(() => now);
    c.seek(10);
    expect(c.time()).toBe(10);
    c.setRate(0.5);
    c.play();
    now += 2;
    expect(c.time()).toBeCloseTo(11);
    c.setRate(1);
    now += 1;
    expect(c.time()).toBeCloseTo(12);
    c.pause();
    now += 5;
    expect(c.time()).toBeCloseTo(12);
    c.play();
    now += 0.75;
    expect(c.time()).toBeCloseTo(12.75);
    c.seek(3);
    now += 1;
    expect(c.time()).toBeCloseTo(4);
  });
});

describe('通し練習の音の予定（BeatScheduler）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** 音の時計 = 偽のタイマーの経過時間。メディア時刻 = 開始時刻 + 経過 × 速度 */
  function setup(opts: { rate: number; start: number; end?: number | null; clicks?: boolean; voice?: boolean }) {
    const t0 = Date.now();
    const audioNow = () => (Date.now() - t0) / 1000;
    let rate = opts.rate;
    let base = opts.start;
    let since = 0;
    let playing = true;
    const media = () => base + (audioNow() - since) * rate;
    const clicks: { at: number; accent: Accent; count: number }[] = [];
    const spoken: { count: number; at: number }[] = [];
    const sched = new BeatScheduler({
      timeline: tl(),
      clock: { mediaTime: () => (playing ? media() : null), rate: () => rate, end: () => opts.end ?? null },
      sink: {
        now: audioNow,
        click: (at, accent, count) => clicks.push({ at, accent, count }),
        speak: (count, at) => spoken.push({ count, at }),
      },
      clicks: () => opts.clicks ?? true,
      voice: () => opts.voice ?? false,
    });
    return {
      sched, clicks, spoken, audioNow,
      seek: (t: number) => { base = t; since = audioNow(); },
      setRate: (r: number) => { base = media(); since = audioNow(); rate = r; },
      pause: () => { base = media(); playing = false; },
      resume: () => { since = audioNow(); playing = true; },
    };
  }

  it('0.5 倍では拍の間隔が 2 倍に伸び、カウントイン 5〜8 から 1 拍ずつ 1 回だけ鳴らす', async () => {
    const s = setup({ rate: 0.5, start: 10 - 4 * B });
    s.sched.start();
    await vi.advanceTimersByTimeAsync(8 * B * 2 * 1000 + 50); // 8 拍分（壁時計で 6.4 秒）
    s.sched.stop();
    expect(s.clicks.map(c => c.count)).toEqual([5, 6, 7, 8, 1, 2, 3, 4, 5]);
    s.clicks.forEach((c, i) => expect(c.at).toBeCloseTo(i * B * 2, 2));
    expect(s.clicks.find(c => c.count === 2)!.accent).toBe('strong');
    expect(s.clicks.find(c => c.count === 6)!.accent).toBe('strong');
    expect(s.clicks.find(c => c.count === 3)!.accent).toBe('weak');
  });

  it('途中で速度を変えても拍が抜けたり重なったりしない', async () => {
    const s = setup({ rate: 1, start: 10 });
    s.sched.start();
    await vi.advanceTimersByTimeAsync(1000); // 10 → 11 秒（拍 10, 10.4, 10.8）
    s.setRate(0.75);
    await vi.advanceTimersByTimeAsync(1000); // 11 → 11.75（拍 11.2, 11.6）
    s.sched.stop();
    expect(s.clicks.map(c => c.count)).toEqual([1, 2, 3, 4, 5]);
    expect(s.clicks[3].at).toBeCloseTo(1 + 0.2 / 0.75, 2);
  });

  it('シーク（ループで頭へ戻る）をしたら、その拍から鳴らし直す。区間の終わりより先は鳴らさない', async () => {
    const r = rangeOf(tl(), 0, 0)!; // 10〜13.2
    const s = setup({ rate: 1, start: 12, end: r.end });
    s.sched.start();
    await vi.advanceTimersByTimeAsync(1150); // 12 → 13.15: 12, 12.4, 12.8（13.2 は区間の外）
    expect(s.clicks.map(c => c.count)).toEqual([6, 7, 8]);
    s.seek(r.start);
    await vi.advanceTimersByTimeAsync(500); // 10, 10.4
    s.sched.stop();
    expect(s.clicks.map(c => c.count)).toEqual([6, 7, 8, 1, 2]);
    expect(s.clicks[3].at).toBeCloseTo(1.15, 1);
  });

  it('止まっている間は鳴らさず、再開したら続きから。クリック OFF・声 ON なら 1,2,3,5,6,7 だけ喋る', async () => {
    const s = setup({ rate: 1, start: 10, clicks: false, voice: true });
    s.sched.start();
    await vi.advanceTimersByTimeAsync(1000);
    s.pause();
    await vi.advanceTimersByTimeAsync(3000);
    const before = s.spoken.length;
    s.resume();
    await vi.advanceTimersByTimeAsync(2700);
    s.sched.stop();
    expect(s.clicks).toEqual([]);
    expect(before).toBe(3);
    expect(s.spoken.map(x => x.count)).toEqual([1, 2, 3, 5, 6, 7, 1, 2]);
  });
});
