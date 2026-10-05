import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { isGeneralJob, nearestStill, parseGeneralResult, stillImagesFrom } from '../engine/generalReport';

vi.mock('../engine/homeServer', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../engine/homeServer')>();
  return { ...orig, getJobDetail: vi.fn() };
});
import { getJobDetail } from '../engine/homeServer';
import { ReportModal } from '../components/ReportModal';

const JOB_ID = 'job-g';
const BASE = 'https://home.example';
const RESULT = {
  summary: '2 人が踊っている',
  findings: [
    { t: 3.46, title: '2 人が重なる', detail: '女性が手前' },
    { t: 40, title: '手を放す', detail: '離れる' },
  ],
  limitations: '手元は読めない',
};
const MEASUREMENTS = {
  summary: { imageIndex: [
    { file: '000003.5_peak.jpg', kind: 'single', times: [3.5], ranges: [[3.5, 3.5]] },
    { file: 'sheet_10.jpg', kind: 'sheet', times: [9.8, 10], ranges: [[9.8, 10]] },
  ] },
};

function mockJob(preset: string, resultJson: unknown, reportMd = '# レポート\n本文です') {
  vi.mocked(getJobDetail).mockResolvedValue({
    id: JOB_ID, videoId: 'v', status: 'done', preset, retryCount: 0,
    errorMessage: null, createdAt: '', finishedAt: null,
    reportMd, resultJson: JSON.stringify(resultJson), specSnapshot: '',
  } as Awaited<ReturnType<typeof getJobDetail>>);
}

describe('generalReport engine', () => {
  it('preset または routine の有無で general を判定する', () => {
    expect(isGeneralJob('general', null)).toBe(true);
    expect(isGeneralJob('salsa-pair', JSON.stringify(RESULT))).toBe(false);
    expect(isGeneralJob('other', JSON.stringify(RESULT))).toBe(true);
    expect(isGeneralJob('other', JSON.stringify({ ...RESULT, routine: { moves: [] } }))).toBe(false);
  });
  it('findings を読み、単独の静止画から近いものを選ぶ', () => {
    expect(parseGeneralResult(JSON.stringify(RESULT))?.findings).toHaveLength(2);
    const imgs = stillImagesFrom(MEASUREMENTS);
    expect(imgs).toEqual([{ t: 3.5, file: '000003.5_peak.jpg' }]);
    expect(nearestStill(imgs, 3.46)?.file).toBe('000003.5_peak.jpg');
    expect(nearestStill(imgs, 40)).toBeNull();
  });
});

describe('ReportModal の汎用解析表示', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('general のジョブは所見の一覧・近い静止画・本文の開閉を出す', async () => {
    mockJob('general', RESULT);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => MEASUREMENTS })));
    render(<ReportModal jobId={JOB_ID} videoTitle="t" baseUrl={BASE} onClose={() => {}} />);
    const cards = await screen.findAllByTestId('general-finding');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('0:03');
    expect(cards[0].textContent).toContain('2 人が重なる');
    await waitFor(() => expect(cards[0].querySelector('img')?.getAttribute('src'))
      .toBe(`${BASE}/analysis-output/${JOB_ID}/out/keyframes/000003.5_peak.jpg`));
    expect(cards[1].querySelector('img')).toBeNull();
    expect(screen.queryByTestId('choreo-row')).toBeNull();
    expect(screen.queryByText('本文です')).toBeNull();
    fireEvent.click(screen.getByText(/レポート本文を表示/));
    expect(screen.getByText('本文です')).toBeTruthy();
  });

  it('salsa-pair で routine が無いジョブは今までどおり Markdown だけ', async () => {
    mockJob('salsa-pair', RESULT);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    render(<ReportModal jobId={JOB_ID} videoTitle="t" baseUrl={BASE} onClose={() => {}} />);
    expect(await screen.findByText('本文です')).toBeTruthy();
    expect(screen.queryByTestId('general-report')).toBeNull();
  });
});
