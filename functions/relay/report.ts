/**
 * POST /relay/report
 * ThinkCentre側（cloudflared）が Quick Tunnel の再接続で新しいURLが
 * 発行されるたびに呼ぶ。以後 /relay/* へのアクセスはこの新URLに転送される。
 *
 * 認証: ヘッダー X-Relay-Secret が RELAY_SECRET（Cloudflare Pages 環境変数）と一致すること。
 *
 * GET /relay/report — 現在保存されているターゲットURLを確認（デバッグ用）
 */

interface Env {
  RELAY_SECRET: string;
  HOME_RELAY_KV: KVNamespace;
}

const TARGET_KEY = 'home-server-target-url';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const target = await ctx.env.HOME_RELAY_KV.get(TARGET_KEY);
  const updatedAt = await ctx.env.HOME_RELAY_KV.get(`${TARGET_KEY}:updated_at`);
  return Response.json({ target, updatedAt });
};

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const secret = ctx.request.headers.get('X-Relay-Secret');
  if (!secret || secret !== ctx.env.RELAY_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await ctx.request.json().catch(() => null) as { url?: string } | null;
  const url = body?.url?.trim();
  if (!url || !/^https:\/\/.+\.trycloudflare\.com$/.test(url)) {
    return Response.json({ error: 'invalid url' }, { status: 400 });
  }

  await ctx.env.HOME_RELAY_KV.put(TARGET_KEY, url);
  await ctx.env.HOME_RELAY_KV.put(`${TARGET_KEY}:updated_at`, new Date().toISOString());

  return Response.json({ status: 'ok', target: url });
};
