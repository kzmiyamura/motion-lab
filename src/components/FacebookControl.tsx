import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  extractFacebookVideoId, isFacebookUrl, makeFacebookClock, mountFacebookVideo, normalizeFacebookUrl,
  type FbPlayerLike,
} from '../engine/facebookPlayer';
import type { YtPlayerLike } from '../engine/tabShare';
import { TabShareAnalyzer } from './TabShareAnalyzer';
import styles from './FacebookControl.module.css';

const HISTORY_KEY = 'motionlab:fb-history';
const MAX_HISTORY = 10;
const NOT_EMBEDDABLE = '公開設定の動画だけ再生できます（ログイン不要）';

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_HISTORY) : [];
  } catch { return []; }
}

function saveHistory(url: string, prev: string[]): string[] {
  const next = [url, ...prev.filter((u) => u !== url)].slice(0, MAX_HISTORY);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

interface Props { bpm: number }

/** Facebook の公開動画を URL で埋め込み再生し、骨格解析（タブ共有）まで使えるタブ。ログインはしない */
export function FacebookControl({ bpm }: Props) {
  const [input, setInput] = useState('');
  const [href, setHref] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [muted, setMuted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const fbRef = useRef<FbPlayerLike | null>(null);
  const playingRef = useRef(false);
  const adapterRef = useRef<YtPlayerLike | null>(null);

  const clock = useMemo(
    () => makeFacebookClock(() => fbRef.current, () => playingRef.current),
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !href) return;
    setStatus('loading');
    setPlaying(false); playingRef.current = false;
    setLoopA(null); setLoopB(null); setLoopOn(false); setTime(0); setMuted(false);
    const cleanup = mountFacebookVideo(el, href, el.clientWidth || 480, {
      onReady: (p) => {
        fbRef.current = p;
        adapterRef.current = {
          getCurrentTime: () => p.getCurrentPosition(),
          getDuration: () => p.getDuration(),
          getPlayerState: () => (playingRef.current ? 1 : 2),
          getPlaybackRate: () => 1,
          seekTo: (t) => p.seek(t),
        };
        setStatus('ready');
      },
      onPlaying: (v) => { playingRef.current = v; setPlaying(v); },
      onFailed: () => setStatus('failed'),
    });
    return () => {
      cleanup();
      fbRef.current = null;
      adapterRef.current = null;
    };
  }, [href]);

  // TabShareAnalyzer には常に最新のアダプタを見せる（読み取り専用の ref）
  const playerRef = useMemo(
    () => ({ get current() { return adapterRef.current; } }) as RefObject<YtPlayerLike | null>,
    [],
  );

  const withPlayer = useCallback((f: (p: FbPlayerLike) => void) => {
    const p = fbRef.current;
    if (!p) return;
    try { f(p); } catch { /* ignore */ }
  }, []);

  const seekBy = useCallback((d: number) => withPlayer((p) => {
    p.seek(Math.max(0, p.getCurrentPosition() + d));
  }), [withPlayer]);

  // 現在時刻の表示 + 区間ループ（200ms ごとに getCurrentPosition を見て B を越えたら A へ seek）
  useEffect(() => {
    if (status !== 'ready') return;
    const id = window.setInterval(() => {
      const p = fbRef.current;
      if (!p) return;
      try {
        const t = p.getCurrentPosition();
        if (!Number.isFinite(t)) return;
        setTime(t);
        if (loopOn && loopA !== null && loopB !== null && loopB > loopA && t >= loopB) {
          p.seek(loopA);
        }
      } catch { /* ignore */ }
    }, 200);
    return () => window.clearInterval(id);
  }, [status, loopOn, loopA, loopB]);

  const load = useCallback((raw: string) => {
    const url = normalizeFacebookUrl(raw);
    if (!url) return;
    setInput(raw);
    setHistory((prev) => saveHistory(url, prev));
    setHref(url);
  }, []);

  const toggleMute = useCallback(() => withPlayer((p) => {
    if (muted) p.unmute(); else p.mute();
    setMuted(!muted);
  }), [withPlayer, muted]);

  const getIframe = useCallback(
    () => containerRef.current?.querySelector('iframe') ?? null,
    [],
  );

  const videoId = href ?? '';
  const fbId = href ? extractFacebookVideoId(href) : null;
  const ready = status === 'ready';
  const looksWrong = input.trim() !== '' && !isFacebookUrl(input);

  return (
    <div className={styles.wrapper}>
      <div className={styles.urlRow}>
        <input
          className={styles.urlInput}
          type="url"
          inputMode="url"
          placeholder="Facebook の動画 URL（facebook.com/watch?v=…, /videos/…, fb.watch/…, /reel/…）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(input); }}
        />
        <button className={styles.loadBtn} onClick={() => load(input)} disabled={!input.trim()}>読み込む</button>
      </div>
      {looksWrong && <p className={styles.note}>Facebook の URL ではなさそうです（そのまま試すこともできます）。</p>}

      {history.length > 0 && (
        <div className={styles.history}>
          {history.map((u) => (
            <button key={u} className={styles.historyBtn} onClick={() => load(u)} title={u}>{u.replace(/^https?:\/\/(www\.)?/, '')}</button>
          ))}
        </div>
      )}

      <div className={styles.playerBox} style={{ display: href ? undefined : 'none' }}>
        <div ref={containerRef} className={styles.fbContainer} />
      </div>
      {status === 'loading' && <p className={styles.note}>読み込み中…</p>}
      {status === 'failed' && <p className={styles.error}>{NOT_EMBEDDABLE}</p>}

      {href && (
        <div className={styles.controls}>
          <div className={styles.row}>
            <button className={styles.btn} disabled={!ready} onClick={() => withPlayer((p) => (playing ? p.pause() : p.play()))}>
              {playing ? '⏸ 停止' : '▶ 再生'}
            </button>
            {[-5, -1, 1, 5].map((d) => (
              <button key={d} className={styles.btn} disabled={!ready} onClick={() => seekBy(d)}>
                {d > 0 ? `+${d}` : d}秒
              </button>
            ))}
            <button className={styles.btn} disabled={!ready} onClick={toggleMute}>{muted ? '🔇' : '🔊'}</button>
            <span className={styles.time}>{fmt(time)}</span>
          </div>
          <div className={styles.row}>
            <button className={styles.btn} disabled={!ready} onClick={() => setLoopA(time)}>A {loopA === null ? '—' : fmt(loopA)}</button>
            <button className={styles.btn} disabled={!ready} onClick={() => setLoopB(time)}>B {loopB === null ? '—' : fmt(loopB)}</button>
            <button
              className={`${styles.btn} ${loopOn ? styles.btnActive : ''}`}
              disabled={!ready || loopA === null || loopB === null || loopB <= loopA}
              onClick={() => setLoopOn((v) => !v)}
            >🔁 ループ</button>
            <button className={styles.btn} disabled={loopA === null && loopB === null} onClick={() => { setLoopA(null); setLoopB(null); setLoopOn(false); }}>解除</button>
          </div>
          <p className={styles.note}>Facebook のプレイヤーには再生速度の API が無いため、スロー再生は使えません。公開設定の動画だけ再生できます（ログイン不要）。</p>
        </div>
      )}

      {href && (
        <TabShareAnalyzer
          bpm={bpm}
          videoId={videoId}
          playerRef={playerRef}
          getIframe={getIframe}
          clock={clock}
          sourceLabel="Facebook"
          exportVideoId={fbId ?? href}
          fileLabel={`fb_${fbId ?? 'video'}`}
        />
      )}
    </div>
  );
}
