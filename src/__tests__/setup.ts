import '@testing-library/jest-dom';

// Minimal Web Audio API mock
class MockAudioContext {
  currentTime = 0;
  state = 'running' as AudioContextState;
  destination = {} as AudioDestinationNode;

  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }

  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }

  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn() };
  }

  createBiquadFilter() {
    return {
      type: 'bandpass',
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: vi.fn(),
    };
  }

  decodeAudioData(_: ArrayBuffer) {
    return Promise.resolve({} as AudioBuffer);
  }

  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

Object.defineProperty(window, 'AudioContext', {
  writable: true,
  value: MockAudioContext,
});
