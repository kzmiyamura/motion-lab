/**
 * AudioEngine.ts
 *
 * Singleton audio engine that runs the scheduler loop independent of React's
 * render cycle. Uses a look-ahead scheduler (~100ms) to achieve 1-sample
 * precision timing.
 *
 * Architecture:
 *   JS thread  → scheduling, UI state
 *   C++ thread → AudioContext worklet (real-time audio)
 */

export type Beat = {
  beat: number;       // 0-indexed beat number within the bar
  time: number;       // audioContext.currentTime of the beat
};

export type BeatCallback = (beat: Beat) => void;

const SCHEDULE_AHEAD_TIME = 0.1; // seconds to schedule ahead
const LOOKAHEAD_MS = 25;          // scheduler interval in ms

export class AudioEngine {
  private context: AudioContext | null = null;
  private nextBeatTime = 0;
  private currentBeat = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private beatCallbacks: Set<BeatCallback> = new Set();
  private _bpm = 120;
  private _beatsPerBar = 4;
  /** 1ステップ = 1拍音符の何分の1か。16ステップ(8分音符)なら 2 */
  private _subdivision = 1;
  private _isPlaying = false;
  private customBuffer: AudioBuffer | null = null;
  /** 音を鳴らす 0-indexed ステップ番号。null = 全ステップ再生 */
  private activeSteps: Set<number> | null = null;

  // ── Public API ────────────────────────────────────────────────────────────

  get bpm() { return this._bpm; }
  set bpm(value: number) { this._bpm = Math.max(20, Math.min(300, value)); }

  get beatsPerBar() { return this._beatsPerBar; }
  set beatsPerBar(value: number) { this._beatsPerBar = Math.max(1, Math.min(32, value)); }

  /** 1ステップが何分音符かを設定 (1=4分, 2=8分, 4=16分) */
  get subdivision() { return this._subdivision; }
  set subdivision(value: number) { this._subdivision = Math.max(1, value); }

  get isPlaying() { return this._isPlaying; }

  /** Registers a callback to be fired on each scheduled beat. */
  onBeat(cb: BeatCallback) {
    this.beatCallbacks.add(cb);
    return () => this.beatCallbacks.delete(cb);
  }

  /** どのステップで音を鳴らすかを設定する。null を渡すと全ステップ再生。 */
  setActiveSteps(steps: Set<number> | null) {
    this.activeSteps = steps;
  }

  /** Load a WAV/audio file as the click sound. Falls back to SynthClave. */
  async loadBuffer(arrayBuffer: ArrayBuffer) {
    const ctx = this.getContext();
    this.customBuffer = await ctx.decodeAudioData(arrayBuffer);
  }

  start() {
    if (this._isPlaying) return;
    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume();
    this._isPlaying = true;
    this.currentBeat = 0;
    this.nextBeatTime = ctx.currentTime + 0.05; // tiny initial delay
    this.schedulerTimer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
  }

  stop() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  dispose() {
    this.stop();
    if (this.context) {
      this.context.close();
      this.context = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
    }
    return this.context;
  }

  /** Core look-ahead scheduler: called every LOOKAHEAD_MS milliseconds. */
  private schedule() {
    const ctx = this.getContext();
    const horizon = ctx.currentTime + SCHEDULE_AHEAD_TIME;

    while (this.nextBeatTime < horizon) {
      this.scheduleBeat(this.nextBeatTime, this.currentBeat);
      this.advanceBeat();
    }
  }

  private scheduleBeat(time: number, beat: number) {
    const ctx = this.getContext();
    const shouldPlay = this.activeSteps === null || this.activeSteps.has(beat);

    if (shouldPlay) {
      if (this.customBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = this.customBuffer;
        src.connect(ctx.destination);
        src.start(time);
      } else {
        this.playSynthClave(ctx, time, beat === 0);
      }
    }

    // Notify callbacks (fire from JS thread at the scheduled wall-clock time)
    const delay = (time - ctx.currentTime) * 1000;
    setTimeout(() => {
      this.beatCallbacks.forEach(cb => cb({ beat, time }));
    }, Math.max(0, delay));
  }

  /**
   * SynthClave — an oscillator-based percussive click.
   * Accent (beat 0) uses a slightly lower frequency.
   */
  private playSynthClave(ctx: AudioContext, time: number, accent: boolean) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(accent ? 880 : 1200, time);
    osc.frequency.exponentialRampToValueAtTime(accent ? 440 : 600, time + 0.03);

    gain.gain.setValueAtTime(accent ? 0.6 : 0.35, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  private advanceBeat() {
    const secondsPerStep = (60 / this._bpm) / this._subdivision;
    this.nextBeatTime += secondsPerStep;
    this.currentBeat = (this.currentBeat + 1) % this._beatsPerBar;
  }
}

// Singleton instance — shared across the app via the useAudioEngine hook.
export const audioEngine = new AudioEngine();
