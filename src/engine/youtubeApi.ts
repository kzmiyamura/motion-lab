/**
 * YouTube Data API v3 — 動画検索
 *
 * 必要な環境変数:
 *   VITE_YOUTUBE_API_KEY  — Google Cloud Console で発行した API キー
 *
 * ローカル: .env.local に記述
 * Cloudflare Pages: ダッシュボード → Settings → Environment Variables に追加
 */

const API_KEY = (import.meta.env.VITE_YOUTUBE_API_KEY ?? '') as string;
const ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';

export interface YTVideoItem {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
}

export class YouTubeApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = status;
  }
}

export async function searchYouTube(
  query: string,
  maxResults = 12,
): Promise<YTVideoItem[]> {
  if (!API_KEY) {
    throw new YouTubeApiError(
      'YouTube API キーが設定されていません。\n' +
      '.env.local に VITE_YOUTUBE_API_KEY を追加してください。',
    );
  }

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    q: query,
    maxResults: String(maxResults),
    key: API_KEY,
  });

  const res = await fetch(`${ENDPOINT}?${params}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as {
      error?: { message?: string };
    };
    throw new YouTubeApiError(
      body?.error?.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  const data = await res.json() as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: {
        title?: string;
        channelTitle?: string;
        thumbnails?: {
          medium?: { url?: string };
          default?: { url?: string };
        };
      };
    }>;
  };

  return (data.items ?? [])
    .filter(item => !!item.id?.videoId)
    .map(item => ({
      videoId: item.id!.videoId!,
      title: item.snippet?.title ?? '',
      channelTitle: item.snippet?.channelTitle ?? '',
      thumbnailUrl:
        item.snippet?.thumbnails?.medium?.url ??
        item.snippet?.thumbnails?.default?.url ??
        '',
    }));
}
