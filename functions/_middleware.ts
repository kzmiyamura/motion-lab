/**
 * _middleware.ts
 * すべての /api/* リクエストに適用される共通ミドルウェア。
 * CORS ヘッダーの付与とエラーハンドリングを担う。
 */

export const onRequest: PagesFunction = async (ctx) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // プリフライトリクエスト
  if (ctx.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const response = await ctx.next();
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return Response.json({ error: message }, { status: 500 });
  }
};
