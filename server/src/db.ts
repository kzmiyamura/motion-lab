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
    folder_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rotation_analysis (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'error')),
    fps REAL,
    total_frames INTEGER,
    detected_frames INTEGER,
    samples_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id            TEXT PRIMARY KEY,
    video_id      TEXT NOT NULL,
    folder_id     TEXT NOT NULL,
    preset        TEXT NOT NULL,
    spec_snapshot TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error')),
    retry_count   INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    result_json   TEXT,
    report_md     TEXT,
    error_message TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON analysis_jobs (status, created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_video ON analysis_jobs (video_id, created_at);
`);

// 既存DB（folder_id列がまだ無いバージョン）向けマイグレーション
try {
  db.exec('ALTER TABLE videos ADD COLUMN folder_id TEXT');
} catch {
  // 既に列がある場合はエラーになるので無視
}

export interface VideoRow {
  id: string;
  title: string;
  original_filename: string;
  status: 'processing' | 'ready' | 'error';
  duration_sec: number | null;
  thumbnail_path: string | null;
  hls_playlist_path: string | null;
  error_message: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FolderRow {
  id: string;
  name: string;
  created_at: string;
}

export function insertVideo(row: Pick<VideoRow, 'id' | 'title' | 'original_filename'> & { folder_id?: string | null }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO videos (id, title, original_filename, status, folder_id, created_at, updated_at)
     VALUES (?, ?, ?, 'processing', ?, ?, ?)`,
  ).run(row.id, row.title, row.original_filename, row.folder_id ?? null, now, now);
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
  return db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all() as unknown as VideoRow[];
}

export function getVideo(id: string): VideoRow | undefined {
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as unknown as VideoRow | undefined;
}

export function deleteVideo(id: string): void {
  db.prepare('DELETE FROM videos WHERE id = ?').run(id);
}

export function updateVideo(id: string, fields: { title?: string; folderId?: string | null }): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
  if (fields.folderId !== undefined) { sets.push('folder_id = ?'); values.push(fields.folderId); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function listFolders(): FolderRow[] {
  return db.prepare('SELECT * FROM folders ORDER BY name ASC').all() as unknown as FolderRow[];
}

export function createFolder(id: string, name: string): void {
  db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').run(id, name, new Date().toISOString());
}

export function deleteFolder(id: string): void {
  db.prepare('UPDATE videos SET folder_id = NULL WHERE folder_id = ?').run(id);
  db.prepare('DELETE FROM folders WHERE id = ?').run(id);
}

export interface RotationAnalysisRow {
  video_id: string;
  status: 'processing' | 'ready' | 'error';
  fps: number | null;
  total_frames: number | null;
  detected_frames: number | null;
  samples_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function insertRotationAnalysis(videoId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO rotation_analysis (video_id, status, created_at, updated_at)
     VALUES (?, 'processing', ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET status = 'processing', error_message = NULL, updated_at = excluded.updated_at`,
  ).run(videoId, now, now);
}

export function markRotationAnalysisReady(
  videoId: string,
  fields: { fps: number; totalFrames: number; detectedFrames: number; samplesJson: string },
): void {
  db.prepare(
    `UPDATE rotation_analysis SET status = 'ready', fps = ?, total_frames = ?, detected_frames = ?,
     samples_json = ?, updated_at = ? WHERE video_id = ?`,
  ).run(fields.fps, fields.totalFrames, fields.detectedFrames, fields.samplesJson, new Date().toISOString(), videoId);
}

export function markRotationAnalysisError(videoId: string, message: string): void {
  db.prepare(
    `UPDATE rotation_analysis SET status = 'error', error_message = ?, updated_at = ? WHERE video_id = ?`,
  ).run(message, new Date().toISOString(), videoId);
}

export function getRotationAnalysis(videoId: string): RotationAnalysisRow | undefined {
  return db.prepare('SELECT * FROM rotation_analysis WHERE video_id = ?').get(videoId) as unknown as RotationAnalysisRow | undefined;
}

// ---------------------------------------------------------------------------
// analysis_jobs — フォルダ別MD解析指示書パイプラインのジョブキュー
// docs/folder-analysis-detailed-design.md §1 参照
// ---------------------------------------------------------------------------

export interface AnalysisJobRow {
  id: string;
  video_id: string;
  folder_id: string;
  preset: string;
  spec_snapshot: string;
  status: 'queued' | 'running' | 'done' | 'error';
  retry_count: number;
  next_retry_at: string | null;
  result_json: string | null;
  report_md: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** ジョブを積む。同一videoの既存queuedジョブがあれば重複させず既存idを返す */
export function enqueueAnalysisJob(videoId: string, folderId: string, preset: string, specSnapshot: string): string {
  const existing = db.prepare(
    `SELECT id FROM analysis_jobs WHERE video_id = ? AND status = 'queued' LIMIT 1`,
  ).get(videoId) as unknown as { id: string } | undefined;
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO analysis_jobs (id, video_id, folder_id, preset, spec_snapshot, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(id, videoId, folderId, preset, specSnapshot, new Date().toISOString());
  return id;
}

/** queued かつリトライ待機が明けている最古1件を running にして返す。無ければ undefined */
export function claimNextJob(): AnalysisJobRow | undefined {
  const now = new Date().toISOString();
  const row = db.prepare(
    `SELECT * FROM analysis_jobs
     WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY created_at ASC LIMIT 1`,
  ).get(now) as unknown as AnalysisJobRow | undefined;
  if (!row) return undefined;

  // Node直列実行だが、statusガード付きUPDATEで保険をかける
  const result = db.prepare(
    `UPDATE analysis_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
  ).run(now, row.id);
  if (result.changes === 0) return undefined;
  return { ...row, status: 'running', started_at: now };
}

export function markJobDone(id: string, resultJson: string, reportMd: string): void {
  db.prepare(
    `UPDATE analysis_jobs SET status = 'done', result_json = ?, report_md = ?, error_message = NULL, finished_at = ?
     WHERE id = ?`,
  ).run(resultJson, reportMd, new Date().toISOString(), id);
}

export function markJobError(id: string, message: string): void {
  db.prepare(
    `UPDATE analysis_jobs SET status = 'error', error_message = ?, finished_at = ? WHERE id = ?`,
  ).run(message, new Date().toISOString(), id);
}

/** レート制限等の一時失敗。queuedに戻し retry_count++ / next_retry_at を設定 */
export function requeueJobForRetry(id: string, nextRetryAt: string): void {
  db.prepare(
    `UPDATE analysis_jobs SET status = 'queued', retry_count = retry_count + 1, next_retry_at = ?, started_at = NULL
     WHERE id = ?`,
  ).run(nextRetryAt, id);
}

export function getJob(id: string): AnalysisJobRow | undefined {
  return db.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(id) as unknown as AnalysisJobRow | undefined;
}

export function listJobsByVideo(videoId: string): AnalysisJobRow[] {
  return db.prepare(
    'SELECT * FROM analysis_jobs WHERE video_id = ? ORDER BY created_at DESC',
  ).all(videoId) as unknown as AnalysisJobRow[];
}

/** 動画削除時のカスケード。削除したjob idの配列を返す（成果物ディレクトリ掃除用） */
export function deleteJobsByVideo(videoId: string): string[] {
  const rows = db.prepare('SELECT id FROM analysis_jobs WHERE video_id = ?').all(videoId) as unknown as { id: string }[];
  db.prepare('DELETE FROM analysis_jobs WHERE video_id = ?').run(videoId);
  return rows.map(r => r.id);
}

/** サーバー起動時リカバリ: running を全て queued に戻す。戻した件数を返す */
export function recoverStaleRunningJobs(): number {
  const result = db.prepare(
    `UPDATE analysis_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`,
  ).run();
  return Number(result.changes);
}
