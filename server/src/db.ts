import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'motionlab.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'error')),
    duration_sec REAL,
    thumbnail_path TEXT,
    hls_playlist_path TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export interface VideoRow {
  id: string;
  title: string;
  original_filename: string;
  status: 'processing' | 'ready' | 'error';
  duration_sec: number | null;
  thumbnail_path: string | null;
  hls_playlist_path: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function insertVideo(row: Pick<VideoRow, 'id' | 'title' | 'original_filename'>): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO videos (id, title, original_filename, status, created_at, updated_at)
     VALUES (?, ?, ?, 'processing', ?, ?)`,
  ).run(row.id, row.title, row.original_filename, now, now);
}

export function markVideoReady(id: string, durationSec: number, thumbnailPath: string, hlsPlaylistPath: string): void {
  db.prepare(
    `UPDATE videos SET status = 'ready', duration_sec = ?, thumbnail_path = ?, hls_playlist_path = ?, updated_at = ?
     WHERE id = ?`,
  ).run(durationSec, thumbnailPath, hlsPlaylistPath, new Date().toISOString(), id);
}

export function markVideoError(id: string, message: string): void {
  db.prepare(
    `UPDATE videos SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?`,
  ).run(message, new Date().toISOString(), id);
}

export function listVideos(): VideoRow[] {
  return db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all() as VideoRow[];
}

export function getVideo(id: string): VideoRow | undefined {
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined;
}
