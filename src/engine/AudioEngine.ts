/**
 * AudioEngine.ts — Multi-track rhythm machine
 *
 * Uses real percussion samples from VSCO Community Edition (CC0 1.0):
 *   https://github.com/sgossner/VSCO-2-CE
 *
 * Features:
 *   - Real WAV samples for Clave, Conga (Tumba), and Cowbell
 *   - Synthetic fallback sounds while samples are loading
 *   - ConvolverNode reverb with a programmatically generated room IR
 *   - Humanization: ±12% gain, ±3% pitch, ±3ms timing per hit
 *   - Round-robin sample playback to avoid the "machine gun" effect
 *
 * Timing: look-ahead scheduler (~100ms) with AudioContext.currentTime
 * Fixed: 16 steps per bar, subdivision=2 (8th notes)
 */

export type TrackId = 'clave' | 'conga-open' | 'conga-slap' | 'conga-heel' | 'cowbell-low' | 'cowbell-high';

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

const SCHEDULE_AHEAD_TIME = 0.1;
const LOOKAHEAD_MS = 25;
const BEATS_PER_BAR = 16;
const SUBDIVISION = 2; // 8th notes

// VSCO-2-CE CC0 1.0 Universal — https://github.com/sgossner/VSCO-2-CE
const VSCO = 'https://raw.githubusercontent.com/sgossner/VSCO-2-CE/master/Percussion';
const SAMPLE_URLS: Record<TrackId, string[]> = {
  clave: [
    `${VSCO}/Claves1_Hit_v2_rr1_Sum.wav`,
    `${VSCO}/Claves1_Hit_v2_rr2_Sum.wav`,
  ],
  // Conga Open: full resonant open tone (v2 = louder velocity)
  'conga-open': [
    `${VSCO}/Tumba-HitN_v2_rr1_Sum.wav`,
    `${VSCO}/Tumba-HitN_v2_rr2_Sum.wav`,
  ],
  // Conga Slap: Tumba-Slap does not exist in VSCO-2-CE — always use synth
  'conga-slap': [],
  // Conga Heel/Toe: always use synth — v1 sample sounds like a small open hit,
  // not the muffled "gosogoso" character we need.
  'conga-heel': [],
  // Cowbell Low (open): v2 = fuller resonant tone
  'cowbell-low': [
    `${VSCO}/Cowbell1_Hit_v2_rr1_Sum.wav`,
    `${VSCO}/Cowbell1_Hit_v2_rr2_Sum.wav`,
  ],
  // Cowbell High (muted): v1 = shorter, brighter attack
  'cowbell-high': [
    `${VSCO}/Cowbell1_Hit_v1_rr1_Sum.wav`,
    `${VSCO}/Cowbell1_Hit_v1_rr2_Sum.wav`,
  ],
};

// Reverb wet level per instrument (clave is traditionally dry)
const REVERB_WET: Record<TrackId, number> = {
  clave:         0.08,
  'conga-open':  0.22,
  'conga-slap':  0.12,
  'conga-heel':  0.06,
  'cowbell-low':  0.18,
  'cowbell-high': 0.10,
};

// Base gain per instrument — adjust to balance perceived loudness
const TRACK_GAIN: Record<TrackId, number> = {
  clave:         0.85,
  'conga-open':  1.40,  // dominant hit
  'conga-slap':  0.30,  // medium accent
  'conga-heel':  0.70,  // synth-only; lowpass noise "gosogoso"
  'cowbell-low':  0.28,
  'cowbell-high': 0.40,
};

// Default patterns (16 steps = 2 bars of 4/4 at 8th-note subdivision)
// Grid: 0=beat1, 2=beat2, 4=beat3, 6=beat4 per bar (× 2 bars)
const DEFAULT_CLAVE_STEPS        = new Set([2, 4, 8, 11, 14]);
// Tumbao conga — classic salsa 2-bar pattern:
//   Heel/Toe: ghost notes on beat 1 & "and of 2" each bar → [0,3,8,11]
//   Slap:     sharp accent on beat 2 each bar             → [2,10]
//   Open:     "pomm-pom" — and-of-3 + beat 4 each bar    → [5,6,13,14]
const DEFAULT_CONGA_HEEL_STEPS   = new Set([0, 3, 8, 11]);
const DEFAULT_CONGA_SLAP_STEPS   = new Set([2, 10]);
const DEFAULT_CONGA_OPEN_STEPS   = new Set([5, 6, 13, 14]);
// Montuno campana: Low on all quarter beats, High on syncopated upbeats
const DEFAULT_COWBELL_LOW_STEPS  = new Set([0, 2, 4, 6, 8, 10, 12, 14]);
const DEFAULT_COWBELL_HIGH_STEPS = new Set([3, 5, 11, 13]);

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private _masterVolume = 0.8;
  private nextBeatTime = 0;
  private currentBeat = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private beatCallbacks: Set<BeatCallback> = new Set();
  private _bpm = 120;
  private _isPlaying = false;

  private tracks: Map<TrackId, Track> = new Map([
    ['clave',        { id: 'clave',        pattern: new Set(DEFAULT_CLAVE_STEPS),        muted: false }],
    ['conga-open',   { id: 'conga-open',   pattern: new Set(DEFAULT_CONGA_OPEN_STEPS),   muted: true  }],
    ['conga-slap',   { id: 'conga-slap',   pattern: new Set(DEFAULT_CONGA_SLAP_STEPS),   muted: true  }],
    ['conga-heel',   { id: 'conga-heel',   pattern: new Set(DEFAULT_CONGA_HEEL_STEPS),   muted: true  }],
    ['cowbell-low',  { id: 'cowbell-low',  pattern: new Set(DEFAULT_COWBELL_LOW_STEPS),  muted: true  }],
    ['cowbell-high', { id: 'cowbell-high', pattern: new Set(DEFAULT_COWBELL_HIGH_STEPS), muted: true  }],
  ]);

  // Samples: 2 round-robin buffers per instrument
  private sampleBuffers: Map<TrackId, AudioBuffer[]> = new Map([
    ['clave', []], ['conga-open', []], ['conga-slap', []], ['conga-heel', []],
    ['cowbell-low', []], ['cowbell-high', []],
  ]);
  private rrCounters: Map<TrackId, number> = new Map([
    ['clave', 0], ['conga-open', 0], ['conga-slap', 0], ['conga-heel', 0],
    ['cowbell-low', 0], ['cowbell-high', 0],
  ]);

  // Sample loading state
  private _samplesReady = false;
  private _samplesLoadAttempted = false;

  // Reverb
  private convolver: ConvolverNode | null = null;

  // バックグラウンド維持用: 極小ノイズをループ再生して AudioContext をアクティブに保つ
  private silentSource: AudioBufferSourceNode | null = null;
  // visibilitychange リスナー（一度だけ登録）
  private visibilityHandler: (() => void) | null = null;

  // ── Clave Flip ─────────────────────────────────────────────────────────────
  private _flipPhase: 'idle' | 'announced' | 'ready' = 'idle';
  private _pendingFlipPattern: Set<number> | null = null;
  private flipCallbacks: Set<() => void> = new Set();

  // ── Public API ────────────────────────────────────────────────────────────

  get bpm() { return this._bpm; }
  set bpm(value: number) { this._bpm = Math.max(20, Math.min(300, value)); }

  get masterVolume() { return this._masterVolume; }
  set masterVolume(value: number) {
    this._masterVolume = Math.max(0, Math.min(1, value));
    if (this.masterGainNode) {
      this.masterGainNode.gain.value = this._masterVolume;
    }
  }

  get isPlaying() { return this._isPlaying; }

  get flipPhase() { return this._flipPhase; }
  get pendingFlip() { return this._flipPhase !== 'idle'; }

  /** 少なくとも一部のサンプルが正常にデコードされたか */
  get samplesReady() { return this._samplesReady; }
  /** ネットワーク取得を試みたか（オフライン判定に使用） */
  get samplesLoadAttempted() { return this._samplesLoadAttempted; }

  /**
   * フリップをリクエスト。
   * Beat 13 でアバニコ再生 → Beat 0 で反転適用。
   * 既にペンディング中、または再生中でない場合は無視。
   */
  requestFlip(newClaveSteps: Set<number>) {
    if (this._flipPhase !== 'idle') return;
    if (!this._isPlaying) return;
    this._pendingFlipPattern = newClaveSteps;
    this._flipPhase = 'announced';
  }

  cancelFlip() {
    this._pendingFlipPattern = null;
    this._flipPhase = 'idle';
  }

  onFlip(cb: () => void) {
    this.flipCallbacks.add(cb);
    return () => this.flipCallbacks.delete(cb);
  }

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

  /** OS による強制 suspend からの復帰用。useSilentAudio の visibilitychange から呼ぶ。 */
  resumeIfSuspended() {
    if (!this.context) return;
    if (this.context.state === 'suspended') {
      this.context.resume().then(() => {
        // resume 後にスケジューラが止まっていれば再起動
        if (this._isPlaying && this.schedulerTimer === null) {
          this.nextBeatTime = this.context!.currentTime + 0.05;
          this.schedulerTimer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
        }
      }).catch(() => {});
    }
  }

  toggleTrackMute(id: TrackId): boolean {
    const track = this.tracks.get(id)!;
    track.muted = !track.muted;
    return track.muted;
  }

  /**
   * Fetches VSCO-2-CE samples (CC0) and sets up reverb.
   * Falls back to synthesis silently on network failure.
   */
  async loadSamples(): Promise<void> {
    const ctx = this.getContext();
    this.setupReverb(ctx);

    await Promise.allSettled(
      (Object.entries(SAMPLE_URLS) as [TrackId, string[]][]).flatMap(([id, urls]) =>
        urls.map(url =>
          fetch(url)
            .then(r => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.arrayBuffer();
            })
            .then(buf => ctx.decodeAudioData(buf))
            .then(decoded => { this.sampleBuffers.get(id)!.push(decoded); })
            .catch(() => { /* network error → synthesis fallback */ })
        )
      )
    );

    this._samplesLoadAttempted = true;
    // 1つ以上のバッファがデコードされていれば「サンプル準備完了」
    this._samplesReady = [...this.sampleBuffers.values()].some(arr => arr.length > 0);
  }

  /** Load a WAV/audio file as the Clave sound (user upload). */
  async loadBuffer(arrayBuffer: ArrayBuffer) {
    const ctx = this.getContext();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    this.sampleBuffers.set('clave', [decoded]);
  }

  async start(): Promise<void> {
    if (this._isPlaying) return;
    const ctx = this.getContext();
    // iOS では resume() が非同期。await しないと suspended のまま
    // scheduler が走り音が鳴らないケースが発生する。
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    this._isPlaying = true;
    this.currentBeat = 0;
    this.nextBeatTime = ctx.currentTime + 0.05;
    this.schedulerTimer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
    this.startSilentLoop(ctx);
    this.attachVisibilityHandler();
  }

  stop() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this._pendingFlipPattern = null;
    this._flipPhase = 'idle';
    this.stopSilentLoop();
  }

  dispose() {
    this.stop();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.context) {
      this.context.close();
      this.context = null;
      this.masterGainNode = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.masterGainNode = this.context.createGain();
      this.masterGainNode.gain.value = this._masterVolume;
      this.masterGainNode.connect(this.context.destination);
    }
    return this.context;
  }

  /**
   * タブがバックグラウンドから復帰したとき、iOS Safari が
   * AudioContext を自動 suspend するので、明示的に resume する。
   * また、無音ループが途切れていれば再開する。
   */
  private attachVisibilityHandler() {
    if (this.visibilityHandler) return; // 二重登録しない
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      if (!this._isPlaying || !this.context) return;
      this.context.resume().catch(() => {});
      if (!this.silentSource) this.startSilentLoop(this.context);
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /**
   * 無音（極小ノイズ）バッファをループ再生し、AudioContext を
   * バックグラウンドでもアクティブに維持する。
   * 振幅 0.00001（約 -100 dB）= 聴覚上は完全に無音。
   */
  private startSilentLoop(ctx: AudioContext) {
    this.stopSilentLoop();
    const sampleRate = ctx.sampleRate;
    const buf = ctx.createBuffer(1, sampleRate, sampleRate); // 1秒
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.00001; // -100 dB ノイズ
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(ctx.destination);
    src.start();
    this.silentSource = src;
  }

  private stopSilentLoop() {
    if (!this.silentSource) return;
    try {
      this.silentSource.stop();
      this.silentSource.disconnect();
    } catch { /* already stopped */ }
    this.silentSource = null;
  }

  /**
   * Create a synthetic room impulse response for the ConvolverNode.
   * Exponentially decaying white noise — classic plate/room reverb technique.
   */
  private setupReverb(ctx: AudioContext) {
    const sampleRate = ctx.sampleRate;
    const duration = 1.2;  // seconds of reverb tail
    const decay = 2.8;
    const length = Math.floor(sampleRate * duration);
    const ir = ctx.createBuffer(2, length, sampleRate);

    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = ir;

    // Reverb output at full volume — per-instrument wet levels control mix
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 1.0;
    this.convolver.connect(reverbOut);
    reverbOut.connect(this.masterGainNode!);
  }

  /**
   * Humanization: randomise gain, pitch, and timing slightly on every hit.
   * This avoids the "quantised machine" feel of perfectly uniform playback.
   */
  private humanize(baseGain: number, baseTime: number) {
    return {
      gain:  baseGain * (0.88 + Math.random() * 0.24),     // ±12% velocity
      pitch: 0.97 + Math.random() * 0.06,                   // ±3% pitch
      time:  baseTime + (Math.random() - 0.5) * 0.006,     // ±3ms timing
    };
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
    // Beat 13: アバニコを鳴らし、フリップ準備完了へ
    if (beat === 13 && this._flipPhase === 'announced') {
      const stepDuration = (60 / this._bpm) / SUBDIVISION;
      this.playAbanico(ctx, time, stepDuration * 3);
      this._flipPhase = 'ready';
    }

    // Beat 0: フリップを適用
    if (beat === 0 && this._flipPhase === 'ready') {
      this.applyFlip();
      this._flipPhase = 'idle';
      this._pendingFlipPattern = null;
      const cbs = [...this.flipCallbacks];
      setTimeout(() => cbs.forEach(cb => cb()), 0);
    }

    for (const track of this.tracks.values()) {
      if (!track.muted && track.pattern.has(beat)) {
        this.playTrack(ctx, track.id, time);
      }
    }

    const delay = (time - ctx.currentTime) * 1000;
    setTimeout(() => {
      this.beatCallbacks.forEach(cb => cb({ beat, time }));
    }, Math.max(0, delay));
  }

  private playTrack(ctx: AudioContext, id: TrackId, baseTime: number) {
    const buffers = this.sampleBuffers.get(id)!;
    if (buffers.length > 0) {
      this.playSampleBuffer(ctx, id, buffers, baseTime);
    } else {
      // Synthesis fallback while samples are loading or on network failure
      this.playSynth(ctx, id, baseTime);
    }
  }

  private playSampleBuffer(
    ctx: AudioContext,
    id: TrackId,
    buffers: AudioBuffer[],
    baseTime: number,
  ) {
    const { gain, pitch, time } = this.humanize(TRACK_GAIN[id], baseTime);

    // Round-robin: alternate between available samples
    const counter = this.rrCounters.get(id)!;
    const buffer = buffers[counter % buffers.length];
    this.rrCounters.set(id, counter + 1);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;

    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;
    src.connect(gainNode);

    // Dry path → master gain → destination
    gainNode.connect(this.masterGainNode!);

    // Wet path → convolver → reverb output → destination
    if (this.convolver) {
      const wetGain = ctx.createGain();
      wetGain.gain.value = REVERB_WET[id];
      gainNode.connect(wetGain);
      wetGain.connect(this.convolver);
    }

    src.start(time);
  }

  // ── Synthesis fallbacks ───────────────────────────────────────────────────

  private playSynth(ctx: AudioContext, id: TrackId, time: number) {
    switch (id) {
      case 'clave':        return this.synthClave(ctx, time);
      case 'conga-open':   return this.synthCongaOpen(ctx, time);
      case 'conga-slap':   return this.synthCongaSlap(ctx, time);
      case 'conga-heel':   return this.synthCongaHeel(ctx, time);
      case 'cowbell-low':  return this.synthCowbellLow(ctx, time);
      case 'cowbell-high': return this.synthCowbellHigh(ctx, time);
    }
  }

  /** Clave: two detuned inharmonic sine partials, very short decay */
  private synthClave(ctx: AudioContext, time: number) {
    const { gain: g, time: t } = this.humanize(0.5, time);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(g, t);
    masterGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    for (const freq of [2500, 3800]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t + 0.015);
      osc.connect(masterGain);
      osc.start(t);
      osc.stop(t + 0.05);
    }

    masterGain.connect(this.masterGainNode!);
  }

  /**
   * Conga Open (ドーン): low resonant open tone.
   * Sine with pitch-drop envelope — 200Hz → 65Hz over 0.15s.
   */
  private synthCongaOpen(ctx: AudioContext, time: number) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['conga-open'], time);

    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(200, t);
    body.frequency.exponentialRampToValueAtTime(65, t + 0.15);
    bodyGain.gain.setValueAtTime(g, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    body.connect(bodyGain);
    body.start(t);
    body.stop(t + 0.24);
    bodyGain.connect(this.masterGainNode!);
    if (this.convolver) bodyGain.connect(this.convolver);
  }

  /**
   * Conga Slap (パシッ): organic "crack" — bandpass-filtered white noise.
   * Avoids the electronic sine-wave quality; noise gives a natural skin snap.
   */
  private synthCongaSlap(ctx: AudioContext, time: number) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['conga-slap'], time);

    const duration = 0.045;
    const sampleRate = ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Bandpass around 2.5kHz — "crack" frequency range of a conga slap
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2500;
    filter.Q.value = 1.2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(g, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + duration);

    src.connect(filter);
    filter.connect(env);
    env.connect(this.masterGainNode!);
    src.start(t);
  }

  /**
   * Conga Heel/Toe (ゴソゴソ): muffled dampened thud — palm pressed on drumhead.
   * Uses low-mid bandpass noise (350Hz) so it has no resonant "bom" tail.
   * Short and dry — no pitch, no sustain.
   */
  private synthCongaHeel(ctx: AudioContext, time: number) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['conga-heel'], time);

    const duration = 0.035;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Lowpass at 200Hz — removes all high-freq "shaker" character,
    // leaving only the low "thud" of a palm pressed on the drumhead
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 200;
    filter.Q.value = 1.0;

    const env = ctx.createGain();
    env.gain.setValueAtTime(g, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + duration);

    src.connect(filter);
    filter.connect(env);
    env.connect(this.masterGainNode!);
    src.start(t);
  }

  /**
   * Cowbell Low (Open): full resonant tone — longer decay, lower dominant pitch.
   * Represents hitting the mouth of the bell for a sustained "bong".
   */
  private synthCowbellLow(ctx: AudioContext, time: number) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['cowbell-low'], time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 620;
    filter.Q.value = 4;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(g, t);
    masterGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55); // longer tail

    for (const freq of [562, 780]) { // lower pair → more open/resonant
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + 0.58);
    }

    filter.connect(masterGain);
    masterGain.connect(this.masterGainNode!);
    if (this.convolver) masterGain.connect(this.convolver);
  }

  /**
   * Cowbell High (Muted): bright, short accent — hitting the shoulder of the bell.
   * Higher frequencies, faster decay for a "chick" or "ting" sound.
   */
  private synthCowbellHigh(ctx: AudioContext, time: number) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['cowbell-high'], time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 5;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(g, t);
    masterGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15); // short decay

    for (const freq of [845, 1200]) { // higher pair → brighter/muted
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + 0.18);
    }

    filter.connect(masterGain);
    masterGain.connect(this.masterGainNode!);
    if (this.convolver) masterGain.connect(this.convolver);
  }

  /**
   * アバニコ: ティンバレスによる加速するロール音。
   * 「カラカラカラッ！」— バンドパスノイズが加速・クレッシェンドしてフィナーレへ。
   */
  private playAbanico(ctx: AudioContext, startTime: number, duration: number) {
    const hits = 10;
    for (let i = 0; i < hits; i++) {
      const progress = i / hits;
      // 加速する間隔: 等差から徐々に縮む
      const t = startTime + duration * (1 - Math.pow(1 - progress, 2));
      const hitDuration = Math.max(0.008, 0.018 - progress * 0.010);
      const bufLen = Math.floor(ctx.sampleRate * hitDuration);
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let j = 0; j < bufLen; j++) data[j] = Math.random() * 2 - 1;

      const src = ctx.createBufferSource();
      src.buffer = buf;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 3000 + progress * 2000; // 3→5kHz 上昇スウィープ
      filter.Q.value = 3;

      const gainNode = ctx.createGain();
      gainNode.gain.value = (0.25 + progress * 0.55) * 0.5; // クレッシェンド

      src.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(this.masterGainNode!);
      src.start(t);
    }

    // 最後のアクセント (三角波)
    const finalT = startTime + duration * 0.92;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(900, finalT);
    const finalGain = ctx.createGain();
    finalGain.gain.setValueAtTime(0.5, finalT);
    finalGain.gain.exponentialRampToValueAtTime(0.001, finalT + 0.1);
    osc.connect(finalGain);
    finalGain.connect(this.masterGainNode!);
    osc.start(finalT);
    osc.stop(finalT + 0.12);
  }

  /**
   * フリップ適用: クラーベを newPattern に更新し、他の全トラックのバーA↔Bを入れ替え。
   */
  private applyFlip() {
    // クラーベを新パターンに
    if (this._pendingFlipPattern) {
      this.tracks.get('clave')!.pattern = this._pendingFlipPattern;
    }
    // 他トラック: step 0-7 ↔ step 8-15
    for (const [id, track] of this.tracks) {
      if (id === 'clave') continue;
      const flipped = new Set<number>();
      for (const step of track.pattern) {
        flipped.add(step < 8 ? step + 8 : step - 8);
      }
      track.pattern = flipped;
    }
  }

  private advanceBeat() {
    const secondsPerStep = (60 / this._bpm) / SUBDIVISION;
    this.nextBeatTime += secondsPerStep;
    this.currentBeat = (this.currentBeat + 1) % BEATS_PER_BAR;
  }
}

export const audioEngine = new AudioEngine();
