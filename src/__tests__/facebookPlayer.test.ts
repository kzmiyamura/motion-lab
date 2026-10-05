import { describe, it, expect } from 'vitest';
import {
  isFacebookUrl, normalizeFacebookUrl, extractFacebookVideoId, makeFacebookClock,
} from '../engine/facebookPlayer';

describe('facebook URL', () => {
  it('Facebook / fb.watch を判定する', () => {
    expect(isFacebookUrl('https://www.facebook.com/watch?v=123456789')).toBe(true);
    expect(isFacebookUrl('m.facebook.com/watch/?v=1')).toBe(true);
    expect(isFacebookUrl('https://fb.watch/abcDEF/')).toBe(true);
    expect(isFacebookUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isFacebookUrl('https://notfacebook.com/videos/1')).toBe(false);
    expect(isFacebookUrl('')).toBe(false);
  });

  it('watch?v= を正規化する', () => {
    expect(normalizeFacebookUrl('https://m.facebook.com/watch?v=123456789&t=5'))
      .toBe('https://www.facebook.com/watch/?v=123456789');
    expect(normalizeFacebookUrl('facebook.com/watch/?v=123456789'))
      .toBe('https://www.facebook.com/watch/?v=123456789');
  });

  it('/reel/ と /videos/ と fb.watch', () => {
    expect(normalizeFacebookUrl('https://www.facebook.com/reel/987654321?s=x'))
      .toBe('https://www.facebook.com/reel/987654321');
    expect(normalizeFacebookUrl('https://web.facebook.com/someone/videos/555555555/'))
      .toBe('https://www.facebook.com/someone/videos/555555555/');
    expect(normalizeFacebookUrl('https://fb.watch/abc/?mibextid=1')).toBe('https://fb.watch/abc/');
  });

  it('不明な形はそのまま渡す', () => {
    expect(normalizeFacebookUrl('  https://www.facebook.com/groups/x/posts/1  '))
      .toBe('https://www.facebook.com/groups/x/posts/1');
    expect(normalizeFacebookUrl('なにか')).toBe('なにか');
  });

  it('動画 ID を取り出す', () => {
    expect(extractFacebookVideoId('https://www.facebook.com/watch?v=123456789')).toBe('123456789');
    expect(extractFacebookVideoId('https://www.facebook.com/page/videos/555555555/')).toBe('555555555');
    expect(extractFacebookVideoId('https://www.facebook.com/reel/987654321')).toBe('987654321');
    expect(extractFacebookVideoId('https://fb.watch/abc/')).toBeNull();
  });
});

describe('makeFacebookClock', () => {
  it('値が止まっている間は再生中のみ補間し、上限は1秒', () => {
    let pos = 10;
    let t = 0;
    let playing = true;
    const clock = makeFacebookClock(() => ({ getCurrentPosition: () => pos }), () => playing, () => t);
    expect(clock()).toBe(10);
    t = 400;
    expect(clock()).toBeCloseTo(10.4);
    t = 5000;
    expect(clock()).toBeCloseTo(11);
    playing = false;
    expect(clock()).toBe(10);
    pos = 3;
    expect(clock()).toBe(3);
  });

  it('プレイヤーが無い・値が不正なら NaN', () => {
    expect(makeFacebookClock(() => null, () => true)()).toBeNaN();
    expect(makeFacebookClock(() => ({ getCurrentPosition: () => NaN }), () => true)()).toBeNaN();
  });
});
