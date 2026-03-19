/**
 * Google Drive API v3 — 音楽・動画ファイルの一覧取得とダウンロード
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

export class DriveApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
  }
}

/** Drive 内の音楽・動画ファイル一覧を取得（最大50件、更新日時降順） */
export async function listMediaFiles(
  token: string,
  query = '',
): Promise<DriveFile[]> {
  const mimeFilter = [
    "mimeType contains 'audio/'",
    "mimeType contains 'video/'",
  ].join(' or ');

  const q = query
    ? `(${mimeFilter}) and name contains '${query.replace(/'/g, "\\'")}' and trashed = false`
    : `(${mimeFilter}) and trashed = false`;

  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,size)',
    orderBy: 'modifiedTime desc',
    pageSize: '50',
  });

  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new DriveApiError(
      body?.error?.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  const data = await res.json() as { files?: DriveFile[] };
  return data.files ?? [];
}

/** ファイルを Blob としてダウンロード */
export async function fetchFileBlob(token: string, fileId: string): Promise<Blob> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new DriveApiError(`Download failed: HTTP ${res.status}`, res.status);
  return res.blob();
}
