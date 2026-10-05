/**
 * Facebook Embedded Video Player API（JS SDK）のラッパーと、URL まわりの純粋関数。
 * 公開動画だけ埋め込める。再生速度を変える API は無い。
 */

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';

/** FB の動画プレイヤー（Embedded Video Player API）のうち使うメソッド */
export interface FbPlayerLike {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getCurrentPosition(): number;
  getDuration(): number;
  mute(): void;
  unmute(): void;
  isMuted?(): boolean;
  subscribe?(event: string, cb: (...args: unknown[]) => void): { release?: () => void } | undefined;
}

// ───────────── URL（純粋関数） ─────────────

const FB_HOST_RE = /^(?:www\.|m\.|web\.|mbasic\.|touch\.|business\.)?facebook\.com$/i;

function parseUrl(input: string): URL | null {
  const s = input.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try { return new URL(withScheme); } catch { return null; }
}

/** Facebook / fb.watch の URL か */
export function isFacebookUrl(input: string): boolean {
  const u = parseUrl(input);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  return FB_HOST_RE.test(h) || h === 'fb.watch' || h === 'fb.com';
}

/** 動画 ID（取れなければ null）。watch?v= / /videos/<id> / /reel/<id> / /watch/<id> に対応 */
export function extractFacebookVideoId(input: string): string | null {
  const u = parseUrl(input);
  if (!u || !isFacebookUrl(input)) return null;
  const v = u.searchParams.get('v');
  if (v && /^\d+$/.test(v)) return v;
  const m = u.pathname.match(/\/(?:videos|reel|reels|watch)\/(?:[^/]+\/)?(\d{5,})/);
  return m ? m[1] : null;
}

/**
 * data-href に渡す URL に整える。
 * - m. / web. / mbasic. は www に寄せる、スキームが無ければ https:// を補う
 * - watch?v=ID は https://www.facebook.com/watch/?v=ID に、/reel/ID は https://www.facebook.com/reel/ID に
 * - fb.watch と /videos/ はホストだけ整えてそのまま
 * - 不明な形・URL でない文字列は trim しただけでそのまま返す
 */
export function normalizeFacebookUrl(input: string): string {
  const raw = input.trim();
  const u = parseUrl(raw);
  if (!u || !isFacebookUrl(raw)) return raw;
  const host = u.hostname.toLowerCase();
  if (host === 'fb.watch') return `https://fb.watch${u.pathname}`;
  const v = u.searchParams.get('v');
  if (/^\/watch\/?$/.test(u.pathname) && v && /^\d+$/.test(v)) {
    return `https://www.facebook.com/watch/?v=${v}`;
  }
  const reel = u.pathname.match(/^\/reels?\/(\d+)/);
  if (reel) return `https://www.facebook.com/reel/${reel[1]}`;
  if (/\/videos\//.test(u.pathname)) {
    return `https://www.facebook.com${u.pathname}`;
  }
  return raw;
}

// ───────────── 時計（YouTube の makeYouTubeClock と同じ形） ─────────────

const MAX_EXTRAPOLATE_SEC = 1.0;

/**
 * FB プレイヤーの再生位置を読む時計。値が変わらない間は「最後に変わった時刻 + 経過」で補間する。
 * 再生速度は変えられないので常に等倍。停止中・時刻が戻ったとき（シーク/ループ）は生の値を返す。
 */
export function makeFacebookClock(
  getPlayer: () => Pick<FbPlayerLike, 'getCurrentPosition'> | null,
  isPlaying: () => boolean,
  now: () => number = () => performance.now(),
): () => number {
  let lastRaw = NaN;
  let lastAt = 0;
  return () => {
    const p = getPlayer();
    if (!p) return NaN;
    let raw: number;
    try { raw = p.getCurrentPosition(); } catch { return NaN; }
    if (!Number.isFinite(raw)) return NaN;
    const t = now();
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastAt = t;
      return raw;
    }
    if (!isPlaying()) return raw;
    const dt = Math.min((t - lastAt) / 1000, MAX_EXTRAPOLATE_SEC);
    return raw + Math.max(0, dt);
  };
}

// ───────────── SDK ─────────────

interface FbGlobal {
  init(opts: { xfbml: boolean; version: string }): void;
  XFBML: { parse(el?: Element): void };
  Event: {
    subscribe(event: string, cb: (msg: unknown) => void): void;
    unsubscribe(event: string, cb: (msg: unknown) => void): void;
  };
}
type FbWindow = Window & { FB?: FbGlobal; fbAsyncInit?: () => void };

let sdkPromise: Promise<FbGlobal> | null = null;
let sdkInitialized = false;
/** init（xfbml:true で自動解析が走る）より前に購読したいものを溜める */
const preInit: Array<(fb: FbGlobal) => void> = [];

/**
 * SDK を一度だけ動的ロードする（失敗したら次回やり直せるよう破棄）。
 * ログインはしない: appId なし・xfbml:true と version だけで init する。
 * beforeInit は init の直前（初回ロード時のみ）に呼ばれ、自動解析の xfbml.ready を取りこぼさないために使う。
 */
export function loadFacebookSdk(beforeInit?: (fb: FbGlobal) => void): Promise<FbGlobal> {
  const w = window as FbWindow;
  if (sdkInitialized && w.FB) return Promise.resolve(w.FB);
  if (beforeInit) preInit.push(beforeInit);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FbGlobal>((resolve, reject) => {
    w.fbAsyncInit = () => {
      if (!w.FB) { reject(new Error('FB SDK not available')); return; }
      preInit.splice(0).forEach((f) => f(w.FB!));
      w.FB.init({ xfbml: true, version: 'v19.0' });
      sdkInitialized = true;
      resolve(w.FB);
    };
    const s = document.createElement('script');
    s.src = SDK_SRC;
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => { s.remove(); reject(new Error('FB SDK load failed')); };
    document.head.appendChild(s);
  }).catch((e) => { sdkPromise = null; throw e; });
  return sdkPromise;
}

export interface FbMountHandlers {
  onReady(player: FbPlayerLike): void;
  onPlaying(playing: boolean): void;
  onEnded?(): void;
  /** SDK が読めない・動画が一定時間出てこない（非公開など） */
  onFailed(reason: 'sdk' | 'timeout'): void;
}

const READY_TIMEOUT_MS = 10000;
let mountSeq = 0;

/** container に fb-video を作って XFBML 解析する。戻り値は後片付け */
export function mountFacebookVideo(
  container: HTMLElement,
  href: string,
  width: number,
  h: FbMountHandlers,
): () => void {
  let disposed = false;
  const handles: Array<{ release?: () => void } | undefined> = [];
  let timer: number | undefined;
  let fb: FbGlobal | null = null;
  let readyCb: ((msg: unknown) => void) | null = null;

  const id = `fbv-${++mountSeq}`;
  container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'fb-video';
  div.id = id;
  div.setAttribute('data-href', href);
  div.setAttribute('data-allowfullscreen', 'true');
  div.setAttribute('data-width', String(Math.max(220, Math.round(width))));
  div.setAttribute('data-show-text', 'false');
  container.appendChild(div);

  let attached = false;
  const attach = (FB: FbGlobal) => {
    if (attached || disposed) return;
    attached = true;
    fb = FB;
    readyCb = (msg: unknown) => {
      const m = msg as { type?: string; id?: string; instance?: FbPlayerLike };
      if (m.type !== 'video' || m.id !== id || !m.instance) return;
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
      const p = m.instance;
      handles.push(p.subscribe?.('startedPlaying', () => h.onPlaying(true)));
      handles.push(p.subscribe?.('paused', () => h.onPlaying(false)));
      handles.push(p.subscribe?.('finishedPlaying', () => { h.onPlaying(false); h.onEnded?.(); }));
      h.onReady(p);
    };
    FB.Event.subscribe('xfbml.ready', readyCb);
    timer = window.setTimeout(() => { if (!disposed) h.onFailed('timeout'); }, READY_TIMEOUT_MS);
  };

  loadFacebookSdk(attach).then((FB) => {
    if (disposed) return;
    const wasAttached = attached;
    attach(FB);
    // 初回ロードは init の自動解析に任せる。ロード済みのときだけ明示的に解析する
    if (!wasAttached) FB.XFBML.parse(container);
  }).catch(() => { if (!disposed) h.onFailed('sdk'); });

  return () => {
    disposed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    if (fb && readyCb) { try { fb.Event.unsubscribe('xfbml.ready', readyCb); } catch { /* ignore */ } }
    handles.forEach((x) => { try { x?.release?.(); } catch { /* ignore */ } });
    container.innerHTML = '';
  };
}
