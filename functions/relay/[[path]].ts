/**
 * /relay/* へのリクエストを、KVに保存されている現在の ThinkCentre
 * Quick Tunnel URL へそのまま転送するリバースプロキシ。
 *
 * これにより Motion Lab フロントエンドは常に固定URL
 * （https://motion-lab-apa.pages.dev/relay/...）だけを見ればよくなり、
 * ThinkCentre側のTunnel URLがcloudflared再接続で変わっても
 * フロントエンドの再デプロイが不要になる。
 */

interface Env {
  HOME_RELAY_KV: KVNamespace;
}

const TARGET_KEY = 'home-server-target-url';

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const target = await ctx.env.HOME_RELAY_KV.get(TARGET_KEY);
  if (!target) {
    return Response.json({ error: 'ThinkCentre server URL is not configured yet' }, { status: 503 });
  }

  const params = (ctx.params.path as string[] | undefined) ?? [];
  const url = new URL(ctx.request.url);
  const targetUrl = `${target}/${params.join('/')}${url.search}`;

  const upstream = await fetch(targetUrl, {
    method: ctx.request.method,
    headers: ctx.request.headers,
    body: ['GET', 'HEAD'].includes(ctx.request.method) ? undefined : ctx.request.body,
    // @ts-expect-error Cloudflare Workers specific: リクエストボディのストリーミング転送に必要
    duplex: 'half',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
};
