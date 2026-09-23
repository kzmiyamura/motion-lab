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

/** 1チャンクあたりの再試行回数（通信の瞬断対策） */
const CHUNK_MAX_ATTEMPTS = 4;
/** 途中再開用: ファイルごとの uploadId を覚えておく localStorage キー */
const RESUME_KEY_PREFIX = 'motionlab-home-upload:';

function resumeKeyOf(file: File): string {
  return `${RESUME_KEY_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

function loadResumeId(file: File): string | null {
  try { return localStorage.getItem(resumeKeyOf(file)); } catch { return null; }
}

function saveResumeId(file: File, uploadId: string | null): void {
  try {
    if (uploadId) localStorage.setItem(resumeKeyOf(file), uploadId);
    else localStorage.removeItem(resumeKeyOf(file));
  } catch { /* 保存できなくても再開できないだけ */ }
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as T;
  return { status: res.status, data };
}

/** 送信が進まないまま この時間が過ぎたら、そのチャンクを打ち切って送り直す */
const CHUNK_STALL_MS = 60_000;

/** 1チャンクを XHR で PUT する（進捗取得のため fetch ではなく XHR） */
function putChunk(url: string, blob: Blob, onLoaded: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const auth = authHeaders();
    if (auth.Authorization) xhr.setRequestHeader('Authorization', auth.Authorization);

    // 回線が詰まって進捗が止まったまま待ち続けないよう、無進捗を監視する。
    // ただし iOS Safari は送信バッファに積んだ時点で loaded=全量を報告し、その後は実送信が終わるまで
    // progress が来ない。全量報告後も監視すると正常な送信を打ち切ってしまうので、全量報告後は監視しない
    let lastProgressAt = Date.now();
    let fullyReported = false;
    let stalled = false;
    const watchdog = setInterval(() => {
      if (!fullyReported && Date.now() - lastProgressAt > CHUNK_STALL_MS) {
        stalled = true;
        xhr.abort();
      }
    }, 5000);
    const finish = (fn: () => void) => { clearInterval(watchdog); fn(); };

    xhr.upload.addEventListener('progress', e => {
      lastProgressAt = Date.now();
      if (e.loaded >= blob.size) fullyReported = true;
      onLoaded(e.loaded);
    });
    xhr.addEventListener('load', () => finish(() => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new HomeServerApiError(`アップロード失敗: HTTP ${xhr.status}`));
    }));
    xhr.addEventListener('error', () => finish(() =>
      reject(new HomeServerApiError('アップロード中にネットワークエラーが発生しました')),
    ));
    xhr.addEventListener('abort', () => finish(() =>
      reject(new HomeServerApiError(stalled
        ? '送信が1分以上進まなかったため中断しました'
        : 'アップロードがキャンセルされました')),
    ));
    xhr.send(blob);
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 動画ファイルを ThinkCentre サーバーへ分割アップロードする。
 * relay（Cloudflare Pages）の 100MB/リクエスト上限を避けるため、サーバー指定のサイズ（50MB）に分けて送る。
 * チャンク単位で再試行し、失敗しても同じファイルを選び直せば受信済みの分を飛ばして再開する。
 * @returns アップロードされた動画の id
 */
export async function uploadVideoToHomeServer(
  baseUrl: string,
  file: File,
  onProgress?: (stats: HomeUploadStats) => void,
): Promise<string> {
  // 1. 前回の続きがあれば再開、無ければ新規開始
  let uploadId = loadResumeId(file);
  let chunkSize = 0;
  let totalChunks = 0;
  let received = new Set<number>();
  if (uploadId) {
    const res = await fetch(`${baseUrl}/api/uploads/${uploadId}`).catch(() => null);
    if (res?.ok) {
      const data = await res.json() as { chunkSize: number; totalChunks: number; receivedChunks: number[] };
      ({ chunkSize, totalChunks } = data);
      received = new Set(data.receivedChunks);
    } else {
      uploadId = null;
    }
  }
  if (!uploadId) {
    const { status, data } = await postJson<{ uploadId?: string; chunkSize?: number; totalChunks?: number; message?: string; error?: string }>(
      `${baseUrl}/api/uploads`,
      { filename: file.name, title: file.name, size: file.size },
    );
    if (status < 200 || status >= 300 || !data.uploadId || !data.chunkSize || !data.totalChunks) {
      throw new HomeServerApiError(data.message ?? `アップロード開始に失敗しました: HTTP ${status}`);
    }
    uploadId = data.uploadId;
    chunkSize = data.chunkSize;
    totalChunks = data.totalChunks;
    saveResumeId(file, uploadId);
  }

  // 2. 未受信のチャンクを順に送る
  const startTime = Date.now();
  const alreadyLoaded = [...received].reduce(
    (sum, i) => sum + Math.min(chunkSize, file.size - i * chunkSize), 0,
  );
  let doneBytes = alreadyLoaded;
  const report = (inFlight: number) => {
    const loaded = doneBytes + inFlight;
    const elapsedSec = (Date.now() - startTime) / 1000;
    const speedBps = elapsedSec > 0 ? (loaded - alreadyLoaded) / elapsedSec : 0;
    onProgress?.({
      percent: Math.min(99, Math.round((loaded / file.size) * 100)), // 100% は結合完了後
      loaded,
      total: file.size,
      speedBps,
      etaSec: speedBps > 0 ? (file.size - loaded) / speedBps : 0,
    });
  };
  report(0);

  for (let i = 0; i < totalChunks; i++) {
    if (received.has(i)) continue;
    const blob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
    for (let attempt = 1; ; attempt++) {
      try {
        await putChunk(`${baseUrl}/api/uploads/${uploadId}/chunks/${i}`, blob, report);
        break;
      } catch (e) {
        if (attempt >= CHUNK_MAX_ATTEMPTS) throw e;
        report(0);
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    doneBytes += blob.size;
    report(0);
  }

  // 3. サーバー側で結合して登録
  const { status, data } = await postJson<{ id?: string; error?: string }>(
    `${baseUrl}/api/uploads/${uploadId}/complete`, {},
  );
  if (status < 200 || status >= 300 || !data.id) {
    throw new HomeServerApiError(`保存の仕上げに失敗しました: ${data.error ?? `HTTP ${status}`}`);
  }
  saveResumeId(file, null);
  onProgress?.({ percent: 100, loaded: file.size, total: file.size, speedBps: 0, etaSec: 0 });
  return data.id;
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
