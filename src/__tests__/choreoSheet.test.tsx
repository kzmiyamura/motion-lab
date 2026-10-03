import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  fmtRotations, holdLabel, parseChoreoSheet, parseMoveFrames, reportSummary, turnLabel,
} from '../engine/choreoSheet';

vi.mock('../engine/homeServer', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../engine/homeServer')>();
  return { ...orig, getJobDetail: vi.fn() };
});

import { getJobDetail } from '../engine/homeServer';
import { ReportModal } from '../components/ReportModal';

const JOB_ID = 'job-1';
const BASE = 'https://home.example';

const RESULT = {
  leader: { side: 'right', confidence: 0.9, basis: 'keyframe' },
  style: { onBeat: 'on1', confidence: 0.7, basis: 'measurement' },
  routine: {
    timing: 'on1',
    bpm: 96,
    moves: [
      { start: 0, counts: 8, move: 'basic', name: 'ベーシック', holdStart: 'LR', holdEnd: 'LR', passSide: null, turn: null, evidence: 'seen', confidence: 0.8 },
      { start: 5, counts: 8, move: 'cbl', name: 'CBL', holdStart: 'LR', holdEnd: 'LR', passSide: 'left', turn: { by: 'follower', direction: 'left', rotations: 0.5 }, evidence: 'seen', confidence: 0.7 },
      { start: 14.2, counts: 8, move: 'cbl_inside_turn', name: 'CBL＋インサイドターン?', holdStart: 'LR', holdEnd: 'RR', passSide: 'left', turn: { by: 'follower', direction: 'left', rotations: 1.5 }, evidence: 'inferred', confidence: 0.4 },
      { start: 19.4, counts: 16, move: 'right_turn', holdStart: null, holdEnd: null, passSide: null, turn: { by: 'follower', direction: 'right', rotations: 1 }, evidence: 'seen', confidence: 0.3 },
    ],
  },
};

const REPORT_MD = [
  '# サルサ解析',
  '',
  '右の男性（黒シャツ）がリーダー。On1・BPM 96。',
  'ベーシックから CBL 系を中心に回す流れ。',
  '',
  '## 振付シート',
  '',
  '| # | 時刻 | カウント | 技 | 手 | 回転 |',
  '|---|---|---|---|---|---|',
  '| 1 | 0:00 | 1-8 | ベーシック | 男左×女右 | — |',
  '',
  '## 詳細（根拠）',
  '',
  '### 根拠',
  '- 詳しい根拠の文章',
].join('\n');

describe('choreoSheet（純関数）', () => {
  it('記号の組み立て', () => {
    expect(fmtRotations(1.5)).toBe('1½');
    expect(fmtRotations(0.5)).toBe('½');
    expect(fmtRotations(2)).toBe('2');
    expect(holdLabel('LR', 'LR')).toBe('男左×女右');
    expect(holdLabel('LR', 'RR')).toBe('男左×女右→男右×女右');
    expect(holdLabel(null, 'RL')).toBe('男右×女左');
    expect(holdLabel(null, null)).toBeNull();
    expect(turnLabel({ by: 'follower', direction: 'left', rotations: 1.5 })).toBe('女↺1½');
    expect(turnLabel({ by: 'leader', direction: 'right', rotations: 1 })).toBe('男↻1');
    expect(turnLabel({ by: 'follower', direction: null, rotations: 2 })).toBe('女回転2');
    expect(turnLabel(null)).toBeNull();
  });

  it('result.json から行を作る', () => {
    const s = parseChoreoSheet(JSON.stringify(RESULT))!;
    expect(s.header).toEqual(['On1', 'BPM 96', '男＝右スタート']);
    expect(s.rows).toHaveLength(4);
    expect(s.rows[2]).toMatchObject({
      no: 3, time: '0:14', counts: '1-8', name: 'CBL＋インサイドターン',
      hold: '男左×女右→男右×女右', turn: '女↺1½', pass: '左通過', uncertain: true,
    });
    expect(s.rows[0].uncertain).toBe(false);
    // name 省略時は技の語彙から。confidence が低い行は「?」
    expect(s.rows[3]).toMatchObject({ name: '右ターン', counts: '1-16', turn: '女↻1', uncertain: true, hold: null });
  });

  it('routine が無ければ null', () => {
    expect(parseChoreoSheet(JSON.stringify({ events: [] }))).toBeNull();
    expect(parseChoreoSheet('not json')).toBeNull();
    expect(parseChoreoSheet(null)).toBeNull();
  });

  it('move_frames/index.json の開始時刻が合わない画像は使わない', () => {
    const s = parseChoreoSheet(JSON.stringify(RESULT))!;
    const m = parseMoveFrames({
      moves: [
        { index: 0, start: 0, url: '/a/01.jpg' },
        { index: 1, start: 9.9, url: '/a/02.jpg' },
        { index: 9, start: 0, url: '/a/10.jpg' },
      ],
    }, s.rows);
    expect([...m.entries()]).toEqual([[0, '/a/01.jpg']]);
  });

  it('新形式レポートの冒頭サマリだけを取る', () => {
    expect(reportSummary(REPORT_MD)).toEqual([
      '右の男性（黒シャツ）がリーダー。On1・BPM 96。',
      'ベーシックから CBL 系を中心に回す流れ。',
    ]);
    expect(reportSummary('# 旧\n\n長い結論\n## 1. 結論')).toEqual([]);
  });
});

describe('ReportModal の振付シート表示', () => {
  beforeEach(() => {
    vi.mocked(getJobDetail).mockResolvedValue({
      id: JOB_ID, videoId: 'v', status: 'done', preset: 'salsa-pair', retryCount: 0,
      errorMessage: null, createdAt: '', finishedAt: null,
      reportMd: REPORT_MD, resultJson: JSON.stringify(RESULT), specSnapshot: '',
    } as Awaited<ReturnType<typeof getJobDetail>>);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/analysis-output/${JOB_ID}/out/move_frames/index.json`);
      return {
        ok: true,
        json: async () => ({ version: 1, moves: [{ index: 2, start: 14.2, end: 19.4, url: `/analysis-output/${JOB_ID}/out/move_frames/03_014.2.jpg` }] }),
      };
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1行 = 1技のカードで出し、詳細は折りたたむ', async () => {
    render(<ReportModal jobId={JOB_ID} videoTitle="テスト" baseUrl={BASE} onClose={() => {}} />);
    const rows = await screen.findAllByTestId('choreo-row');
    expect(rows).toHaveLength(4);
    expect(screen.getByText('On1 · BPM 96 · 男＝右スタート')).toBeInTheDocument();
    expect(screen.getByText('右の男性（黒シャツ）がリーダー。On1・BPM 96。')).toBeInTheDocument();

    const third = within(rows[2]);
    expect(third.getByText('#3')).toBeInTheDocument();
    expect(third.getByText('0:14')).toBeInTheDocument();
    expect(third.getByText('CBL＋インサイドターン')).toBeInTheDocument();
    expect(third.getByLabelText('推定')).toBeInTheDocument();
    expect(third.getByText('男左×女右→男右×女右')).toBeInTheDocument();
    expect(third.getByText('女↺1½')).toBeInTheDocument();
    expect(third.getByText('左通過')).toBeInTheDocument();
    await waitFor(() => {
      expect(third.getByRole('img')).toHaveAttribute('src', `${BASE}/analysis-output/${JOB_ID}/out/move_frames/03_014.2.jpg`);
    });
    expect(within(rows[0]).queryByRole('img')).toBeNull();
    expect(within(rows[0]).queryByLabelText('推定')).toBeNull();

    // 詳細（元の Markdown）は押すまで出ない
    expect(screen.queryByText('詳しい根拠の文章')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /詳細を表示/ }));
    expect(screen.getByText('詳しい根拠の文章')).toBeInTheDocument();
  });

  it('routine が無いジョブは従来の Markdown をそのまま出す', async () => {
    vi.mocked(getJobDetail).mockResolvedValue({
      id: JOB_ID, videoId: 'v', status: 'done', preset: 'salsa-pair', retryCount: 0,
      errorMessage: null, createdAt: '', finishedAt: null,
      reportMd: '# 旧レポート\n\n- 旧本文', resultJson: JSON.stringify({ events: [] }), specSnapshot: '',
    } as Awaited<ReturnType<typeof getJobDetail>>);
    render(<ReportModal jobId={JOB_ID} videoTitle="テスト" baseUrl={BASE} onClose={() => {}} />);
    expect(await screen.findByText('旧本文')).toBeInTheDocument();
    expect(screen.queryByTestId('choreo-row')).toBeNull();
    expect(screen.queryByRole('button', { name: /詳細を表示/ })).toBeNull();
  });
});
