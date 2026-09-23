/**
 * 分割アップロード。
 *
 * Cloudflare Pages の relay（/relay/*）は1リクエストのボディが 100MB までのため、
 * 大きい動画は CHUNK_SIZE ごとに分けて送り、ここでつなぎ直す。
 *
 *   POST /api/uploads                     { filename, title?, size, folderId? } → { uploadId, chunkSize, totalChunks }
 *   GET  /api/uploads/:uploadId           → { receivedChunks: number[] }（途中再開用）
 *   PUT  /api/uploads/:uploadId/chunks/:i  生バイト（application/octet-stream）
 *   POST /api/uploads/:uploadId/complete  → 202 { id, status: 'processing' }
 *
 * 受信中のチャンクは storage/uploads-tmp/<uploadId>/ に置く。24時間放置されたものは次の開始時に掃除する。
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { requireWriteToken } from '../auth.js';
import { blockIfAnalyzing, ORIGINALS_DIR, registerUploadedVideo, STORAGE_DIR } from './videos.js';

export const UPLOADS_TMP_DIR = path.join(STORAGE_DIR, 'uploads-tmp');

/** 1チャンクの大きさ。relay の 100MB 上限に対して余裕を持たせる */
export const CHUNK_SIZE = 50 * 1024 * 1024;
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4GB（一括アップロードと同じ上限）
const STALE_MS = 24 * 60 * 60 * 1000;

interface UploadMeta {
  filename: string;
  title: string;
  size: number;
  folderId: string | null;
  totalChunks: number;
  createdAt: number;
}

const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/;

function dirOf(uploadId: string): string {
  return path.join(UPLOADS_TMP_DIR, uploadId);
}

async function readMeta(uploadId: string): Promise<UploadMeta | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  try {
    return JSON.parse(await readFile(path.join(dirOf(uploadId), 'meta.json'), 'utf8')) as UploadMeta;
  } catch {
    return null;
  }
}

/** 受信済み（書き込み完了済み）のチャンク番号 */
async function receivedChunks(uploadId: string): Promise<number[]> {
  const names = await readdir(dirOf(uploadId)).catch(() => [] as string[]);
  return names
    .filter(n => /^\d+\.part$/.test(n))
    .map(n => Number(n.slice(0, -'.part'.length)))
    .sort((a, b) => a - b);
}

/** 放置された受信中アップロードを消す */
async function sweepStale(): Promise<void> {
  const names = await readdir(UPLOADS_TMP_DIR).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of names) {
    const dir = path.join(UPLOADS_TMP_DIR, name);
    const st = await stat(dir).catch(() => null);
    if (st && now - st.mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const uploadsRouter = Router();

uploadsRouter.post('/', requireWriteToken, blockIfAnalyzing, async (req, res) => {
  const body = (req.body ?? {}) as { filename?: string; title?: string; size?: number; folderId?: string | null };
  const filename = body.filename?.trim();
  const size = Number(body.size);
  if (!filename || !Number.isInteger(size) || size <= 0) {
    return res.status(400).json({ error: 'filename and size are required' });
  }
  if (size > MAX_FILE_SIZE) return res.status(413).json({ error: 'file too large' });

  await sweepStale();
  const uploadId = randomUUID();
  const meta: UploadMeta = {
    filename,
    title: body.title?.trim() || filename,
    size,
    folderId: body.folderId?.trim() || null,
    totalChunks: Math.ceil(size / CHUNK_SIZE),
    createdAt: Date.now(),
  };
  await mkdir(dirOf(uploadId), { recursive: true });
  await writeFile(path.join(dirOf(uploadId), 'meta.json'), JSON.stringify(meta));
  res.status(201).json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks: meta.totalChunks });
});

uploadsRouter.get('/:uploadId', async (req, res) => {
  const meta = await readMeta(req.params.uploadId);
  if (!meta) return res.status(404).json({ error: 'not found' });
  res.json({ totalChunks: meta.totalChunks, chunkSize: CHUNK_SIZE, receivedChunks: await receivedChunks(req.params.uploadId) });
});

uploadsRouter.put('/:uploadId/chunks/:index', requireWriteToken, async (req, res) => {
  const { uploadId } = req.params;
  const meta = await readMeta(uploadId);
  if (!meta) return res.status(404).json({ error: 'not found' });

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
    return res.status(400).json({ error: 'invalid chunk index' });
  }
  const expected = index === meta.totalChunks - 1 ? meta.size - CHUNK_SIZE * index : CHUNK_SIZE;

  // 途中で切れた書き込みを受信済みと誤認しないよう、.tmp に書いてから rename する
  const partPath = path.join(dirOf(uploadId), `${index}.part`);
  const tmpPath = `${partPath}.${randomUUID()}.tmp`;
  try {
    await pipeline(req, createWriteStream(tmpPath));
    const written = (await stat(tmpPath)).size;
    if (written !== expected) {
      await rm(tmpPath, { force: true });
      return res.status(400).json({ error: `chunk size mismatch: expected ${expected}, got ${written}` });
    }
    await rename(tmpPath, partPath);
    res.json({ index, received: written });
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

uploadsRouter.post('/:uploadId/complete', requireWriteToken, async (req, res) => {
  const { uploadId } = req.params;
  const meta = await readMeta(uploadId);
  if (!meta) return res.status(404).json({ error: 'not found' });

  const received = await receivedChunks(uploadId);
  const missing: number[] = [];
  for (let i = 0; i < meta.totalChunks; i++) if (!received.includes(i)) missing.push(i);
  if (missing.length > 0) return res.status(409).json({ error: 'missing chunks', missing });

  const id = randomUUID();
  const ext = path.extname(meta.filename) || '.mp4';
  const outPath = path.join(ORIGINALS_DIR, `${id}${ext}`);
  try {
    const out = createWriteStream(outPath);
    for (let i = 0; i < meta.totalChunks; i++) {
      await pipeline(createReadStream(path.join(dirOf(uploadId), `${i}.part`)), out, { end: false });
    }
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });
    const total = (await stat(outPath)).size;
    if (total !== meta.size) throw new Error(`size mismatch: expected ${meta.size}, got ${total}`);
  } catch (err) {
    await rm(outPath, { force: true }).catch(() => {});
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }

  await rm(dirOf(uploadId), { recursive: true, force: true }).catch(() => {});
  registerUploadedVideo(id, outPath, meta.filename, meta.title, meta.folderId);
  res.status(202).json({ id, status: 'processing' });
});
