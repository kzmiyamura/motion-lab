/**
 * Google Identity Services (GSI) — OAuth2 Token Flow
 *
 * 必要な環境変数:
 *   VITE_GOOGLE_CLIENT_ID — Google Cloud Console で発行した OAuth2 クライアントID
 *
 * Authorized JavaScript origins に本番URL と localhost を登録すること。
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: TokenClientConfig): TokenClient;
          revoke(token: string, done: () => void): void;
        };
      };
    };
  }
}

interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type: string }) => void;
}

interface TokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
}

const GSI_SCRIPT_ID = 'gsi-client';

// ── トークンのローカル永続化 ─────────────────────────────────────────────
const LS_TOKEN  = 'gd_access_token';
const LS_EXPIRY = 'gd_token_expiry';
const MARGIN_MS = 120_000; // 期限2分前に「期限切れ」とみなす

function saveToken(token: string, expiresIn: number): void {
  localStorage.setItem(LS_TOKEN,  token);
  localStorage.setItem(LS_EXPIRY, String(Date.now() + expiresIn * 1000));
}

function loadToken(): string | null {
  const token  = localStorage.getItem(LS_TOKEN);
  const expiry = Number(localStorage.getItem(LS_EXPIRY) ?? '0');
  if (token && expiry - MARGIN_MS > Date.now()) return token;
  return null;
}

export function clearStoredToken(): void {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_EXPIRY);
}

function loadGsiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts) { resolve(); return; }
    if (document.getElementById(GSI_SCRIPT_ID)) {
      // Already loading — wait for it
      const existing = document.getElementById(GSI_SCRIPT_ID) as HTMLScriptElement;
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('GSI load failed')));
      return;
    }
    const script = document.createElement('script');
    script.id = GSI_SCRIPT_ID;
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('GSI script load failed'));
    document.head.appendChild(script);
  });
}

/**
 * Drive 読み取り専用トークンを取得（ファイル一覧・ダウンロード用）
 */
export async function requestDriveToken(clientId: string): Promise<string> {
  return _requestToken(clientId, 'https://www.googleapis.com/auth/drive.readonly');
}

/**
 * Drive 読み書きトークンを取得（アップロード・フォルダ作成・共有設定用）
 */
export async function requestDriveWriteToken(clientId: string): Promise<string> {
  return _requestToken(clientId, [
    'https://www.googleapis.com/auth/drive.file',   // 本アプリが作成したファイルの読み書き
    'https://www.googleapis.com/auth/drive.readonly', // 既存ファイルの読み取り（一覧・ダウンロード）
  ].join(' '));
}

async function _requestToken(clientId: string, scope: string): Promise<string> {
  // キャッシュが有効なら即返す（ボタン操作不要）
  const cached = loadToken();
  if (cached) return cached;

  await loadGsiScript();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (res) => {
        if (res.error) { reject(new Error(res.error)); return; }
        // 取得したトークンを localStorage に保存
        saveToken(res.access_token, res.expires_in);
        resolve(res.access_token);
      },
      error_callback: (err) => reject(new Error(err.type)),
    });
    // prompt: '' — 既に同意済みならダイアログを省略
    client.requestAccessToken({ prompt: '' });
  });
}

export function revokeDriveToken(token: string): void {
  clearStoredToken();
  window.google?.accounts.oauth2.revoke(token, () => {});
}
