/**
 * ThinkCentre 自宅サーバー（server/）との通信。
 *   VITE_HOME_SERVER_URL — Cloudflare Tunnel 経由の公開URL（末尾スラッシュなし）
 */

export class HomeServerApiError extends Error {}

/** uploadVideoToHomeServer の進捗情報（googleDrive.ts の UploadStats と同構造） */
export interface HomeUploadStats {
  percent: number;
  loaded: number;
  total: number;
  speedBps: number;
  etaSec: number;
}

export interface HomeServerVideo {
  id: string;
  title: string;
  status: 'processing' | 'ready' | 'error';
  durationSec: number | null;
  thumbnailUrl: string | null;
  hlsUrl: string | null;
  errorMessage: string | null;
  folderId: string | null;
  createdAt: string;
}

export interface HomeServerFolder {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * 動画ファイルを ThinkCentre サーバーへアップロードする（XHRで進捗取得）
 * @returns アップロードされた動画の id
 */
export function uploadVideoToHomeServer(
  baseUrl: string,
  file: File,
  onProgress?: (stats: HomeUploadStats) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('title', file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/api/videos`);

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
        try {
          const result = JSON.parse(xhr.responseText) as { id?: string };
          if (!result.id) throw new Error('no id in response');
          resolve(result.id);
        } catch {
          reject(new HomeServerApiError('サーバーからの応答を解釈できませんでした'));
        }
      } else {
        reject(new HomeServerApiError(`アップロード失敗: HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () =>
      reject(new HomeServerApiError('アップロード中にネットワークエラーが発生しました')),
    );
    xhr.addEventListener('abort', () =>
      reject(new HomeServerApiError('アップロードがキャンセルされました')),
    );

    xhr.send(form);
  });
}

export async function listHomeServerVideos(baseUrl: string): Promise<HomeServerVideo[]> {
  const res = await fetch(`${baseUrl}/api/videos`);
  if (!res.ok) throw new HomeServerApiError(`一覧取得に失敗しました: HTTP ${res.status}`);
  const data = await res.json() as { videos: HomeServerVideo[] };
  return data.videos ?? [];
}

export function resolveHomeServerUrl(baseUrl: string, path: string | null): string | null {
  if (!path) return null;
  return `${baseUrl}${path}`;
}

export async function deleteHomeServerVideo(baseUrl: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/videos/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new HomeServerApiError(`削除に失敗しました: HTTP ${res.status}`);
}

export async function updateHomeServerVideo(
  baseUrl: string,
  id: string,
  fields: { title?: string; folderId?: string | null },
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/videos/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new HomeServerApiError(`更新に失敗しました: HTTP ${res.status}`);
}

export async function listHomeServerFolders(baseUrl: string): Promise<HomeServerFolder[]> {
  const res = await fetch(`${baseUrl}/api/folders`);
  if (!res.ok) throw new HomeServerApiError(`フォルダ一覧の取得に失敗しました: HTTP ${res.status}`);
  const data = await res.json() as { folders: HomeServerFolder[] };
  return data.folders ?? [];
}

export async function createHomeServerFolder(baseUrl: string, name: string): Promise<HomeServerFolder> {
  const res = await fetch(`${baseUrl}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new HomeServerApiError(`フォルダ作成に失敗しました: HTTP ${res.status}`);
  return res.json();
}

export async function deleteHomeServerFolder(baseUrl: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/folders/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new HomeServerApiError(`フォルダ削除に失敗しました: HTTP ${res.status}`);
}
