import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { convertVideo } from '../converter.js';
import {
  deleteVideo, getVideo, insertVideo, listVideos, markVideoError, markVideoReady, updateVideo,
  getRotationAnalysis, deleteJobsByVideo, enqueueAnalysisJob, listJobsByVideo, type VideoRow,
} from '../db.js';
import { isAnalysisRunning, startRotationAnalysis } from '../analysisJob.js';
import { requireWriteToken } from '../auth.js';
import { readSpec } from '../specStore.js';
import { isJobWorkerBusy, jobDirOf } from '../jobWorker.js';
import { toPublicJob } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_DIR = path.resolve(__dirname, '../../storage');
export const ORIGINALS_DIR = path.join(STORAGE_DIR, 'originals');
export const HLS_DIR = path.join(STORAGE_DIR, 'hls');
export const THUMBNAILS_DIR = path.join(STORAGE_DIR, 'thumbnails');

const upload = multer({
  storage: multer.diskStorage({
    destination: ORIGINALS_DIR,
    filename: (req, file, cb) => {
      const id = randomUUID();
      // 後続処理で同じ id を使うため request に保持しておく
      (req as { videoId?: string }).videoId = id;
      const ext = path.extname(file.originalname) || '.mp4';
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB
});

function toPublicVideo(row: VideoRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    durationSec: row.duration_sec,
    thumbnailUrl: row.status === 'ready' ? `/thumbnails/${row.id}.jpg` : null,
    hlsUrl: row.status === 'ready' ? `/hls/${row.id}/playlist.m3u8` : null,
    errorMessage: row.error_message,
    folderId: row.folder_id,
    createdAt: row.created_at,
  };
}

/** 回転解析・フォルダ解析ジョブのどちらかが走っているか */
function isAnalysisBusy(): boolean {
  return isAnalysisRunning() || isJobWorkerBusy();
}

const CONVERT_WAIT_POLL_MS = 10_000;
/** HLS 変換を1本ずつ直列に流すためのチェーン */
let conversionChain: Promise<void> = Promise.resolve();

/**
 * HLS 変換を順番待ちに積む。
 * 解析中でもアップロード（受信・保存）は受け付け、CPU を食う変換だけ解析が終わるまで待たせる。
 */
function enqueueConversion(id: string, filePath: string): void {
  conversionChain = conversionChain.then(async () => {
    if (isAnalysisBusy()) console.log(`[convert] ${id}: 解析中のため変換を待機`);
    while (isAnalysisBusy()) await new Promise(r => setTimeout(r, CONVERT_WAIT_POLL_MS));
    if (!getVideo(id)) return; // 待っている間に削除された

    try {
      const result = await convertVideo(filePath, path.join(HLS_DIR, id), THUMBNAILS_DIR, id);
      markVideoReady(id, result.durationSec, `/thumbnails/${id}.jpg`, `/hls/${id}/playlist.m3u8`);
      maybeEnqueue(id); // フォルダに指示書があれば解析ジョブを積む
    } catch (err) {
      markVideoError(id, err instanceof Error ? err.message : String(err));
    }
  });
}

/** 起動時: 変換待ち・変換中のままサーバーが止まった動画の変換をやり直す */
export function resumePendingConversions(): void {
  for (const row of listVideos()) {
    if (row.status !== 'processing') continue;
    const ext = path.extname(row.original_filename) || '.mp4';
    const filePath = path.join(ORIGINALS_DIR, `${row.id}${ext}`);
    if (!existsSync(filePath)) {
      markVideoError(row.id, '元動画ファイルが見つかりません');
      continue;
    }
    console.log(`[convert] ${row.id}: 起動時に変換を再開`);
    enqueueConversion(row.id, filePath);
  }
}

/**
 * 動画が ready かつフォルダに解析指示書があればジョブを積む。
 * トリガーは (a) 変換完了時 (b) フォルダ移動時 (c) 手動再解析。
 */
function maybeEnqueue(videoId: string): string | null {
  const v = getVideo(videoId);
  if (!v || v.status !== 'ready' || !v.folder_id) return null;
  let spec;
  try {
    spec = readSpec(v.folder_id);
  } catch {
    return null; // 壊れたspecではジョブを積まない（PUT時に検証済みのため通常起きない）
  }
  if (!spec) return null;
  return enqueueAnalysisJob(v.id, v.folder_id, spec.preset, spec.markdown);
}

export const videosRouter = Router();

videosRouter.get('/', (_req, res) => {
  res.json({ videos: listVideos().map(toPublicVideo) });
});

videosRouter.get('/:id', (req, res) => {
  const row = getVideo(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(toPublicVideo(row));
});

videosRouter.post('/', requireWriteToken, upload.single('file'), (req, res) => {
  const file = req.file;
  const id = (req as { videoId?: string }).videoId;
  if (!file || !id) return res.status(400).json({ error: 'file is required' });

  const title = (req.body?.title as string | undefined)?.trim() || file.originalname;
  const folderId = (req.body?.folderId as string | undefined)?.trim() || null;
  registerUploadedVideo(id, file.path, file.originalname, title, folderId);

  // 変換完了は待たずに即レスポンス（保存自体はここで確実に完了している）
  res.status(202).json({ id, status: 'processing' });
});

/**
 * originals に置かれた動画を DB に登録し、HLS 変換を順番待ちに積む。
 * 一括アップロード（POST /api/videos）と分割アップロード（/api/uploads）の共通処理。
 */
export function registerUploadedVideo(
  id: string, filePath: string, originalName: string, title: string, folderId: string | null,
): void {
  insertVideo({ id, title, original_filename: originalName, folder_id: folderId });
  enqueueConversion(id, filePath);
}

videosRouter.patch('/:id', requireWriteToken, (req, res) => {
  const row = getVideo(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const body = req.body as { title?: string; folderId?: string | null };
  const fields: { title?: string; folderId?: string | null } = {};
  if (typeof body.title === 'string' && body.title.trim()) fields.title = body.title.trim();
  if ('folderId' in body) fields.folderId = body.folderId;

  updateVideo(row.id, fields);

  // フォルダ移動が発生した場合、移動先に指示書があれば解析ジョブを積む
  if ('folderId' in body && body.folderId !== row.folder_id) maybeEnqueue(row.id);

  res.json(toPublicVideo(getVideo(row.id)!));
});

videosRouter.delete('/:id', requireWriteToken, async (req, res) => {
  const row = getVideo(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const ext = path.extname(row.original_filename) || '.mp4';
  const jobIds = deleteJobsByVideo(row.id);
  await Promise.all([
    rm(path.join(ORIGINALS_DIR, `${row.id}${ext}`), { force: true }),
    rm(path.join(HLS_DIR, row.id), { recursive: true, force: true }),
    rm(path.join(THUMBNAILS_DIR, `${row.id}.jpg`), { force: true }),
    ...jobIds.map(jobId => rm(jobDirOf(jobId), { recursive: true, force: true })),
  ]);
  deleteVideo(row.id);
  res.json({ status: 'ok' });
});

/** 手動再解析（MD更新後に既存動画へ適用する経路） */
videosRouter.post('/:id/reanalyze', requireWriteToken, (req, res) => {
  const row = getVideo(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status !== 'ready') return res.status(400).json({ error: 'video is not ready yet' });
  if (!row.folder_id) return res.status(409).json({ error: 'フォルダに入っていない動画は解析できません' });

  const jobId = maybeEnqueue(row.id);
  if (!jobId) return res.status(409).json({ error: 'このフォルダに解析指示書がありません' });
  res.status(202).json({ jobId });
});

/** 動画に紐づく解析ジョブ一覧（新しい順） */
videosRouter.get('/:id/jobs', (req, res) => {
  res.json({ jobs: listJobsByVideo(req.params.id).map(toPublicJob) });
});

videosRouter.post('/:id/analyze', (req, res) => {
  const row = getVideo(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status !== 'ready') return res.status(400).json({ error: 'video is not ready yet' });
  if (isAnalysisRunning()) return res.status(409).json({ error: 'analysis_in_progress' });

  const ext = path.extname(row.original_filename) || '.mp4';
  const videoPath = path.join(ORIGINALS_DIR, `${row.id}${ext}`);
  try {
    startRotationAnalysis(row.id, videoPath);
    res.status(202).json({ status: 'processing' });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : 'failed to start analysis' });
  }
});

videosRouter.get('/:id/analysis', (req, res) => {
  const a = getRotationAnalysis(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({
    status: a.status,
    fps: a.fps,
    totalFrames: a.total_frames,
    detectedFrames: a.detected_frames,
    samples: a.samples_json ? JSON.parse(a.samples_json) : null,
    errorMessage: a.error_message,
    updatedAt: a.updated_at,
  });
});
