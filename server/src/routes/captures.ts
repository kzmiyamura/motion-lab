/**
 * URL からの動画取り込み（Facebook リール等の再生を録画して保存する）。
 *
 *   POST /api/captures/login { password }   → 200 / 401   パスワードの確認だけ（アプリの取込タブが使う）
 *   POST /api/captures  { url, folderId? } → 202 { id }   順番待ちに積む
 *   GET  /api/captures                     → { captures }  直近50件の状態
 *
 * 録画はログイン済みの Facebook アカウントでブラウザを動かすので、公開 URL から誰でも
 * 叩けてはいけない。全エンドポイントを固定パスワード（server/.env の CAPTURE_PASSWORD）で守る。
 * パスワードはサーバーだけが持ち、アプリには埋め込まない（X-Capture-Password ヘッダで毎回送る）。
 * 未設定なら機能ごと閉じる。
 *
 * 録画は1本ずつ。解析ジョブ中はメモリと CPU を取り合うので待つ。
 * 短時間に続けて開くとアカウントが制限されることがあるので、1本ごとに間を空ける。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireWriteToken } from '../auth.js';
import {
  claimNextCapture, insertCapture, listCaptures, listFolders, markCaptureDone, markCaptureError,
  recoverStaleCaptures, type CaptureRow,
} from '../db.js';
import { captureVideo } from '../capture.js';
import { isAnalysisRunning } from '../analysisJob.js';
import { isJobWorkerBusy } from '../jobWorker.js';
import { ORIGINALS_DIR, registerUploadedVideo } from './videos.js';

const POLL_MS = 10_000;
const GAP_BETWEEN_CAPTURES_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;
const ALLOWED_HOSTS = /(^|\.)(facebook\.com|fb\.watch)$/;

function toPublicCapture(row: CaptureRow) {
  return {
    id: row.id,
    url: row.url,
    folderId: row.folder_id,
    status: row.status,
    videoId: row.video_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

const FAIL_LIMIT = 5;                   // この回数間違えたら
const FAIL_WINDOW_MS = 10 * 60 * 1000;  // （この時間内に）
const LOCK_MS = 10 * 60 * 1000;         // この時間ロックする
let failures: number[] = [];
let lockedUntil = 0;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** 正しければ true。間違いを数えてロックも管理する */
function checkPassword(given: string): 'ok' | 'wrong' | 'locked' | 'unconfigured' {
  const expected = process.env.CAPTURE_PASSWORD ?? '';
  if (!expected) return 'unconfigured';
  const now = Date.now();
  if (now < lockedUntil) return 'locked';
  if (given && timingSafeEqual(digest(given), digest(expected))) return 'ok';
  failures = failures.filter(t => now - t < FAIL_WINDOW_MS);
  failures.push(now);
  if (failures.length >= FAIL_LIMIT) {
    lockedUntil = now + LOCK_MS;
    failures = [];
    console.warn('[capture] パスワードを続けて間違えたため10分ロックしました');
  }
  return 'wrong';
}

function sendAuthError(res: Response, result: 'wrong' | 'locked' | 'unconfigured') {
  if (result === 'unconfigured') return res.status(503).json({ error: '取り込み機能はサーバーで無効になっています' });
  if (result === 'locked') return res.status(429).json({ error: '続けて間違えたため、しばらく使えません。10分ほど待ってください' });
  return res.status(401).json({ error: 'パスワードが違います' });
}

function requireCapturePassword(req: Request, res: Response, next: NextFunction) {
  const result = checkPassword(String(req.headers['x-capture-password'] ?? ''));
  if (result !== 'ok') return sendAuthError(res, result);
  next();
}

export const capturesRouter = Router();

capturesRouter.post('/login', (req, res) => {
  const result = checkPassword(String((req.body as { password?: string } | undefined)?.password ?? ''));
  if (result !== 'ok') return sendAuthError(res, result);
  res.json({ ok: true });
});

capturesRouter.use(requireCapturePassword);

capturesRouter.get('/', (_req, res) => {
  res.json({ captures: listCaptures().map(toPublicCapture) });
});

capturesRouter.post('/', requireWriteToken, (req, res) => {
  const body = (req.body ?? {}) as { url?: string; folderId?: string | null };
  let url: URL;
  try {
    url = new URL((body.url ?? '').trim());
  } catch {
    return res.status(400).json({ error: 'URL の形式が正しくありません' });
  }
  if (!/^https?:$/.test(url.protocol) || !ALLOWED_HOSTS.test(url.hostname)) {
    return res.status(400).json({ error: '今は Facebook の動画の URL だけ取り込めます' });
  }
  const folderId = body.folderId?.trim() || null;
  if (folderId && !listFolders().some(f => f.id === folderId)) return res.status(404).json({ error: 'folder not found' });

  const id = randomUUID();
  insertCapture(id, url.toString(), folderId);
  res.status(202).json({ id });
});

let busy = false;
let lastFinishedAt = 0;

async function runCapture(row: CaptureRow): Promise<void> {
  const videoId = randomUUID();
  const outPath = path.join(ORIGINALS_DIR, `${videoId}.mp4`);
  console.log(`[capture] ${row.id}: 録画開始 ${row.url}`);
  try {
    const result = await captureVideo(row.url, outPath, AbortSignal.timeout(CAPTURE_TIMEOUT_MS));
    const title = result.title.slice(0, 120);
    registerUploadedVideo(videoId, outPath, `capture_${videoId}.mp4`, title, row.folder_id);
    markCaptureDone(row.id, videoId);
    console.log(`[capture] ${row.id}: 完了 ${result.durationSec.toFixed(1)}秒 ${result.width}x${result.height} → video ${videoId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markCaptureError(row.id, msg);
    console.warn(`[capture] ${row.id}: 失敗 ${msg}`);
  }
}

async function tick(): Promise<void> {
  if (busy || isAnalysisRunning() || isJobWorkerBusy()) return;
  if (Date.now() - lastFinishedAt < GAP_BETWEEN_CAPTURES_MS) return;
  const row = claimNextCapture();
  if (!row) return;
  busy = true;
  try {
    await runCapture(row);
  } finally {
    busy = false;
    lastFinishedAt = Date.now();
  }
}

export function startCaptureWorker(): void {
  const recovered = recoverStaleCaptures();
  if (recovered > 0) console.log(`[capture] recovered ${recovered} stale capture(s) -> queued`);
  setInterval(() => { void tick(); }, POLL_MS);
}
