/**
 * GET /api/health
 * ヘルスチェックエンドポイント。D1・R2 の疎通確認も含む。
 */

interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  APP_ENV: string;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const checks: Record<string, string> = {
    app_env: ctx.env.APP_ENV ?? 'unknown',
  };

  // D1 疎通確認
  try {
    await ctx.env.DB.prepare('SELECT 1').run();
    checks.d1 = 'ok';
  } catch {
    checks.d1 = 'unavailable';
  }

  // R2 疎通確認
  try {
    await ctx.env.STORAGE.list({ limit: 1 });
    checks.r2 = 'ok';
  } catch {
    checks.r2 = 'unavailable';
  }

  return Response.json({ status: 'ok', checks, ts: new Date().toISOString() });
};
