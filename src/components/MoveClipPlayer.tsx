import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  accentOf, BeatScheduler, countAtTime, cueAt, loopStep, prerollStart, rangeOf, VirtualClock,
  type Cue, type Timeline,
} from '../engine/practice';
import { practiceAudio } from '../engine/practiceAudio';
import { useOnHidden, usePracticePrefs, useVideoSource } from '../hooks/usePractice';
import { useWakeLock } from '../hooks/useWakeLock';
import { PracticeControls } from './PracticeBar';
import styles from './MoveClipPlayer.module.css';

type Props = {
  /** 元動画（HLS の playlist.m3u8 か mp4）。null・再生できないときはカウントだけで練習する */
  src: string | null;
  timeline: Timeline;
  /** 練習する技の範囲（routine.moves の位置。1 技なら同じ値） */
  from: number;
  to: number;
  /** 最初からループするか（1 技・範囲はループ、通し練習はしない） */
  loop: boolean;
  label: string;
  onClose: () => void;
  /** 今流れている技（行 index）が変わったら呼ぶ。カードを光らせ、画面をそこへ送るのに使う */
  onCurrent?: (rowIndex: number | null) => void;
};

/** video.play() は Promise を返さない環境（古いブラウザ・jsdom）がある */
function safePlay(v: HTMLVideoElement, onReject: () => void): void {
  try {
    const p = v.play() as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(onReject);
  } catch {
    onReject();
  }
}

const nowSec = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

/**
 * 練習プレイヤー。振付シートのカード 1 枚（その技だけ）・範囲（#3〜#6）・通し練習を同じ部品で流す。
 * - 速さ 0.5 / 0.75 / 1.0。カウント（1〜8）は動画の時刻から出すので、どの速さでもずれない
 * - カウントのクリック（On2 は 2 と 6 を強く）と、任意で声（"one, two, three … five, six, seven"）
 * - 頭から始めるときは 4 拍のカウントイン（5, 6, 7, 8）
 * - 次の技の名前を出し、1 拍前に目立たせる
 * - 動画が無い・再生できないときは、同じ時刻の流れを内部の時計で進めてカウントとカードの光だけで練習
 * - 画面が隠れたら（ロック・別アプリ）止める。音はタップで再開（iOS は操作の中でないと鳴らない）
 */
export function MoveClipPlayer({ src, timeline, from, to, loop: initialLoop, label, onClose, onCurrent }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const failed = useVideoSource(videoRef, src);
  const useVideo = !!src && !failed;
  const [prefs, setPrefs] = usePracticePrefs();
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [paused, setPaused] = useState<'hidden' | null>(null);
  const [loop, setLoop] = useState(initialLoop);
  const [count, setCount] = useState<number | null>(null);
  const [cue, setCue] = useState<Cue | null>(null);
  const [audioOk, setAudioOk] = useState(true);

  const range = useMemo(() => rangeOf(timeline, from, to), [timeline, from, to]);
  const [clock] = useState(() => new VirtualClock(nowSec));
  const clockRef = useRef(clock);

  // rAF・スケジューラから最新の値を読むための ref
  const live = useRef({ useVideo, playing, loop, prefs, range, timeline });
  useLayoutEffect(() => { live.current = { useVideo, playing, loop, prefs, range, timeline }; });
  const pendingSeek = useRef<number | null>(null);
  const lastTime = useRef(0);

  const getTime = useCallback((): number => {
    const v = videoRef.current;
    if (live.current.useVideo && v) return pendingSeek.current ?? v.currentTime;
    return clockRef.current.time();
  }, []);

  /** 音を鳴らしてよい（実際に時間が進んでいる）とき true */
  const running = useCallback((): boolean => {
    const v = videoRef.current;
    if (live.current.useVideo) return !!v && !v.paused && !v.seeking && v.readyState >= 3 && pendingSeek.current === null;
    return clockRef.current.playing;
  }, []);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    clockRef.current.seek(t);
    lastTime.current = t;
    if (live.current.useVideo && v) {
      if (v.readyState >= 1) {
        v.currentTime = t;
        pendingSeek.current = null;
      } else {
        pendingSeek.current = t;
      }
    }
  }, []);

  const play = useCallback(() => {
    const { useVideo: uv, prefs: p } = live.current;
    practiceAudio.unlock();
    if (p.voice) practiceAudio.primeVoice();
    setAudioOk(true);
    const v = videoRef.current;
    if (uv && v) {
      v.playbackRate = p.speed;
      v.muted = !p.videoSound;
      safePlay(v, () => {
        // 音ありの自動再生が止められた → 消音で再生し直す。それでもだめなら ▶ を押してもらう
        if (!v.muted) { v.muted = true; safePlay(v, () => setPlaying(false)); }
        else setPlaying(false);
      });
    } else {
      clockRef.current.setRate(p.speed);
      clockRef.current.play();
    }
    setPlaying(true);
    setPaused(null);
  }, []);

  const pause = useCallback(() => {
    videoRef.current?.pause();
    clockRef.current.pause();
    practiceAudio.silence();
    setPlaying(false);
  }, []);

  const restart = useCallback(() => {
    const r = live.current.range;
    if (!r) return;
    seek(prerollStart(live.current.timeline, r, !live.current.useVideo));
    setEnded(false);
    play();
  }, [seek, play]);

  // 開いたとき・範囲が変わったとき: カウントイン付きで頭から（カードを押した操作の中で開くので音も鳴る）
  useEffect(() => {
    // 動画・時計（外の仕組み）を動かすのが目的。再生中の印（state）はそのついで
    // eslint-disable-next-line react-hooks/set-state-in-effect
    restart();
  }, [from, to, restart]);

  // 動画のメタデータが来たら保留していたシークを当てる
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;
    const onMeta = () => {
      if (pendingSeek.current !== null) {
        v.currentTime = pendingSeek.current;
        pendingSeek.current = null;
      }
    };
    // 動画の終わりが区間の終わりより手前だったとき（rAF の区間判定に届かない）
    const onEnded = () => {
      const { range: r, loop: lp } = live.current;
      if (!r || !live.current.playing) return;
      if (lp) { seek(r.start); safePlay(v, () => setPlaying(false)); }
      else { pause(); setEnded(true); }
    };
    // ロック画面・ピクチャインピクチャ等、外から止められた
    const onPause = () => { if (!v.ended && !v.seeking && live.current.playing) { practiceAudio.silence(); setPlaying(false); } };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('ended', onEnded);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('pause', onPause);
    };
  }, [src, seek, pause]);

  // 動画が再生できなくなったら、その時刻から内部の時計で続ける（カウントだけの練習）
  useEffect(() => {
    if (!failed) return;
    const c = clockRef.current;
    c.seek(pendingSeek.current ?? lastTime.current);
    pendingSeek.current = null;
    c.setRate(live.current.prefs.speed);
    if (live.current.playing) c.play();
  }, [failed]);

  // 速さ・動画の音の切り替え
  useEffect(() => {
    clockRef.current.setRate(prefs.speed);
    const v = videoRef.current;
    if (v) v.playbackRate = prefs.speed;
  }, [prefs.speed]);
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = !prefs.videoSound;
  }, [prefs.videoSound]);
  useEffect(() => {
    if (prefs.voice) practiceAudio.primeVoice();
    else practiceAudio.silence();
  }, [prefs.voice]);

  // カウントの音: 少し先まで予約していく
  useEffect(() => {
    const sched = new BeatScheduler({
      timeline,
      clock: {
        mediaTime: () => (running() ? getTime() : null),
        rate: () => live.current.prefs.speed,
        end: () => live.current.range?.end ?? null,
      },
      sink: {
        now: () => practiceAudio.now(),
        click: (at, accent) => practiceAudio.click(at, accent),
        speak: (c, at) => practiceAudio.speak(c, at, live.current.prefs.speed),
      },
      clicks: () => live.current.prefs.clicks,
      voice: () => live.current.prefs.voice,
    });
    sched.start();
    return () => sched.stop();
  }, [timeline, running, getTime]);

  // 区間の終わり（ループ・おしまい）とカウント・次の技の表示（rAF で滑らかに）
  const onCurrentRef = useRef(onCurrent);
  useLayoutEffect(() => { onCurrentRef.current = onCurrent; });
  useEffect(() => {
    let raf = 0;
    let lastIdx: number | null = null;
    let lastCount = -1;
    let lastCueKey = '';
    let lastAudio = true;
    const tick = () => {
      const { range: r, loop: lp, playing: pl, prefs: p, timeline: tl } = live.current;
      const v = videoRef.current;
      if (r) {
        if (live.current.useVideo && v && v.playbackRate !== p.speed) v.playbackRate = p.speed;
        let t = getTime();
        if (pl && pendingSeek.current === null) {
          const step = loopStep(t, r, lp, tl.beatSec);
          if (step.seekTo !== null) { seek(step.seekTo); t = step.seekTo; }
          else if (step.done) { pause(); setEnded(true); }
        }
        lastTime.current = t;
        const c = countAtTime(tl, t);
        if (c !== lastCount) { lastCount = c; setCount(c); }
        const q = cueAt(tl, t, r, lp, 1);
        const key = `${q.current}/${q.next}/${q.soon}`;
        if (key !== lastCueKey) { lastCueKey = key; setCue(q); }
        const idx = q.current >= 0 ? tl.segs[q.current].index : null;
        if (idx !== null && idx !== lastIdx) { // 技の間・カウントイン中は前の光を残す
          lastIdx = idx;
          onCurrentRef.current?.(idx);
        }
        const ok = !p.clicks || !pl || practiceAudio.ready();
        if (ok !== lastAudio) { lastAudio = ok; setAudioOk(ok); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getTime, seek, pause]);

  // 画面が隠れたら止める（iOS はロック中に音の時計が止まり、戻ったときに拍がずれて一斉に鳴るため）
  useOnHidden(() => {
    if (!live.current.playing) return;
    pause();
    setPaused('hidden');
  });

  // 再生中は画面を消さない
  useWakeLock(playing);

  // 閉じたら声を止める
  useEffect(() => () => practiceAudio.silence(), []);

  const accentClass = (n: number) => {
    const a = accentOf(n, timeline.timing);
    return a === 'strong' ? styles.accent : undefined;
  };

  const segName = (i: number) => (i >= 0 ? `#${timeline.segs[i].no} ${timeline.segs[i].name}` : '');
  const multi = range ? range.last > range.first : false;

  if (!range) {
    return (
      <div className={styles.player}>
        <div className={styles.bar}>
          <span className={styles.label}>{label}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="再生を閉じる">✕</button>
        </div>
        <p className={styles.err}>この範囲には時刻がありません</p>
      </div>
    );
  }

  return (
    <div className={styles.player}>
      <div className={styles.bar}>
        <span className={styles.label}>{label}</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="再生を閉じる">✕</button>
      </div>
      <div className={`${styles.stage} ${useVideo ? '' : styles.countsOnly}`}>
        {src && (
          <video
            ref={videoRef}
            className={styles.video}
            hidden={!useVideo}
            muted={!prefs.videoSound}
            playsInline
            controls={false}
            preload="auto"
          />
        )}
        {!useVideo && count !== null && (
          <div className={styles.bigCount} aria-hidden="true">
            <span className={accentClass(count) ?? ''}>{count}</span>
          </div>
        )}
        {multi && cue && (
          <div className={styles.cue}>
            {cue.current >= 0 && <span className={styles.now}>{segName(cue.current)}</span>}
            {cue.next >= 0 && (
              <span className={`${styles.next} ${cue.soon ? styles.soon : ''}`} data-testid="practice-next">
                次: {timeline.segs[cue.next].name}
              </span>
            )}
          </div>
        )}
        {count !== null && (
          <div className={styles.count} aria-live="off">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className={i + 1 === count ? styles.on : accentClass(i + 1)}>
                {i + 1}
              </span>
            ))}
          </div>
        )}
        {ended && (
          <button type="button" className={styles.overlayBtn} onClick={restart}>おわり — ▶ もう一度</button>
        )}
        {!ended && paused === 'hidden' && (
          <button type="button" className={styles.overlayBtn} onClick={play}>止めました — ▶ 続きから</button>
        )}
        {!ended && !paused && !audioOk && (
          <button type="button" className={styles.audioBtn} onClick={() => { practiceAudio.unlock(); setAudioOk(true); }}>
            🔈 タップで音を出す
          </button>
        )}
      </div>
      {!useVideo && src && <p className={styles.note}>動画を再生できないため、カウントだけで練習します</p>}
      <PracticeControls
        prefs={prefs}
        onPrefs={patch => {
          // 音・声の ON は操作の中で準備する（iOS）
          if (patch.clicks || patch.voice) practiceAudio.unlock();
          if (patch.voice) practiceAudio.primeVoice();
          setPrefs(patch);
        }}
        playing={playing}
        onPlayPause={() => (playing ? pause() : ended ? restart() : play())}
        onRestart={restart}
        loop={loop}
        onLoop={v => { setLoop(v); if (v) setEnded(false); }}
        hasVideo={useVideo}
        voiceAvailable={practiceAudio.voiceAvailable()}
      />
    </div>
  );
}
