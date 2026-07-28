import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { convertVideo } from '../converter.js';
import {
  deleteVideo, getVideo, insertVideo, listVideos, markVideoError, markVideoReady, updateVideo,
  getRotationAnalysis, type VideoRow,
} from '../db.js';
import { isAnalysisRunning, startRotationAnalysis } from '../analysisJob.js';

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

/** 解析ジョブ実行中はアップロード（ffmpeg変換で重い）を受け付けない */
function blockIfAnalyzing(_req: Request, res: Response, next: NextFunction) {
  if (isAnalysisRunning()) {
    return res.status(409).json({
      error: 'analysis_in_progress',
      message: '解析中のためアップロードできません。しばらくしてから再試行してください。',
    });
  }
  next();
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

videosRouter.post('/', blockIfAnalyzing, upload.single('file'), (req, res) => {
  const file = req.file;
  const id = (req as { videoId?: string }).videoId;
  if (!file || !id) return res.status(400).json({ error: 'file is required' });

  const title = (req.body?.title as string | undefined)?.trim() || file.originalname;
  insertVideo({ id, title, original_filename: file.originalname });

  // 変換完了は待たずに即レスポンス（保存自体はここで確実に完了している）
  res.status(202).json({ id, status: 'processing' });

  const hlsOutDir = path.join(HLS_DIR, id);
  convertVideo(file.path, hlsOutDir, THUMBNAILS_DIR, id)
    .then(result => {
      markVideoReady(id, result.durationSec, `/thumbnails/${id}.jpg`, `/hls/${id}/playlist.m3u8`);
    })
    .catch(err => {
      markVideoError(id, err instanceof Error ? err.message : String(err));
    });
});

videosRouter.patch('/:id', (req, res) => {
  const row = getVideo(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const body = req.body as { title?: string; folderId?: string | null };
  const fields: { title?: string; folderId?: string | null } = {};
  if (typeof body.title === 'string' && body.title.trim()) fields.title = body.title.trim();
  if ('folderId' in body) fields.folderId = body.folderId;

  updateVideo(row.id, fields);
  res.json(toPublicVideo(getVideo(row.id)!));
});

videosRouter.delete('/:id', async (req, res) => {
  const row = getVideo(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const ext = path.extname(row.original_filename) || '.mp4';
  await Promise.all([
    rm(path.join(ORIGINALS_DIR, `${row.id}${ext}`), { force: true }),
    rm(path.join(HLS_DIR, row.id), { recursive: true, force: true }),
    rm(path.join(THUMBNAILS_DIR, `${row.id}.jpg`), { force: true }),
  ]);
  deleteVideo(row.id);
  res.json({ status: 'ok' });
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
