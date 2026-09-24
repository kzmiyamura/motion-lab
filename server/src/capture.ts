/// <reference lib="dom" />
// ↑ recordLargestVideoInPage はブラウザ内で実行されるため DOM の型が要る
/**
 * URL の動画（Facebook リール等）をブラウザで再生しながら録画する。
 *
 * 画面全体を録るのではなく、ページ内の <video> 要素を captureStream() で直接録画する。
 * 元動画の解像度のまま・ボタン類の映り込み無し・音声付き（ビート解析に使える）で録れる。
 * iPhone で画面録画していた作業の自動化にあたる（私的な練習用。公開・共有はしない前提）。
 *
 * ブラウザはこの PC の Chrome を使い、プロファイルは storage/capture-profile に固定する。
 * ログインが必要な場合は、一度だけ `npm run capture:login` で人がログインしておく
 * （パスワードをプログラムに持たせない）。
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';
import ffmpegPathImport from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURE_PROFILE_DIR = path.resolve(__dirname, '../storage/capture-profile');
const CHROME_PATH = process.env.CAPTURE_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ffmpegPath = ffmpegPathImport as unknown as string | null;

const VIDEO_WAIT_MS = 30_000;          // ページに <video> が現れるまでの最大待ち
const MAX_RECORD_SEC = 10 * 60;        // 1本の録画の上限（ループし続ける動画の保険）
const VIDEO_BITRATE = 12_000_000;      // 録画のビットレート（元画質を落とさない程度に高め）

export class CaptureError extends Error {}

export interface CaptureResult {
  title: string;
  durationSec: number;
  width: number;
  height: number;
}

export async function openCaptureContext(headless: boolean): Promise<BrowserContext> {
  if (!existsSync(CAPTURE_PROFILE_DIR)) mkdirSync(CAPTURE_PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(CAPTURE_PROFILE_DIR, {
    executablePath: CHROME_PATH,
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
}

/**
 * url の動画を録画して outMp4Path に H.264/AAC の mp4 で保存する。
 * 途中の webm は同じディレクトリに一時保存し、変換後に消す。
 */
export async function captureVideo(url: string, outMp4Path: string, signal?: AbortSignal): Promise<CaptureResult> {
  const webmPath = outMp4Path.replace(/\.mp4$/, '.webm');
  const context = await openCaptureContext(true);
  const file = createWriteStream(webmPath);
  let writeChain: Promise<void> = Promise.resolve();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    // ページ側の MediaRecorder から、録画データを少しずつ受け取ってファイルに追記する
    await page.exposeFunction('__mlCaptureChunk', (dataUrl: string) => {
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      writeChain = writeChain.then(() => new Promise<void>((resolve, reject) => {
        file.write(Buffer.from(b64, 'base64'), err => (err ? reject(err) : resolve()));
      }));
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.waitForSelector('video', { timeout: VIDEO_WAIT_MS });
    } catch {
      throw new CaptureError('ページに動画が見つかりませんでした（ログインが必要な動画の可能性があります）');
    }
    signal?.throwIfAborted();

    const result = await page.evaluate(recordLargestVideoInPage, { bitrate: VIDEO_BITRATE, maxSec: MAX_RECORD_SEC });
    if ('error' in result) throw new CaptureError(result.error);
    await writeChain;
    await new Promise<void>(resolve => file.end(resolve));
    await transcodeToMp4(webmPath, outMp4Path, signal);
    return result;
  } finally {
    if (!file.closed) file.destroy();
    await context.close().catch(() => {});
    await rm(webmPath, { force: true }).catch(() => {});
  }
}

/**
 * ページ内で実行する録画処理（page.evaluate に渡すので外部の変数は参照できない）。
 * いちばん大きく表示されている <video> を先頭から1周だけ録画する。
 */
async function recordLargestVideoInPage(
  opts: { bitrate: number; maxSec: number },
): Promise<CaptureResult | { error: string }> {
  type CapturableVideo = HTMLVideoElement & { captureStream(): MediaStream };
  const send = (window as unknown as { __mlCaptureChunk(d: string): Promise<void> }).__mlCaptureChunk;

  // 動画のメタデータ（長さ・解像度）が読めるまで待つ
  const deadline = Date.now() + 30_000;
  let video: CapturableVideo | null = null;
  while (Date.now() < deadline) {
    const vids = Array.from(document.querySelectorAll('video')) as CapturableVideo[];
    const ready = vids.filter(v => v.readyState >= 1 && v.videoWidth > 0);
    if (ready.length > 0) {
      video = ready.reduce((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return rb.width * rb.height > ra.width * ra.height ? b : a;
      });
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!video) return { error: '動画を読み込めませんでした（ログインが必要な動画の可能性があります）' };

  const v = video;
  v.loop = false;
  v.pause();
  v.currentTime = 0;
  await new Promise(r => setTimeout(r, 500));

  const stream = v.captureStream();
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate });
  let sendChain: Promise<void> = Promise.resolve();
  rec.ondataavailable = e => {
    if (e.data.size === 0) return;
    const blob = e.data;
    sendChain = sendChain.then(() => new Promise<void>(resolve => {
      const reader = new FileReader();
      reader.onload = () => { void send(reader.result as string).then(() => resolve()); };
      reader.readAsDataURL(blob);
    }));
  };
  const stopped = new Promise<void>(resolve => { rec.onstop = () => resolve(); });

  rec.start(1000);
  await v.play();
  // 1周したら止める: ended、または先頭へ巻き戻った（サイト側がループさせた）とき
  await new Promise<void>(resolve => {
    let last = v.currentTime;
    const started = Date.now();
    const timer = setInterval(() => {
      const wrapped = v.currentTime + 1 < last;
      last = v.currentTime;
      if (v.ended || wrapped || (Date.now() - started) / 1000 > opts.maxSec) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
  rec.stop();
  await stopped;
  await sendChain;
  const title = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null)?.content
    || document.title || 'video';
  return { title, durationSec: v.duration, width: v.videoWidth, height: v.videoHeight };
}

/** MediaRecorder の webm は可変フレームレートなので、解析しやすい 30fps 固定の mp4 にする */
function transcodeToMp4(webmPath: string, mp4Path: string, signal?: AbortSignal): Promise<void> {
  if (!ffmpegPath) throw new CaptureError('ffmpeg が見つかりません');
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-y', '-i', webmPath, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4Path,
    ], { signal });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', code => (code === 0 ? resolve() : reject(new CaptureError(`mp4 変換に失敗: ${stderr.slice(-500)}`))));
  });
}
