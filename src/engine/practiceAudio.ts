import type { Accent } from './practice';

/**
 * 練習モードのカウントの音（クリック）と声。
 *
 * リズムマシン（AudioEngine）のスケジューラとは別の小さな AudioContext を使う。
 * AudioEngine は自分の BPM で拍を刻む作りで、動画の時刻に合わせて鳴らす用途には向かないため。
 *
 * iOS Safari:
 * - AudioContext は利用者の操作（タップ）の中で作る・resume しないと鳴らない → unlock() をタップの処理で呼ぶ
 * - 画面ロック・電話で 'interrupted' / 'suspended' になる。次のタップで unlock() すれば戻る。
 *   resume() が返ってこないことがあるので、前回の unlock でも戻らなかったら作り直す
 * - 消音スイッチ: navigator.audioSession.type = 'playback'（iOS 17+）なら Web Audio も鳴る
 * - 声（speechSynthesis）は最初の 1 回を操作の中で喋らせないと、以後も喋らない
 */

type Level = { freq: number; gain: number; len: number };

const LEVELS: Record<Accent, Level> = {
  strong: { freq: 1760, gain: 0.9, len: 0.06 },
  head: { freq: 1320, gain: 0.55, len: 0.05 },
  weak: { freq: 990, gain: 0.32, len: 0.04 },
  ghost: { freq: 990, gain: 0.12, len: 0.03 },
};

const WORDS: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' };

/** 声は出るまで遅れる（iOS で 0.1〜0.3 秒）。少し早めに喋らせる */
const VOICE_LEAD_SEC = 0.12;

type AudioSessionLike = { type?: string };

class PracticeAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private pendingResume = false;
  private voiceTimers = new Set<ReturnType<typeof setTimeout>>();
  private voicePrimed = false;
  private enVoice: SpeechSynthesisVoice | null = null;

  /** タップの処理の中で呼ぶ。音の準備（作成・再開・iOS の解錠） */
  unlock(): void {
    const Ctor = typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
    if (!Ctor) return;
    try {
      const session = (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
      if (session && session.type !== 'playback') session.type = 'playback';
    } catch { /* 古い iOS */ }
    // 前回 resume を頼んだのにまだ動いていない（iOS のスリープ明け）→ 作り直す（操作の中なのですぐ running になる）
    if (this.ctx && this.ctx.state !== 'running' && this.pendingResume) {
      try { void this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
      this.master = null;
    }
    if (!this.ctx) {
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      this.pendingResume = true;
      ctx.resume().then(() => { this.pendingResume = false; }).catch(() => { /* 次のタップで作り直す */ });
    } else {
      this.pendingResume = false;
    }
    // iOS: 操作の中で何か鳴らすと出力が開く（無音の 1 サンプル）
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch { /* テスト環境など */ }
  }

  /** 鳴らせる状態か */
  ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** 音の時計（秒）。鳴らせないときは null */
  now(): number | null {
    return this.ready() ? this.ctx!.currentTime : null;
  }

  click(at: number, accent: Accent): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master) return;
    const lv = LEVELS[accent];
    try {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = accent === 'strong' ? 'square' : 'sine';
      osc.frequency.setValueAtTime(lv.freq, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(accent === 'strong' ? lv.gain * 0.5 : lv.gain, at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + lv.len);
      osc.connect(g);
      g.connect(master);
      osc.start(at);
      osc.stop(at + lv.len + 0.01);
    } catch { /* noop */ }
  }

  voiceAvailable(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  /** 声を ON にしたタップの中で呼ぶ（iOS は最初の発話が操作の中でないと以後も喋らない） */
  primeVoice(): void {
    if (!this.voiceAvailable() || this.voicePrimed) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      this.voicePrimed = true;
    } catch { /* noop */ }
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.enVoice) return this.enVoice;
    try {
      const vs = window.speechSynthesis.getVoices();
      this.enVoice = vs.find(v => /^en[-_]US/i.test(v.lang)) ?? vs.find(v => /^en/i.test(v.lang)) ?? null;
    } catch { /* noop */ }
    return this.enVoice;
  }

  /**
   * at（音の時計）に count を喋る。speechSynthesis は時刻を指定できないので setTimeout で。
   * rate は再生速度（遅いほどゆっくり喋る）
   */
  speak(count: number, at: number, rate: number): void {
    if (!this.voiceAvailable() || !this.ctx) return;
    const delay = Math.max(0, (at - this.ctx.currentTime - VOICE_LEAD_SEC) * 1000);
    const id = setTimeout(() => {
      this.voiceTimers.delete(id);
      try {
        const synth = window.speechSynthesis;
        if (synth.speaking || synth.pending) synth.cancel(); // 溜めない（遅れた声は捨てる）
        const u = new SpeechSynthesisUtterance(WORDS[count] ?? String(count));
        u.lang = 'en-US';
        const v = this.pickVoice();
        if (v) u.voice = v;
        u.rate = Math.min(2, 1.1 + rate * 0.6);
        u.volume = 1;
        synth.speak(u);
      } catch { /* noop */ }
    }, delay);
    this.voiceTimers.add(id);
  }

  /** 止めたとき: 予約済みの声を捨てる（クリックは数十 ms 先までしか予約しないので放っておく） */
  silence(): void {
    this.voiceTimers.forEach(id => clearTimeout(id));
    this.voiceTimers.clear();
    try { if (this.voiceAvailable()) window.speechSynthesis.cancel(); } catch { /* noop */ }
  }
}

export const practiceAudio = new PracticeAudio();
