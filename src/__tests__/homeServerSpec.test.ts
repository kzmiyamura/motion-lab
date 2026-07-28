/**
 * フォルダ別MD解析指示書パイプラインのAPIクライアント（engine/homeServer.ts 追加分）のテスト
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authHeaders, getFolderSpec, putFolderSpec, listVideoJobs, reanalyzeVideo,
  HomeServerApiError,
} from '../engine/homeServer';

const BASE = 'https://example.test';

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authHeaders', () => {
  it('トークン未設定時は空オブジェクトを返す（テスト環境では VITE_HOME_SERVER_TOKEN 未設定）', () => {
    expect(authHeaders()).toEqual({});
  });
});

describe('getFolderSpec', () => {
  it('404 のとき null を返す（指示書がまだ無い）', async () => {
    mockFetchOnce(404, { error: 'spec not found' });
    expect(await getFolderSpec(BASE, 'f1')).toBeNull();
  });

  it('200 のとき spec を返す', async () => {
    mockFetchOnce(200, { markdown: '---\npreset: salsa-pair\n---\n# x', preset: 'salsa-pair', version: 1 });
    const spec = await getFolderSpec(BASE, 'f1');
    expect(spec?.preset).toBe('salsa-pair');
  });
});

describe('putFolderSpec', () => {
  it('400 のときサーバーの検証メッセージ付きで HomeServerApiError を投げる', async () => {
    mockFetchOnce(400, { error: 'frontmatter に preset がありません' });
    await expect(putFolderSpec(BASE, 'f1', '# specなし')).rejects.toThrow('frontmatter に preset がありません');
  });

  it('正しいURL・メソッドで送信する', async () => {
    const fn = mockFetchOnce(200, { markdown: 'x', preset: 'salsa-pair', version: 1 });
    await putFolderSpec(BASE, 'f1', 'x');
    expect(fn).toHaveBeenCalledWith(
      `${BASE}/api/folders/f1/spec`,
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});

describe('listVideoJobs', () => {
  it('jobs 配列を返す', async () => {
    mockFetchOnce(200, { jobs: [{ id: 'j1', videoId: 'v1', status: 'done' }] });
    const jobs = await listVideoJobs(BASE, 'v1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('done');
  });
});

describe('reanalyzeVideo', () => {
  it('409 のときサーバーのエラーメッセージを伝える', async () => {
    mockFetchOnce(409, { error: 'このフォルダに解析指示書がありません' });
    await expect(reanalyzeVideo(BASE, 'v1')).rejects.toThrow(HomeServerApiError);
  });
});
