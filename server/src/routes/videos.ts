import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import { convertVideo } from '../converter.js';
import { getVideo, insertVideo, listVideos, markVideoError, markVideoReady, type VideoRow } from '../db.js';

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
    createdAt: row.created_at,
  };
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

videosRouter.post('/', upload.single('file'), (req, res) => {
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
