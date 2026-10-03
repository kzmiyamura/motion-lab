/**
 * タブ共有（画面キャプチャ）で YouTube を骨格解析するための純粋ロジック。
 * DOM / React に依存しない部分だけを置き、単体テストできるようにする。
 */
import type { SequenceEvent } from '../hooks/usePoseEstimation';

/** YouTube IFrame API の YT.Player のうち、ここで使うメソッドだけ（すべて同期） */
export interface YtPlayerLike {
  getCurrentTime(): number;
  getPlaybackRate?(): number;
  getPlayerState?(): number;   // 1 = 再生中
  getDuration?(): number;
  getIframe?(): HTMLIFrameElement;
  getVideoData?(): { title?: string; video_id?: string };
  seekTo?(seconds: number, allowSeekAhead: boolean): void;
}

/** 補間の上限（秒）。プレイヤーからの時刻更新がこれ以上途絶えたら補間をやめる */
const MAX_EXTRAPOLATE_SEC = 1.0;

/**
 * YouTube プレイヤーの再生位置を読む時計。
 * IFrame API の getCurrentTime() は postMessage 経由で間欠的にしか更新されないため、
 * 値が変わっていない間は「最後に変わった時刻 + 経過時間 × 再生速度」で補間する。
 * 一時停止中・時刻が戻った（ループ/シーク）ときは生の値をそのまま返す。
 */
export function makeYouTubeClock(
  getPlayer: () => YtPlayerLike | null,
  now: () => number = () => performance.now(),
): () => number {
  let lastRaw = NaN;
  let lastAt = 0;
  return () => {
    const p = getPlayer();
    if (!p) return NaN;
    const raw = p.getCurrentTime();
    if (!Number.isFinite(raw)) return NaN;
    const t = now();
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastAt = t;
      return raw;
    }
    const playing = (p.getPlayerState?.() ?? 1) === 1;
    if (!playing) return raw;
    const rate = p.getPlaybackRate?.() ?? 1;
    const dt = Math.min((t - lastAt) / 1000, MAX_EXTRAPOLATE_SEC);
    return raw + Math.max(0, dt) * (Number.isFinite(rate) && rate > 0 ? rate : 1);
  };
}

export interface TabShareExport {
  videoId: string;
  title?: string;
  playbackRate: number;
  createdAt: string;
  events: Array<{ t: number; action: string; quality: number; beatNum?: number }>;
}

/** JSON 書き出し用のオブジェクトを作る。t は YouTube の再生位置（秒、小数3桁） */
export function buildTabShareExport(args: {
  videoId: string;
  title?: string;
  playbackRate: number;
  createdAt: Date;
  events: SequenceEvent[];
}): TabShareExport {
  const out: TabShareExport = {
    videoId: args.videoId,
    playbackRate: args.playbackRate,
    createdAt: args.createdAt.toISOString(),
    events: [...args.events]
      .sort((a, b) => a.time - b.time)
      .map((e) => {
        const ev: TabShareExport['events'][number] = {
          t: Math.round(e.time * 1000) / 1000,
          action: e.action,
          quality: Math.round(e.quality * 1000) / 1000,
        };
        if (e.beatNum !== undefined) ev.beatNum = e.beatNum;
        return ev;
      }),
  };
  if (args.title) out.title = args.title;
  return out;
}

/** 書き出しファイル名: tabshare_<videoId>_<timestamp>.json */
export function tabShareFileName(videoId: string, date: Date): string {
  return `tabshare_${videoId}_${date.toISOString().replace(/[:.]/g, '-')}.json`;
}
