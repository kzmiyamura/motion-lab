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
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
      connect: vi.fn(),
    };
  }

  createBufferSource() {
    return {
      buffer: null as AudioBuffer | null,
      loop: false,
      playbackRate: { value: 1 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createBiquadFilter() {
    return {
      type: 'bandpass',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0 },
      connect: vi.fn(),
    };
  }

  createDynamicsCompressor() {
    return {
      threshold: { value: 0 },
      knee:      { value: 0 },
      ratio:     { value: 1 },
      attack:    { value: 0 },
      release:   { value: 0.25 },
      connect: vi.fn(),
    };
  }

  createConvolver() {
    return { buffer: null as AudioBuffer | null, connect: vi.fn() };
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (_: number) => new Float32Array(length),
    } as unknown as AudioBuffer;
  }

  decodeAudioData(_: ArrayBuffer) {
    return Promise.resolve({} as AudioBuffer);
  }

  addEventListener(_: string, __: EventListenerOrEventListenerObject) {}
  removeEventListener(_: string, __: EventListenerOrEventListenerObject) {}
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

Object.defineProperty(window, 'AudioContext', {
  writable: true,
  value: MockAudioContext,
});
