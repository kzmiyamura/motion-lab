/**
 * AudioEngine.ts — Multi-track rhythm machine
 *
 * Singleton audio engine with look-ahead scheduler (~100ms) for
 * 1-sample precision timing. Supports 3 synthesized instrument tracks.
 *
 * Fixed: 16 steps per bar, subdivision=2 (8th notes at BPM quarter-note rate)
 */

export type TrackId = 'clave' | 'conga' | 'cowbell';

export type Track = {
  id: TrackId;
  pattern: Set<number>;
  muted: boolean;
};

export type Beat = {
  beat: number;   // 0-indexed step within the 16-step bar
  time: number;   // audioContext.currentTime of the step
};

export type BeatCallback = (beat: Beat) => void;

const SCHEDULE_AHEAD_TIME = 0.1; // seconds to schedule ahead
const LOOKAHEAD_MS = 25;          // scheduler interval in ms
const BEATS_PER_BAR = 16;
const SUBDIVISION = 2;            // 8th notes (2 per quarter note)

/** Default Son Clave 2-3 pattern: beat positions [2,3,5,6.5,8] → 16-step indices */
const DEFAULT_CLAVE_STEPS = new Set([2, 4, 8, 11, 14]);
/** Conga Tumbao: beats 4 and 8 (quarter notes) → 8th-note steps 6,14 */
const DEFAULT_CONGA_STEPS = new Set([6, 14]);
/** Cowbell: beats 1,3,5,7 (quarter notes) → 8th-note steps 0,4,8,12 */
const DEFAULT_COWBELL_STEPS = new Set([0, 4, 8, 12]);

export class AudioEngine {
  private context: AudioContext | null = null;
  private nextBeatTime = 0;
  private currentBeat = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private beatCallbacks: Set<BeatCallback> = new Set();
  private _bpm = 120;
  private _isPlaying = false;
  private customBuffer: AudioBuffer | null = null;

  private tracks: Map<TrackId, Track> = new Map([
    ['clave',   { id: 'clave',   pattern: new Set(DEFAULT_CLAVE_STEPS),   muted: false }],
    ['conga',   { id: 'conga',   pattern: new Set(DEFAULT_CONGA_STEPS),   muted: false }],
    ['cowbell', { id: 'cowbell', pattern: new Set(DEFAULT_COWBELL_STEPS), muted: false }],
  ]);

  // ── Public API ────────────────────────────────────────────────────────────

  get bpm() { return this._bpm; }
  set bpm(value: number) { this._bpm = Math.max(20, Math.min(300, value)); }

  get isPlaying() { return this._isPlaying; }

  /** Registers a callback fired on each scheduled step. */
  onBeat(cb: BeatCallback) {
    this.beatCallbacks.add(cb);
    return () => this.beatCallbacks.delete(cb);
  }

  getTrack(id: TrackId): Track {
    return this.tracks.get(id)!;
  }

  setTrackPattern(id: TrackId, steps: Set<number>) {
    this.tracks.get(id)!.pattern = steps;
  }

  setTrackMuted(id: TrackId, muted: boolean) {
    this.tracks.get(id)!.muted = muted;
  }

  toggleTrackMute(id: TrackId) {
    const track = this.tracks.get(id)!;
    track.muted = !track.muted;
    return track.muted;
  }

  /** Load a WAV/audio file as the Clave sound. Falls back to synth. */
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
    this.nextBeatTime = ctx.currentTime + 0.05;
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

  private schedule() {
    const ctx = this.getContext();
    const horizon = ctx.currentTime + SCHEDULE_AHEAD_TIME;

    while (this.nextBeatTime < horizon) {
      this.scheduleBeat(ctx, this.nextBeatTime, this.currentBeat);
      this.advanceBeat();
    }
  }

  private scheduleBeat(ctx: AudioContext, time: number, beat: number) {
    // Play each non-muted track if current step is in its pattern
    for (const track of this.tracks.values()) {
      if (!track.muted && track.pattern.has(beat)) {
        this.playTrack(ctx, track.id, time);
      }
    }

    // Notify UI callbacks with appropriate delay
    const delay = (time - ctx.currentTime) * 1000;
    setTimeout(() => {
      this.beatCallbacks.forEach(cb => cb({ beat, time }));
    }, Math.max(0, delay));
  }

  private playTrack(ctx: AudioContext, id: TrackId, time: number) {
    switch (id) {
      case 'clave':   return this.playClave(ctx, time);
      case 'conga':   return this.playConga(ctx, time);
      case 'cowbell': return this.playCowbell(ctx, time);
    }
  }

  /**
   * Clave — high percussive click (wood sticks).
   * Uses custom buffer if loaded, otherwise synthesized.
   */
  private playClave(ctx: AudioContext, time: number) {
    if (this.customBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.customBuffer;
      src.connect(ctx.destination);
      src.start(time);
      return;
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200, time);
    osc.frequency.exponentialRampToValueAtTime(600, time + 0.03);

    gain.gain.setValueAtTime(0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  /**
   * Conga Tumbao — low drum thud.
   * Sine oscillator pitched down with a pitch envelope.
   */
  private playConga(ctx: AudioContext, time: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, time);
    osc.frequency.exponentialRampToValueAtTime(60, time + 0.12);

    gain.gain.setValueAtTime(0.7, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  /**
   * Cowbell — metallic clang.
   * Two detuned square oscillators through a bandpass filter.
   */
  private playCowbell(ctx: AudioContext, time: number) {
    const freqs = [562, 845]; // classic cowbell frequencies
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    filter.type = 'bandpass';
    filter.frequency.value = 700;
    filter.Q.value = 2;

    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

    for (const freq of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, time);
      osc.connect(filter);
      osc.start(time);
      osc.stop(time + 0.35);
    }

    filter.connect(gain);
    gain.connect(ctx.destination);
  }

  private advanceBeat() {
    const secondsPerStep = (60 / this._bpm) / SUBDIVISION;
    this.nextBeatTime += secondsPerStep;
    this.currentBeat = (this.currentBeat + 1) % BEATS_PER_BAR;
  }
}

// Singleton instance — shared across the app via the useAudioEngine hook.
export const audioEngine = new AudioEngine();
