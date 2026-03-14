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

export type TrackId = 'clave' | 'conga-open' | 'conga-slap' | 'conga-heel' | 'cowbell-low' | 'cowbell-high'
  | 'bongo-low' | 'bongo-high' | 'guira' | 'bass';

export type ReverbType = 'none' | 'studio' | 'hall' | 'club' | 'plaza';

import { type Articulation } from './bachataPatterns';

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
  'bongo-low':  [],
  'bongo-high': [],
  'guira':      [],
  'bass':       [],
};


// Base gain per instrument — 0dBFS を超えないよう 0.7 以下に抑える。
// 音量の底上げは compressor 後段の outputGainNode (固定 4.0×) で行う。
// これにより compressor が見るレベルを低く保ち、メイクアップゲインによる
// ノイズ床の持ち上げを最小化する。
const TRACK_GAIN: Record<TrackId, number> = {
  clave:         0.55,
  'conga-open':  0.70,  // dominant hit
  'conga-slap':  0.28,  // medium accent
  'conga-heel':  0.42,  // synth-only; lowpass noise "gosogoso"
  'cowbell-low':  0.30,
  'cowbell-high': 0.35,
  // Bachata instruments
  'bongo-low':  0.60,
  'bongo-high': 0.35,
  'guira':      0.20,
  'bass':       0.65,
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
// Bachata patterns (16 steps = 2 bars of 4/4 at 8th-note subdivision)
// Characteristic: accent (tap/hip) on beat 4 (step 6) and beat 8 (step 14)
const DEFAULT_BONGO_LOW_STEPS  = new Set([0, 2, 4, 6, 8, 10, 12, 14]); // every quarter beat
const DEFAULT_BONGO_HIGH_STEPS = new Set([1, 3, 9, 11]);               // syncopated upbeats
const DEFAULT_GUIRA_STEPS      = new Set([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]); // constant
const DEFAULT_BASS_STEPS       = new Set([6, 14]);                     // beat 4 and 8 (tap accent)

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private _masterVolume = 1.0;
  private compressor: DynamicsCompressorNode | null = null;
  private highShelfNode: BiquadFilterNode | null = null;
  private outputGainNode: GainNode | null = null;
  private _loudness = true;
  private noiseGateNode: GainNode | null = null;
  // ノイズゲート定数
  private static readonly GATE_HOLD    = 1.5;   // リバーブ残響(1.2s)が収まるまで保持
  private static readonly GATE_RELEASE = 0.08;  // 80ms でフェードアウト（ブツ切れ防止）
  private static readonly GATE_ATTACK  = 0.002; // τ=2ms（約6msで95%到達）
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
    ['bongo-low',  { id: 'bongo-low',  pattern: new Set(DEFAULT_BONGO_LOW_STEPS),  muted: true }],
    ['bongo-high', { id: 'bongo-high', pattern: new Set(DEFAULT_BONGO_HIGH_STEPS), muted: true }],
    ['guira',      { id: 'guira',      pattern: new Set(DEFAULT_GUIRA_STEPS),      muted: true }],
    ['bass',       { id: 'bass',       pattern: new Set(DEFAULT_BASS_STEPS),       muted: true }],
  ]);

  // Samples: 2 round-robin buffers per instrument
  private sampleBuffers: Map<TrackId, AudioBuffer[]> = new Map([
    ['clave', []], ['conga-open', []], ['conga-slap', []], ['conga-heel', []],
    ['cowbell-low', []], ['cowbell-high', []],
    ['bongo-low', []], ['bongo-high', []], ['guira', []], ['bass', []],
  ]);
  private rrCounters: Map<TrackId, number> = new Map([
    ['clave', 0], ['conga-open', 0], ['conga-slap', 0], ['conga-heel', 0],
    ['cowbell-low', 0], ['cowbell-high', 0],
    ['bongo-low', 0], ['bongo-high', 0], ['guira', 0], ['bass', 0],
  ]);

  // Sample loading state
  private _samplesReady = false;
  private _samplesLoadAttempted = false;

  // Reverb
  private convolver: ConvolverNode | null = null;
  private reverbSendGain: GainNode | null = null;
  private reverbWetGain: GainNode | null = null;
  private _reverbType: ReverbType = 'none';
  private _reverbWetLevel = 0.8; // User-controlled wet depth (0–1)

  // バックグラウンド維持用: 極小ノイズをループ再生して AudioContext をアクティブに保つ
  private silentSource: AudioBufferSourceNode | null = null;
  // visibilitychange リスナー（一度だけ登録）
  private visibilityHandler: (() => void) | null = null;

  // ── Studio ambience delay (15ms, feedback 0.1) ───────────────────────────
  private studioDelayNode: DelayNode | null = null;
  private studioDelayFeedback: GainNode | null = null;
  private studioDelayWet: GainNode | null = null;

  // ── Bongo articulation map (open vs muffled per step) ────────────────────
  private bongoArticulation: Map<'bongo-low' | 'bongo-high', Map<number, Articulation>> = new Map([
    ['bongo-low',  new Map()],
    ['bongo-high', new Map()],
  ]);

  // ── Per-step gain overrides (multiplier applied on top of TRACK_GAIN) ────
  // Key: TrackId → Map<step, multiplier>
  private stepGainOverrides: Map<TrackId, Map<number, number>> = new Map();

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

  get loudness() { return this._loudness; }
  set loudness(value: boolean) {
    this._loudness = value;
    if (!this.compressor) return;
    if (value) {
      // コンプレッサーON: ピーク抑制のみ（過剰なメイクアップゲインを避ける設定）
      // TRACK_GAIN を 0.7 以下に抑えているため、しきい値を高めに設定して
      // ノイズ床が threshold を超えないようにする → ノイズへの makeup gain なし
      this.compressor.threshold.value = -8;
      this.compressor.knee.value      = 20;
      this.compressor.ratio.value     = 4;
      this.compressor.attack.value    = 0.003;
      this.compressor.release.value   = 0.30;
    } else {
      // コンプレッサーOFF: 無効化（ratio=1 で透過）
      this.compressor.threshold.value = 0;
      this.compressor.knee.value      = 0;
      this.compressor.ratio.value     = 1;
      this.compressor.attack.value    = 0;
      this.compressor.release.value   = 0.25;
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

  /** Set per-step articulation for bongo tracks. */
  setTrackArticulation(
    id: 'bongo-low' | 'bongo-high',
    artMap: Partial<Record<number, Articulation>>,
  ) {
    const m = new Map<number, Articulation>();
    for (const [k, v] of Object.entries(artMap)) {
      if (v) m.set(Number(k), v);
    }
    this.bongoArticulation.set(id, m);
  }

  /**
   * Set per-step gain multipliers for a track.
   * Pass null to clear all overrides for that track.
   * Values in overrides are multiplied with TRACK_GAIN on playback.
   */
  setStepGainOverride(id: TrackId, overrides: Record<number, number> | null) {
    if (overrides === null) {
      this.stepGainOverrides.delete(id);
    } else {
      const m = new Map<number, number>();
      for (const [k, v] of Object.entries(overrides)) {
        m.set(Number(k), v);
      }
      this.stepGainOverrides.set(id, m);
    }
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

  get reverbType(): ReverbType { return this._reverbType; }

  /** User-controlled wet depth (0–1). Changing this live crossfades the reverb return level. */
  get reverbWetLevel() { return this._reverbWetLevel; }
  set reverbWetLevel(value: number) {
    this._reverbWetLevel = Math.max(0, Math.min(1, value));
    if (this.reverbWetGain && this.context && this._reverbType !== 'none') {
      const now = this.context.currentTime;
      const g = this.reverbWetGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(g.value, 0.0001), now);
      g.exponentialRampToValueAtTime(Math.max(this._reverbWetLevel, 0.0001), now + 0.02);
    }
  }

  async setReverb(type: ReverbType): Promise<void> {
    if (this._reverbType === type) return;
    this.getContext(); // Ensure context is initialized before adjustAmbience
    this.adjustAmbience(type);
    await this.loadReverbSample(type);
    this._reverbType = type;
  }

  async start(): Promise<void> {
    if (this._isPlaying) return;
    let ctx = this.getContext();

    if (ctx.state !== 'running') {
      // iOS ではスリープ後に resume() が永久に resolve されないケースがある。
      // 500ms タイムアウトを設け、それでも running にならなければ Context を再生成する。
      try {
        await Promise.race([
          ctx.resume(),
          new Promise<void>(resolve => setTimeout(resolve, 500)),
        ]);
      } catch { /* ignore */ }

      if (this.context?.state !== 'running') {
        // iOS の user gesture 内で新規 AudioContext を生成すると即 running になる
        ctx = await this.resetAudioContext();
      }
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
    // ノイズゲートを即座に閉じる（Stop後の残響ノイズを遮断）
    if (this.noiseGateNode && this.context) {
      const g = this.noiseGateNode.gain;
      g.cancelScheduledValues(this.context.currentTime);
      g.setTargetAtTime(0, this.context.currentTime, AudioEngine.GATE_ATTACK);
    }
  }

  dispose() {
    this.stop();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.context) {
      // Explicitly disconnect every node before closing the context.
      // AudioContext.close() alone releases the hardware, but explicit
      // disconnect() ensures no dangling references prevent GC.
      this.masterGainNode?.disconnect();
      this.noiseGateNode?.disconnect();
      this.compressor?.disconnect();
      this.highShelfNode?.disconnect();
      this.outputGainNode?.disconnect();
      this.reverbSendGain?.disconnect();
      this.convolver?.disconnect();
      this.reverbWetGain?.disconnect();
      this.studioDelayNode?.disconnect();
      this.studioDelayFeedback?.disconnect();
      this.studioDelayWet?.disconnect();

      this.context.close();
      this.context             = null;
      this.masterGainNode      = null;
      this.noiseGateNode       = null;
      this.compressor          = null;
      this.highShelfNode       = null;
      this.outputGainNode      = null;
      this.convolver           = null;
      this.reverbSendGain      = null;
      this.reverbWetGain       = null;
      this.studioDelayNode     = null;
      this.studioDelayFeedback = null;
      this.studioDelayWet      = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Returns the singleton AudioContext, creating and wiring all nodes on first call.
   *
   * Full signal graph (built once; never reconnected):
   *
   *   Source nodes (per instrument) ──► masterGainNode
   *
   *   Dry path:
   *     masterGainNode → noiseGateNode → compressor → highShelfNode
   *                    → outputGainNode → destination
   *
   *   Reverb Send-Return loop (parallel to dry, shares masterGainNode as mix bus):
   *     masterGainNode → reverbSendGain → convolver → reverbWetGain ┐
   *     └─────────────────────────────────────────────────────────────┘
   *     reverbWetGain.gain controls wet depth (0 = dry only, set via setReverb()).
   *     The cycle is valid because ConvolverNode has an intrinsic block-size delay.
   *
   *   Studio ambience delay (independent tap, feeds compressor directly):
   *     masterGainNode → studioDelayNode ⟲(feedback=0.1) → studioDelayWet → compressor
   */
  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();

      // ── Master mix bus ───────────────────────────────────────────────────
      this.masterGainNode = this.context.createGain();
      this.masterGainNode.gain.value = this._masterVolume;

      // ── Dry path nodes ───────────────────────────────────────────────────
      this.noiseGateNode = this.context.createGain();
      this.noiseGateNode.gain.value = 0; // Initially closed; opened per beat by openNoiseGate()

      this.compressor = this.context.createDynamicsCompressor();

      // High-shelf filter: cut frequencies above 10 kHz by 6 dB.
      // Removes the audible hiss introduced when the compressor boosts
      // the broadband noise floor of the congas and reverb IR.
      this.highShelfNode = this.context.createBiquadFilter();
      this.highShelfNode.type = 'highshelf';
      this.highShelfNode.frequency.value = 10000;
      this.highShelfNode.gain.value = -6;

      // Fixed output boost (+12 dB / 4×) to compensate for the conservative
      // TRACK_GAIN values (≤0.7) that keep the compressor input level low.
      this.outputGainNode = this.context.createGain();
      this.outputGainNode.gain.value = 4.0;

      // Wire dry path: masterGainNode → noiseGateNode → compressor → highShelfNode → outputGainNode → destination
      this.masterGainNode.connect(this.noiseGateNode);
      this.noiseGateNode.connect(this.compressor);
      this.compressor.connect(this.highShelfNode);
      this.highShelfNode.connect(this.outputGainNode);
      this.outputGainNode.connect(this.context.destination);

      // ── Reverb Send-Return loop ──────────────────────────────────────────
      // Send tap: masterGainNode → reverbSendGain (controls send level)
      //           → convolver (IR-based room simulation)
      //           → reverbWetGain (controls wet depth, changed via setReverb())
      //           → masterGainNode (return; flows onward through the dry path)
      // All source nodes connect only to masterGainNode; reverb is applied globally.
      this.reverbSendGain = this.context.createGain();
      this.reverbSendGain.gain.value = 0.3;
      this.convolver = this.context.createConvolver();
      this.reverbWetGain = this.context.createGain();
      this.reverbWetGain.gain.value = 0.0; // Starts silent; setReverb() fades this in

      this.masterGainNode.connect(this.reverbSendGain);
      this.reverbSendGain.connect(this.convolver);
      this.convolver.connect(this.reverbWetGain);
      this.reverbWetGain.connect(this.masterGainNode); // Return into the mix bus

      // ── Studio ambience delay ────────────────────────────────────────────
      // A 15 ms pre-delay with light feedback gives a sense of room size without
      // the character of a full convolution reverb. Wet output feeds the compressor
      // directly (bypassing the noise gate) so the room tail decays naturally.
      this.studioDelayNode = this.context.createDelay(0.1);
      this.studioDelayNode.delayTime.value = 0.015;
      this.studioDelayFeedback = this.context.createGain();
      this.studioDelayFeedback.gain.value = 0.1;
      this.studioDelayWet = this.context.createGain();
      this.studioDelayWet.gain.value = 0.14;

      this.masterGainNode.connect(this.studioDelayNode);
      this.studioDelayNode.connect(this.studioDelayFeedback);
      this.studioDelayFeedback.connect(this.studioDelayNode); // Feedback loop (DelayNode breaks the cycle)
      this.studioDelayNode.connect(this.studioDelayWet);
      this.studioDelayWet.connect(this.compressor);

      // Load a synthetic room IR into the convolver (reverbWetGain=0 so inaudible at start)
      this.setupReverb(this.context);

      // Apply the stored loudness setting to the freshly created compressor
      this.loudness = this._loudness;

      // Resume automatically if iOS suspends the context mid-playback
      this.context.addEventListener('statechange', () => {
        if (!this._isPlaying || !this.context) return;
        if (this.context.state === 'suspended') {
          this.context.resume().catch(() => {});
        }
      });
    }
    return this.context;
  }

  /**
   * Registers a one-time visibilitychange listener that resumes the AudioContext
   * and restarts the silent keep-alive loop whenever the tab becomes visible.
   * iOS Safari automatically suspends the context on tab hide.
   */
  private attachVisibilityHandler() {
    if (this.visibilityHandler) return; // Register only once
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      if (!this._isPlaying || !this.context) return;
      this.context.resume().catch(() => {});
      if (!this.silentSource) this.startSilentLoop(this.context);
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /**
   * Plays a 1-second looping buffer of near-silent noise (≈−90 dBFS) directly
   * to the destination, keeping the AudioContext alive in the iOS background.
   * Amplitude 0.00003 is inaudible to humans but sufficient to prevent iOS
   * from suspending the audio session.
   */
  private startSilentLoop(ctx: AudioContext) {
    this.stopSilentLoop();
    const sampleRate = ctx.sampleRate;
    const buf = ctx.createBuffer(1, sampleRate, sampleRate); // 1秒
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.00003; // ≈ -90 dB — 人間には不可聴、iOS には充分
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(ctx.destination);
    src.start();
    this.silentSource = src;
  }

  /**
   * AudioContext を安全に閉じて再生成する。
   * iOS でスリープ後に context が無効化された場合の復帰に使用。
   * AudioBuffer は context 非依存のデータ容器なので、再デコードは不要。
   */
  /**
   * Tears down the current AudioContext and rebuilds it from scratch.
   * Called when iOS suspends the context during sleep and resume() times out.
   * AudioBuffer objects are context-independent data containers, so no
   * re-decoding is needed; getContext() calls setupReverb() internally.
   */
  private async resetAudioContext(): Promise<AudioContext> {
    if (this.context) {
      try { await this.context.close(); } catch { /* ignore */ }
    }
    this.context             = null;
    this.masterGainNode      = null;
    this.noiseGateNode       = null;
    this.compressor          = null;
    this.highShelfNode       = null;
    this.outputGainNode      = null;
    this.convolver           = null;
    this.reverbSendGain      = null;
    this.reverbWetGain       = null;
    this.studioDelayNode     = null;
    this.studioDelayFeedback = null;
    this.studioDelayWet      = null;
    this.stopSilentLoop();
    // getContext() wires the full signal graph and calls setupReverb() — no extra call needed
    return this.getContext();
  }

  /**
   * Opens the noise gate at the scheduled beat time.
   *
   * The gate stays open as long as notes keep arriving: each call cancels the
   * previously scheduled close and reschedules it GATE_HOLD seconds later,
   * giving the reverb tail time to decay before the gate shuts.
   *
   * Timeline per note:
   *   [time]               → attack (τ=2 ms) to 1.0
   *   [time + GATE_HOLD]   → hold ends, gate held at 1.0
   *   [time + GATE_HOLD + GATE_RELEASE] → linear ramp to 0 (80 ms)
   */
  private openNoiseGate(time: number) {
    if (!this.noiseGateNode) return;
    const g = this.noiseGateNode.gain;
    g.cancelScheduledValues(time); // Cancel any pending close from a previous note
    g.setTargetAtTime(1.0, time, AudioEngine.GATE_ATTACK);
    const holdUntil = time + AudioEngine.GATE_HOLD;
    g.setValueAtTime(1.0, holdUntil);
    g.linearRampToValueAtTime(0.0, holdUntil + AudioEngine.GATE_RELEASE);
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
   * Generates a synthetic room impulse response (IR) and loads it into
   * the existing this.convolver without recreating the node.
   *
   * Technique: exponentially decaying stereo white noise — the classic
   * plate/room reverb approximation.  Duration 1.2 s, decay exponent 2.8.
   */
  private setupReverb(ctx: AudioContext) {
    if (!this.convolver) return;
    const sampleRate = ctx.sampleRate;
    const duration = 1.2;
    const decay = 2.8;
    const length = Math.floor(sampleRate * duration);
    const ir = ctx.createBuffer(2, length, sampleRate);

    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }

    this.convolver.buffer = ir;
  }

  /**
   * Switches the reverb type by crossfading reverbWetGain over ~20 ms.
   * Reuses the existing convolver node — no new nodes are created or connected.
   *
   * 'none'          → fade reverbWetGain to 0.0001 (effectively silent)
   * 'studio'/'hall' → fetch IR, swap convolver.buffer, then fade gain in to 1.0
   *
   * The crossfade prevents audible clicks when the buffer is replaced mid-playback.
   */
  /**
   * Adjusts the studio ambience delay parameters to match the acoustic character
   * of the selected environment. Called synchronously before loadReverbSample().
   *
   * | type   | delay  | feedback | wet  | character               |
   * |--------|--------|----------|------|-------------------------|
   * | none   | —      | —        | ~0   | completely dry          |
   * | studio | 15 ms  | 0.10     | 0.14 | tight recording space   |
   * | hall   | 35 ms  | 0.18     | 0.20 | concert hall            |
   * | club   | 22 ms  | 0.15     | 0.18 | medium indoor venue     |
   * | plaza  | 55 ms  | 0.25     | 0.22 | outdoor open square     |
   */
  private adjustAmbience(type: ReverbType) {
    if (!this.studioDelayNode || !this.studioDelayFeedback || !this.studioDelayWet || !this.context) return;
    const now = this.context.currentTime;
    switch (type) {
      case 'none':
        this.studioDelayWet.gain.setTargetAtTime(0.0001, now, 0.02);
        break;
      case 'studio':
        this.studioDelayNode.delayTime.value = 0.015;
        this.studioDelayFeedback.gain.value  = 0.10;
        this.studioDelayWet.gain.setTargetAtTime(0.14, now, 0.05);
        break;
      case 'hall':
        this.studioDelayNode.delayTime.value = 0.035;
        this.studioDelayFeedback.gain.value  = 0.18;
        this.studioDelayWet.gain.setTargetAtTime(0.20, now, 0.05);
        break;
      case 'club':
        this.studioDelayNode.delayTime.value = 0.022;
        this.studioDelayFeedback.gain.value  = 0.15;
        this.studioDelayWet.gain.setTargetAtTime(0.18, now, 0.05);
        break;
      case 'plaza':
        // Outdoor plaza: long pre-delay + high feedback simulates distant walls
        this.studioDelayNode.delayTime.value = 0.055;
        this.studioDelayFeedback.gain.value  = 0.25;
        this.studioDelayWet.gain.setTargetAtTime(0.22, now, 0.05);
        break;
    }
  }

  private async loadReverbSample(type: ReverbType) {
    if (!this.context || !this.convolver || !this.reverbWetGain) return;

    const now = this.context.currentTime;
    const g = this.reverbWetGain.gain;

    if (type === 'none') {
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(g.value, 0.0001), now);
      g.exponentialRampToValueAtTime(0.0001, now + 0.02);
      return;
    }

    const urls: Record<Exclude<ReverbType, 'none'>, string> = {
      studio: 'https://example.com/studio-reverb.wav', // placeholder
      hall:   'https://example.com/hall-reverb.wav',   // placeholder
      club:   'https://example.com/club-reverb.wav',   // placeholder
      plaza:  'https://example.com/plaza-reverb.wav',  // placeholder
    };

    try {
      const response = await fetch(urls[type]);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.context.decodeAudioData(arrayBuffer);

      // Crossfade: fade out (10 ms) → swap buffer → fade in (10 ms)
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(g.value, 0.0001), now);
      g.exponentialRampToValueAtTime(0.0001, now + 0.01);
      this.convolver.buffer = audioBuffer;
      g.setValueAtTime(0.0001, now + 0.01);
      g.exponentialRampToValueAtTime(Math.max(this._reverbWetLevel, 0.0001), now + 0.02);
    } catch (error) {
      console.error('Failed to load reverb sample:', error);
    }
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

    let hasNotes = false;
    for (const track of this.tracks.values()) {
      if (!track.muted && track.pattern.has(beat)) {
        this.playTrack(ctx, track.id, time, beat);
        hasNotes = true;
      }
    }
    // 音符が1つでもあればノイズゲートを開き、リバーブ残響後に閉じる
    if (hasNotes) this.openNoiseGate(time);

    const delay = (time - ctx.currentTime) * 1000;
    setTimeout(() => {
      this.beatCallbacks.forEach(cb => cb({ beat, time }));
    }, Math.max(0, delay));
  }

  /** Returns the gain multiplier for a given track+step (1.0 if no override). */
  private getStepGainMult(id: TrackId, beat: number): number {
    const overrides = this.stepGainOverrides.get(id);
    if (!overrides) return 1.0;
    return overrides.get(beat) ?? 1.0;
  }

  private playTrack(ctx: AudioContext, id: TrackId, baseTime: number, beat: number) {
    const gainMult = this.getStepGainMult(id, beat);
    const buffers = this.sampleBuffers.get(id)!;
    if (buffers.length > 0) {
      this.playSampleBuffer(ctx, id, buffers, baseTime, gainMult);
    } else {
      // Synthesis fallback while samples are loading or on network failure
      this.playSynth(ctx, id, baseTime, beat, gainMult);
    }
  }

  private playSampleBuffer(
    ctx: AudioContext,
    id: TrackId,
    buffers: AudioBuffer[],
    baseTime: number,
    gainMult = 1.0,
  ) {
    const { gain, pitch, time } = this.humanize(TRACK_GAIN[id] * gainMult, baseTime);

    // Round-robin: alternate between available samples
    const counter = this.rrCounters.get(id)!;
    const buffer = buffers[counter % buffers.length];
    this.rrCounters.set(id, counter + 1);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;

    const gainNode = ctx.createGain();
    // 3 ms exponential ramp from near-zero avoids the click caused by a gain step
    gainNode.gain.setValueAtTime(0.0001, time);
    gainNode.gain.exponentialRampToValueAtTime(gain, time + 0.003);
    src.connect(gainNode);

    // Connect only to masterGainNode; reverb is handled globally via the
    // Send-Return loop (masterGainNode → reverbSendGain → convolver → reverbWetGain → masterGainNode)
    gainNode.connect(this.masterGainNode!);

    src.start(time);
  }

  // ── Audio realism helpers ─────────────────────────────────────────────────

  /**
   * Soft tanh saturation curve — adds odd harmonics (3rd, 5th…) to a sine wave,
   * giving the "woody" character of a real drumhead without audible clipping.
   * amount=2.5 is subtle; increase for more distortion.
   */
  private createSaturationCurve(): Float32Array<ArrayBuffer> {
    const samples = 512;
    const curve = new Float32Array(new ArrayBuffer(samples * 4));
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.tanh(2.5 * x) * 0.82;
    }
    return curve;
  }

  /**
   * Physical contact transient: 1ms attack + HPF white-noise burst.
   * Simulates the fingertip or beater briefly touching the drumhead / scraper.
   * @param hpFreq    High-pass cutoff — higher for harder surfaces (metal > skin)
   * @param level     Peak gain (proportional to TRACK_GAIN of the instrument)
   * @param duration  Total burst length in seconds (default 8ms; use 10ms for bongo high)
   */
  private playAttackNoise(ctx: AudioContext, time: number, level: number, hpFreq: number, duration = 0.008) {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = hpFreq;
    hpf.Q.value = 0.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(level, time + 0.001);         // 1ms attack
    env.gain.exponentialRampToValueAtTime(0.001, time + duration); // 7ms decay

    src.connect(hpf);
    hpf.connect(env);
    env.connect(this.masterGainNode!);
    src.start(time);
  }

  // ── Synthesis fallbacks ───────────────────────────────────────────────────

  private playSynth(ctx: AudioContext, id: TrackId, time: number, beat: number, gainMult = 1.0) {
    switch (id) {
      case 'clave':        return this.synthClave(ctx, time);
      case 'conga-open':   return this.synthCongaOpen(ctx, time);
      case 'conga-slap':   return this.synthCongaSlap(ctx, time);
      case 'conga-heel':   return this.synthCongaHeel(ctx, time);
      case 'cowbell-low':  return this.synthCowbellLow(ctx, time);
      case 'cowbell-high': return this.synthCowbellHigh(ctx, time);
      case 'bongo-low': {
        const art = this.bongoArticulation.get('bongo-low')?.get(beat) ?? 'open';
        return this.synthBongoLow(ctx, time, art, gainMult);
      }
      case 'bongo-high': {
        const art = this.bongoArticulation.get('bongo-high')?.get(beat) ?? 'open';
        return this.synthBongoHigh(ctx, time, art, gainMult);
      }
      case 'guira':        return this.synthGuira(ctx, time, gainMult);
      case 'bass':         return this.synthBass(ctx, time, gainMult);
    }
  }

  /** Clave: two detuned inharmonic sine partials, very short decay */
  private synthClave(ctx: AudioContext, time: number) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['clave'], time);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, t);
    masterGain.gain.exponentialRampToValueAtTime(g, t + 0.003);
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
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(g, t + 0.003);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    body.connect(bodyGain);
    body.start(t);
    body.stop(t + 0.24);
    bodyGain.connect(this.masterGainNode!);
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
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(g, t + 0.003);
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
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(g, t + 0.003);
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
    masterGain.gain.setValueAtTime(0.0001, t);
    masterGain.gain.exponentialRampToValueAtTime(g, t + 0.003);
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
    masterGain.gain.setValueAtTime(0.0001, t);
    masterGain.gain.exponentialRampToValueAtTime(g, t + 0.003);
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
  }

  /**
   * Bongo Low (Macho): deep warm punch with physical realism.
   *   open    — 200Hz→70Hz (0.12s)
   *             WaveShaperNode tanh saturation adds odd harmonics ("wooden" body tone)
   *             Peaking 200Hz Q=8 +5dB: strong drum-body resonance simulation
   *             Attack noise layer (HPF 1.8kHz, 8ms): fingertip-on-skin transient
   *   muffled — 180Hz→100Hz (0.05s), tighter peaking, bandpass dampens resonant tail
   * Panned left 20%.
   */
  private synthBongoLow(ctx: AudioContext, time: number, articulation: Articulation = 'open', gainMult = 1.0) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['bongo-low'] * gainMult, time);
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = 'sine';

    // Scale durations proportionally to the 8th-note step length.
    // At 120 BPM: stepDuration=0.25s → longer pitch glide and decay (fills the space).
    // At 180 BPM: stepDuration=0.167s → tighter values (≈ previous hardcoded constants).
    const stepDuration = (60 / this._bpm) / 2;

    if (articulation === 'muffled') {
      const pitchDrop = Math.min(0.12, stepDuration * 0.22);
      const decay     = Math.min(0.14, stepDuration * 0.30);
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(100, t + pitchDrop);
      gainNode.gain.setValueAtTime(0.0001, t);
      gainNode.gain.exponentialRampToValueAtTime(g * 0.75, t + 0.003);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + decay);
    } else {
      const pitchDrop = Math.min(0.18, stepDuration * 0.45);
      const decay     = Math.min(0.28, stepDuration * 0.75);
      // stop computed after the else block
      osc.frequency.setValueAtTime(200, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + pitchDrop);
      gainNode.gain.setValueAtTime(0.0001, t);
      gainNode.gain.exponentialRampToValueAtTime(g, t + 0.003);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + decay);
    }

    // Compute stop time after the if/else (used below)
    const stopTime = articulation === 'muffled'
      ? Math.min(0.16, stepDuration * 0.35)
      : Math.min(0.32, stepDuration * 0.85);

    // WaveShaper: tanh saturation — adds odd harmonics for natural drum timbre
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.createSaturationCurve();
    shaper.oversample = '2x';
    osc.connect(shaper);
    shaper.connect(gainNode);

    // Peaking EQ: 200Hz drum-body resonance (tighter Q for more pronounced ring)
    const peaking = ctx.createBiquadFilter();
    peaking.type = 'peaking';
    peaking.frequency.value = 200;
    peaking.Q.value = articulation === 'muffled' ? 4 : 8;
    peaking.gain.value = articulation === 'muffled' ? 1.5 : 5;

    // Muffled: bandpass damps the resonant tail
    if (articulation === 'muffled') {
      const damp = ctx.createBiquadFilter();
      damp.type = 'bandpass';
      damp.frequency.value = 300;
      damp.Q.value = 3;
      gainNode.connect(damp);
      damp.connect(peaking);
    } else {
      gainNode.connect(peaking);
    }

    // Pan left 20%
    const panner = ctx.createStereoPanner();
    panner.pan.value = -0.2;
    peaking.connect(panner);
    panner.connect(this.masterGainNode!);
    osc.start(t);
    osc.stop(t + stopTime);

    // Attack transient noise: fingertip-on-skin contact sound
    this.playAttackNoise(ctx, t, g * (articulation === 'muffled' ? 0.2 : 0.35), 1800);
  }

  /**
   * Bongo High (Hembra): skin-stretch pitch drop with physical realism.
   *   open    — 800Hz→400Hz in 10ms ("カンッ"), WaveShaper saturation
   *             Inharmonic overtone (×2.76) at 15% mix → membrane roughness
   *             Attack noise (HPF 2.5kHz, 10ms): sharp fingertip impact
   *             Pitch detune + decay time randomized ±2% per hit
   *   muffled — 600Hz→350Hz in 8ms, LPF@800Hz softens, lighter attack noise
   * Panned left 20%.
   */
  private synthBongoHigh(ctx: AudioContext, time: number, articulation: Articulation = 'open', gainMult = 1.0) {
    // pitch from humanize → per-hit detune (±3%); decayJitter → ±2% decay variation
    const { gain: g, pitch, time: t } = this.humanize(TRACK_GAIN['bongo-high'] * gainMult, time);
    const detuneCents = Math.log2(pitch) * 1200;
    const decayJitter = 1 + (Math.random() - 0.5) * 0.04;

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = 'sine';
    osc.detune.value = detuneCents;

    // Scale decay to step duration — at 120 BPM the note has more space to ring.
    // Pitch snap (800→400Hz) is a physical constant and stays short regardless of tempo.
    const stepDuration = (60 / this._bpm) / 2;

    let decay: number;
    if (articulation === 'muffled') {
      decay = Math.min(0.10, stepDuration * 0.22) * decayJitter;
      osc.frequency.setValueAtTime(600, t);
      osc.frequency.exponentialRampToValueAtTime(350, t + 0.008); // physical snap — keep fixed
      gainNode.gain.setValueAtTime(0.0001, t);
      gainNode.gain.exponentialRampToValueAtTime(g * 0.6, t + 0.002);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + decay);
    } else {
      decay = Math.min(0.16, stepDuration * 0.40) * decayJitter;
      osc.frequency.setValueAtTime(800, t);
      osc.frequency.exponentialRampToValueAtTime(400, t + 0.01); // physical snap — keep fixed
      gainNode.gain.setValueAtTime(0.0001, t);
      gainNode.gain.exponentialRampToValueAtTime(g, t + 0.003);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + decay);
    }

    const stopTime = articulation === 'muffled'
      ? Math.min(0.12, stepDuration * 0.25)
      : Math.min(0.18, stepDuration * 0.45);

    // WaveShaper: tanh saturation adds odd harmonics → "wooden" skin character
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.createSaturationCurve();
    shaper.oversample = '2x';
    osc.connect(shaper);
    shaper.connect(gainNode);

    // Inharmonic overtone: ×2.76 ratio (non-integer → membrane resonance roughness)
    // Mixed at 15% of main gain; decays ~55% of fundamental length
    const overtoneFreqBase = articulation === 'muffled' ? 600 : 800;
    const overtoneOsc = ctx.createOscillator();
    const overtoneGain = ctx.createGain();
    overtoneOsc.type = 'sine';
    overtoneOsc.frequency.setValueAtTime(overtoneFreqBase * 2.76, t);
    overtoneOsc.detune.value = detuneCents;
    overtoneGain.gain.setValueAtTime(0.0001, t);
    overtoneGain.gain.exponentialRampToValueAtTime(g * 0.15, t + 0.003);
    overtoneGain.gain.exponentialRampToValueAtTime(0.001, t + decay * 0.55);
    const overtoneShaper = ctx.createWaveShaper();
    overtoneShaper.curve = this.createSaturationCurve();
    overtoneShaper.oversample = '2x';
    overtoneOsc.connect(overtoneShaper);
    overtoneShaper.connect(overtoneGain);

    const panner = ctx.createStereoPanner();
    panner.pan.value = -0.2;

    if (articulation === 'muffled') {
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 800;
      lpf.Q.value = 0.7;
      gainNode.connect(lpf);
      overtoneGain.connect(lpf);
      lpf.connect(panner);
    } else {
      gainNode.connect(panner);
      overtoneGain.connect(panner);
    }

    panner.connect(this.masterGainNode!);
    osc.start(t);
    osc.stop(t + stopTime);
    overtoneOsc.start(t);
    overtoneOsc.stop(t + stopTime * 0.65);

    // Attack transient: 10ms (extended from 8ms) for sharper fingertip impact
    this.playAttackNoise(ctx, t, g * (articulation === 'muffled' ? 0.15 : 0.4), 2500, 0.010);
  }

  /**
   * Güira: metallic scraper — bandpass noise at 10kHz ("air" frequency band)
   * Attack 1ms, Decay 20ms → tiny metallic "チッ" grain per 16th note
   * + Panned right 20% to separate from bongos
   */
  private synthGuira(ctx: AudioContext, time: number, gainMult = 1.0) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['guira'] * gainMult, time);
    const duration = 0.022; // 22ms total (attack 1ms + decay 20ms + margin)
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Bandpass at 10kHz: "air" band — metallic scrape character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 10000;
    filter.Q.value = 2.0; // narrow enough to cut below 8kHz and above 12kHz

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(g, t + 0.001);        // Attack 1ms
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.021); // Decay 20ms

    // Pan right 20%
    const panner = ctx.createStereoPanner();
    panner.pan.value = 0.2;

    src.connect(filter);
    filter.connect(env);
    env.connect(panner);
    panner.connect(this.masterGainNode!);
    src.start(t);

    // Metal contact transient: sharp "チッ" click of fingernail on metal scraper
    // Higher HPF (5kHz) than bongo — harder surface material
    this.playAttackNoise(ctx, t, g * 0.5, 5000);
  }

  /**
   * Bass accent (beat 4 & 8): sub-bass only — LPF at 200Hz cuts overlap with bongos.
   * Sine 80Hz → 50Hz gives a "地響き" (ground rumble) character.
   */
  private synthBass(ctx: AudioContext, time: number, gainMult = 1.0) {
    const { gain: g, time: t } = this.humanize(TRACK_GAIN['bass'] * gainMult, time);
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(80, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.15);
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(g, t + 0.003);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(gainNode);

    // LPF at 200Hz: sub-bass specialisation — removes frequency clash with bongos
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 200;
    lpf.Q.value = 0.7;

    gainNode.connect(lpf);
    lpf.connect(this.masterGainNode!);
    osc.start(t);
    osc.stop(t + 0.28);
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
