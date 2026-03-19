/**
 * Google Drive API v3 — 音楽・動画ファイルの一覧取得・ダウンロード・アップロード
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

/** ファイルを Blob としてダウンロード（進捗コールバック付き） */
export async function fetchFileBlob(
  token: string,
  fileId: string,
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new DriveApiError(`Download failed: HTTP ${res.status}`, res.status);

  const total = Number(res.headers.get('Content-Length') ?? '0');
  if (!res.body || total === 0) {
    // Content-Length 不明 → そのまま blob 取得
    onProgress?.(100);
    return res.blob();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(Math.round((loaded / total) * 100));
  }

  return new Blob(chunks, { type: res.headers.get('Content-Type') ?? '' });
}

/**
 * 指定名のフォルダを root 直下で探し、なければ作成して ID を返す
 */
export async function findOrCreateFolder(
  token: string,
  folderName: string,
): Promise<string> {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false and 'root' in parents`;
  const params = new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' });

  const searchRes = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!searchRes.ok) throw new DriveApiError(`Folder search failed: HTTP ${searchRes.status}`, searchRes.status);

  const searchData = await searchRes.json() as { files?: { id: string }[] };
  if (searchData.files && searchData.files.length > 0) return searchData.files[0].id;

  // 存在しない場合は新規作成
  const createRes = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
    }),
  });
  if (!createRes.ok) throw new DriveApiError(`Folder create failed: HTTP ${createRes.status}`, createRes.status);

  const folder = await createRes.json() as { id: string };
  return folder.id;
}

/**
 * Drive ファイルを「リンクを知っている人が閲覧可能」に設定する
 */
export async function createPublicPermission(
  token: string,
  fileId: string,
): Promise<void> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!res.ok) throw new DriveApiError(`Permission create failed: HTTP ${res.status}`, res.status);
}

/** uploadFileResumable の進捗情報 */
export interface UploadStats {
  percent: number;   // 0–100
  loaded: number;    // 送信済みバイト
  total: number;     // 合計バイト
  speedBps: number;  // 現在の転送速度 (bytes/sec, 開始からの平均)
  etaSec: number;    // 残り推定秒数
}

/**
 * 再開可能アップロード（大容量ファイル対応）
 * XMLHttpRequest を使用してアップロード進捗・速度・残り時間を取得する
 * @returns 作成されたファイルの Drive ID
 */
export async function uploadFileResumable(
  token: string,
  folderId: string,
  file: File,
  onProgress?: (stats: UploadStats) => void,
): Promise<string> {
  // Step 1: アップロードセッションを開始してアップロード URI を取得
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': file.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify({ name: file.name, parents: [folderId] }),
    },
  );
  if (!initRes.ok) throw new DriveApiError(`Upload init failed: HTTP ${initRes.status}`, initRes.status);

  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw new DriveApiError('Upload session URL が取得できませんでした');

  // Step 2: XHR でファイル本体を送信（upload.progress で進捗を取得）
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    const startTime = Date.now();

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const elapsedSec = (Date.now() - startTime) / 1000;
      const speedBps   = elapsedSec > 0 ? e.loaded / elapsedSec : 0;
      const remaining  = e.total - e.loaded;
      const etaSec     = speedBps > 0 ? remaining / speedBps : 0;
      onProgress?.({
        percent:  Math.round((e.loaded / e.total) * 100),
        loaded:   e.loaded,
        total:    e.total,
        speedBps,
        etaSec,
      });
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.({ percent: 100, loaded: file.size, total: file.size, speedBps: 0, etaSec: 0 });
        // レスポンスボディからファイル ID を取得
        try {
          const result = JSON.parse(xhr.responseText) as { id?: string };
          resolve(result.id ?? '');
        } catch {
          resolve('');
        }
      } else {
        reject(new DriveApiError(`Upload failed: HTTP ${xhr.status}`, xhr.status));
      }
    });

    xhr.addEventListener('error', () =>
      reject(new DriveApiError('アップロード中にネットワークエラーが発生しました')),
    );
    xhr.addEventListener('abort', () =>
      reject(new DriveApiError('アップロードがキャンセルされました')),
    );

    xhr.send(file);
  });
}
