import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioEngine } from '../engine/AudioEngine';

describe('AudioEngine', () => {
  let engine: AudioEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new AudioEngine();
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('starts with default BPM of 120', () => {
    expect(engine.bpm).toBe(120);
  });

  it('clamps BPM to [20, 300]', () => {
    engine.bpm = 5;
    expect(engine.bpm).toBe(20);

    engine.bpm = 999;
    expect(engine.bpm).toBe(300);
  });

  it('is not playing by default', () => {
    expect(engine.isPlaying).toBe(false);
  });

  it('reports isPlaying=true after start()', () => {
    engine.start();
    expect(engine.isPlaying).toBe(true);
  });

  it('reports isPlaying=false after stop()', () => {
    engine.start();
    engine.stop();
    expect(engine.isPlaying).toBe(false);
  });

  it('does not throw when started twice', () => {
    expect(() => {
      engine.start();
      engine.start();
    }).not.toThrow();
  });

  it('does not throw when stopped without starting', () => {
    expect(() => engine.stop()).not.toThrow();
  });

  it('fires onBeat callback', async () => {
    const callback = vi.fn();
    engine.onBeat(callback);
    engine.start();

    // Interval fires at 25ms → schedules beat, then setTimeout fires at ~75ms total.
    // Advance 100ms to cover both; avoid runAllTimersAsync (infinite setInterval loop).
    await vi.advanceTimersByTimeAsync(100);

    expect(callback).toHaveBeenCalled();
    const firstCall = callback.mock.calls[0][0];
    expect(firstCall).toHaveProperty('beat');
    expect(firstCall).toHaveProperty('time');
  });

  it('unsubscribes onBeat callback', async () => {
    const callback = vi.fn();
    const unsubscribe = engine.onBeat(callback);
    unsubscribe();
    engine.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).not.toHaveBeenCalled();
  });

  it('accepts a custom AudioBuffer via loadBuffer', async () => {
    const fakeArrayBuffer = new ArrayBuffer(8);
    // Should resolve without throwing (mock decodeAudioData returns {})
    await expect(engine.loadBuffer(fakeArrayBuffer)).resolves.toBeUndefined();
  });
});
