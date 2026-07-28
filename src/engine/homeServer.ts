/**
 * ThinkCentre 自宅サーバー（server/）との通信。
 *   VITE_HOME_SERVER_URL — Cloudflare Tunnel 経由の公開URL（末尾スラッシュなし）
 */

export class HomeServerApiError extends Error {}

/** 書き込み系APIの共有トークン（server 側の API_WRITE_TOKEN と同値を設定） */
const WRITE_TOKEN = (import.meta.env.VITE_HOME_SERVER_TOKEN ?? '') as string;

/** 書き込み系リクエストに付与する認証ヘッダ。トークン未設定時は空（サーバー側も素通し設定のはず） */
export function authHeaders(): Record<string, string> {
  return WRITE_TOKEN ? { Authorization: `Bearer ${WRITE_TOKEN}` } : {};
}

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
    const auth = authHeaders();
    if (auth.Authorization) xhr.setRequestHeader('Authorization', auth.Authorization);

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
  const res = await fetch(`${baseUrl}/api/videos/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new HomeServerApiError(`削除に失敗しました: HTTP ${res.status}`);
}

export async function updateHomeServerVideo(
  baseUrl: string,
  id: string,
  fields: { title?: string; folderId?: string | null },
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/videos/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new HomeServerApiError(`フォルダ作成に失敗しました: HTTP ${res.status}`);
  return res.json();
}

export async function deleteHomeServerFolder(baseUrl: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/folders/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new HomeServerApiError(`フォルダ削除に失敗しました: HTTP ${res.status}`);
}

export interface RotationSample {
  t: number;
  angleDeg: number;
}

export interface RotationAnalysis {
  status: 'processing' | 'ready' | 'error';
  fps: number | null;
  totalFrames: number | null;
  detectedFrames: number | null;
  samples: RotationSample[] | null;
  errorMessage: string | null;
  updatedAt: string;
}

/** 回転角度解析を開始する（ThinkCentre上でPythonが実行される。数十秒〜かかる） */
export async function startRotationAnalysis(baseUrl: string, videoId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/videos/${videoId}/analyze`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
    throw new HomeServerApiError(body.message ?? body.error ?? `解析開始に失敗しました: HTTP ${res.status}`);
  }
}

/** null は「まだ一度も解析していない」（404） */
export async function fetchRotationAnalysis(baseUrl: string, videoId: string): Promise<RotationAnalysis | null> {
  const res = await fetch(`${baseUrl}/api/videos/${videoId}/analysis`);
  if (res.status === 404) return null;
  if (!res.ok) throw new HomeServerApiError(`解析結果の取得に失敗しました: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// フォルダ別MD解析指示書パイプライン（docs/folder-analysis-detailed-design.md §9.1）
// ---------------------------------------------------------------------------

export interface FolderSpec {
  markdown: string;
  preset: string;
  version: number;
}

export interface AnalysisJob {
  id: string;
  videoId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  preset: string;
  retryCount: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AnalysisJobDetail extends AnalysisJob {
  reportMd: string | null;
  resultJson: string | null;
  specSnapshot: string;
}

/** null は「指示書がまだ無い」（404） */
export async function getFolderSpec(baseUrl: string, folderId: string): Promise<FolderSpec | null> {
  const res = await fetch(`${baseUrl}/api/folders/${folderId}/spec`);
  if (res.status === 404) return null;
  if (!res.ok) throw new HomeServerApiError(`指示書の取得に失敗しました: HTTP ${res.status}`);
  return res.json();
}

export async function putFolderSpec(baseUrl: string, folderId: string, markdown: string): Promise<FolderSpec> {
  const res = await fetch(`${baseUrl}/api/folders/${folderId}/spec`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new HomeServerApiError(body.error ?? `指示書の保存に失敗しました: HTTP ${res.status}`);
  }
  return res.json();
}

export async function reanalyzeVideo(baseUrl: string, videoId: string): Promise<{ jobId: string }> {
  const res = await fetch(`${baseUrl}/api/videos/${videoId}/reanalyze`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new HomeServerApiError(body.error ?? `再解析の開始に失敗しました: HTTP ${res.status}`);
  }
  return res.json();
}

export async function reanalyzeFolder(baseUrl: string, folderId: string): Promise<{ jobIds: string[] }> {
  const res = await fetch(`${baseUrl}/api/folders/${folderId}/reanalyze`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new HomeServerApiError(body.error ?? `再解析の開始に失敗しました: HTTP ${res.status}`);
  }
  return res.json();
}

export async function listVideoJobs(baseUrl: string, videoId: string): Promise<AnalysisJob[]> {
  const res = await fetch(`${baseUrl}/api/videos/${videoId}/jobs`);
  if (!res.ok) throw new HomeServerApiError(`ジョブ一覧の取得に失敗しました: HTTP ${res.status}`);
  const data = await res.json() as { jobs: AnalysisJob[] };
  return data.jobs ?? [];
}

export async function getJobDetail(baseUrl: string, jobId: string): Promise<AnalysisJobDetail> {
  const res = await fetch(`${baseUrl}/api/jobs/${jobId}`);
  if (!res.ok) throw new HomeServerApiError(`ジョブの取得に失敗しました: HTTP ${res.status}`);
  return res.json();
}
