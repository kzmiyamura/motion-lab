/**
 * フォルダ別MD解析指示書パイプラインのAPIクライアント（engine/homeServer.ts 追加分）のテスト
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authHeaders, getFolderSpec, putFolderSpec, listVideoJobs, reanalyzeVideo,
  HomeServerApiError, summarizeVideoJobs, staleReportNote, isRateLimitError,
  type AnalysisJob,
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

function job(id: string, status: AnalysisJob['status'], errorMessage: string | null = null): AnalysisJob {
  return { id, videoId: 'v1', status, preset: 'salsa-pair', retryCount: 0, errorMessage, createdAt: '', finishedAt: null };
}

describe('summarizeVideoJobs', () => {
  it('ジョブが無ければ undefined', () => {
    expect(summarizeVideoJobs([])).toBeUndefined();
  });

  it('最新が成功ならそれを lastDone にする', () => {
    const s = summarizeVideoJobs([job('j3', 'done'), job('j2', 'done')]);
    expect(s?.latest.id).toBe('j3');
    expect(s?.lastDone?.id).toBe('j3');
  });

  it('最新が失敗でも、前回の成功ジョブを lastDone にする（新しい順で最初の done）', () => {
    const s = summarizeVideoJobs([job('03dfd15b', 'error', '429'), job('581ef6a2', 'done'), job('3e58a27a', 'done')]);
    expect(s?.latest.id).toBe('03dfd15b');
    expect(s?.lastDone?.id).toBe('581ef6a2');
  });

  it('成功ジョブが1つも無ければ lastDone は undefined', () => {
    const s = summarizeVideoJobs([job('j2', 'error'), job('j1', 'error')]);
    expect(s?.lastDone).toBeUndefined();
  });
});

describe('staleReportNote', () => {
  it('最新が成功なら注記なし', () => {
    expect(staleReportNote(job('j', 'done'))).toBeNull();
  });

  it('レート制限での失敗は理由付きの注記', () => {
    expect(staleReportNote(job('j', 'error', '[CLAUDE] レート制限リトライ上限（3回）に達しました。')))
      .toBe('再解析は上限で失敗（前回の結果を表示中）');
    expect(staleReportNote(job('j', 'error', 'API Error: 429 session limit reached')))
      .toBe('再解析は上限で失敗（前回の結果を表示中）');
  });

  it('その他の失敗・実行中・待ち', () => {
    expect(staleReportNote(job('j', 'error', '[TIMEOUT] Claude 実行が2回タイムアウトしました'))).toBe('再解析は失敗（前回の結果を表示中）');
    expect(staleReportNote(job('j', 'running'))).toBe('再解析中…（前回の結果を表示中）');
    expect(staleReportNote(job('j', 'queued'))).toBe('再解析待ち（前回の結果を表示中）');
  });
});

describe('isRateLimitError', () => {
  it('null や無関係なメッセージは false', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError('[CV] analyze_pair.py exit 1')).toBe(false);
  });
});

describe('reanalyzeVideo', () => {
  it('409 のときサーバーのエラーメッセージを伝える', async () => {
    mockFetchOnce(409, { error: 'このフォルダに解析指示書がありません' });
    await expect(reanalyzeVideo(BASE, 'v1')).rejects.toThrow(HomeServerApiError);
  });
});
