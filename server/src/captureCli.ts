/**
 * 録画まわりの手動操作用コマンド。
 *
 *   npm run capture:login           — 録画用の Chrome を画面付きで開く。Facebook 等に人がログインして閉じる
 *   npm run capture:test -- <URL>   — 1本だけ録画して storage/capture-test/ に保存する（動作確認用）
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureVideo, openCaptureContext } from './capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [cmd, url] = process.argv.slice(2);

if (cmd === 'login') {
  const context = await openCaptureContext(false);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://www.facebook.com/');
  console.log('開いたブラウザでログインしてから、ブラウザのウィンドウを閉じてください。');
  await new Promise<void>(resolve => context.on('close', () => resolve()));
  console.log('ログイン情報を保存しました。');
} else if (cmd === 'test' && url) {
  const outDir = path.resolve(__dirname, '../storage/capture-test');
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `capture_${Date.now()}.mp4`);
  const started = Date.now();
  const result = await captureVideo(url, out);
  console.log(JSON.stringify({ ...result, out, elapsedSec: (Date.now() - started) / 1000 }, null, 2));
} else {
  console.error('usage: captureCli.ts login | test <URL>');
  process.exit(1);
}
