import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import {
  countAt, fmtRotations, holdLabel, moveFramesPending, parseChoreoSheet, parseMoveFrames, passLabel,
  reportSummary, turnLabel,
} from '../engine/choreoSheet';

vi.mock('../engine/homeServer', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../engine/homeServer')>();
  return { ...orig, getJobDetail: vi.fn() };
});

import { getJobDetail } from '../engine/homeServer';
import { ReportModal } from '../components/ReportModal';

const JOB_ID = 'job-1';
const BASE = 'https://home.example';
const INDEX_URL = `${BASE}/analysis-output/${JOB_ID}/out/move_frames/index.json`;

const RESULT = {
  leader: { side: 'right', confidence: 0.9, basis: 'keyframe' },
  style: { onBeat: 'on1', confidence: 0.7, basis: 'measurement' },
  routine: {
    timing: 'on1',
    bpm: 96,
    moves: [
      {
        start: 0, counts: 8, move: 'basic', name: 'ベーシック', holdStart: 'LR', holdEnd: 'LR', passSide: null, turn: null, evidence: 'seen', confidence: 0.8,
        steps: [{ count: '1-2-3', leader: '前へ', follower: '後ろへ' }, { count: '5-6-7', leader: '後ろへ', follower: '前へ' }],
      },
      { start: 5, counts: 8, move: 'cbl', name: 'CBL', holdStart: 'LR', holdEnd: 'LR', passSide: 'left', turn: { by: 'follower', direction: 'left', rotations: 0.5 }, evidence: 'seen', confidence: 0.7 },
      {
        start: 14.2, counts: 8, move: 'cbl_inside_turn', name: 'CBL＋インサイドターン?', holdStart: 'LR', holdEnd: 'RR', passSide: 'left', turn: { by: 'follower', direction: 'left', rotations: 1.5 }, evidence: 'inferred', confidence: 0.4,
        steps: [
          { count: '1-2-3', leader: '左へ開き手を上げる', follower: '前へ' },
          { count: '5-6-7', leader: '頭上で回す', follower: '左回り1½' },
          { count: '1-2-3', leader: '3行目は出さない', follower: 'x' },
        ],
      },
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
  it('手・回転・通る側は記号でなく普通の言葉', () => {
    expect(fmtRotations(1.5)).toBe('1½');
    expect(fmtRotations(0.5)).toBe('½');
    expect(fmtRotations(2)).toBe('2');
    expect(holdLabel('RR', 'RR')).toBe('右手同士（握手）でつなぐ');
    expect(holdLabel('LR', 'LR')).toBe('男の左手と女の右手でつなぐ');
    expect(holdLabel('LL', 'RR')).toBe('左手同士 → 右手同士（握手）に持ち替え');
    expect(holdLabel('LR', 'none')).toBe('男の左手と女の右手 → 手を離す');
    expect(holdLabel('none', 'none')).toBe('手を離す');
    expect(holdLabel(null, null)).toBeNull();
    expect(turnLabel({ by: 'follower', direction: 'left', rotations: 1.5 })).toBe('女が左回り1½回転');
    expect(turnLabel({ by: 'leader', direction: 'right', rotations: 1 })).toBe('男が右回り1回転');
    expect(turnLabel({ by: 'follower', direction: null, rotations: 2 })).toBe('女が2回転');
    expect(turnLabel(null)).toBeNull();
    expect(passLabel('left')).toBe('女が男の左側を通る');
  });

  it('result.json から行を作る', () => {
    const s = parseChoreoSheet(JSON.stringify(RESULT))!;
    expect(s.header).toEqual(['On1', 'BPM 96', '男＝右スタート']);
    expect(s.beatSec).toBeCloseTo(0.625);
    expect(s.rows).toHaveLength(4);
    expect(s.rows[2]).toMatchObject({
      no: 3, time: '0:14', counts: '1-8', name: 'CBL＋インサイドターン', start: 14.2, end: 19.4,
      hold: '男の左手と女の右手 → 右手同士（握手）に持ち替え', turn: '女が左回り1½回転', pass: '女が男の左側を通る', uncertain: true,
    });
    // steps は最大2行
    expect(s.rows[2].steps).toEqual([
      { count: '1-2-3', leader: '左へ開き手を上げる', follower: '前へ' },
      { count: '5-6-7', leader: '頭上で回す', follower: '左回り1½' },
    ]);
    expect(s.rows[1].steps).toEqual([]);
    expect(s.rows[0].uncertain).toBe(false);
    // name 省略時は技の語彙から。confidence が低い行は「?」。最後の行の終わりは counts × 拍
    expect(s.rows[3]).toMatchObject({ name: '右ターン', counts: '1-16', turn: '女が右回り1回転', uncertain: true, hold: null });
    expect(s.rows[3].end).toBeCloseTo(19.4 + 16 * 0.625);
  });

  it('動きから推定したテンポは「推定」と書き、格子の拍を使う', () => {
    const s = parseChoreoSheet(JSON.stringify({
      routine: { timing: 'unclear', bpm: 195, bpmSource: 'routine', grid: { beatSec: 0.3076 }, moves: [{ start: 0, move: 'basic' }] },
    }))!;
    expect(s.header).toEqual(['テンポ≈195（推定）']);
    expect(s.beatSec).toBe(0.3076);
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
    expect([...m.entries()]).toEqual([[0, { strip: '/a/01.jpg', frames: [] }]]);
  });

  it('v2 の index.json は1コマずつの写真を読む（帯も残す）', () => {
    const s = parseChoreoSheet(JSON.stringify(RESULT))!;
    const m = parseMoveFrames({
      version: 2,
      moves: [
        { index: 1, start: 5, url: '/a/02.jpg', frames: [{ t: 5, url: '/a/02_0.jpg' }, { url: '/a/02_1.jpg' }, { t: 6 }] },
        { index: 2, start: 14.2, frames: [] },
      ],
    }, s.rows);
    expect([...m.entries()]).toEqual([
      [1, { strip: '/a/02.jpg', frames: [{ t: 5, url: '/a/02_0.jpg' }, { t: null, url: '/a/02_1.jpg' }] }],
    ]);
  });

  it('作成途中の index.json を見分ける（古い形式は完成扱い）', () => {
    expect(moveFramesPending({ complete: false, moves: [] })).toBe(true);
    expect(moveFramesPending({ complete: true, moves: [] })).toBe(false);
    expect(moveFramesPending({ version: 1, moves: [] })).toBe(false);
  });

  it('カウント（技の頭 = 1）', () => {
    expect(countAt(10, 10, 0.5)).toBe(1);
    expect(countAt(10.49, 10, 0.5)).toBe(1);
    expect(countAt(10.5, 10, 0.5)).toBe(2);
    expect(countAt(13.6, 10, 0.5)).toBe(8);
    expect(countAt(14.0, 10, 0.5)).toBe(1);
  });

  it('新形式レポートの冒頭サマリは、最初の段落の頭から文単位で短い1行だけ', () => {
    expect(reportSummary(REPORT_MD)).toEqual(['右の男性（黒シャツ）がリーダー。On1・BPM 96。']);
    expect(reportSummary('# 旧\n\n長い結論\n## 1. 結論')).toEqual([]);
    // 実際のレポート（2f4b6919）: 長い段落は文の途中で切らず、収まる文までで止める
    const real = [
      '# Fadi Fusion & Linda Aramendiz ソーシャル（Stardance）',
      '',
      'リーダーは開始時点で画面右にいる帽子・白黒柄シャツの男性。スタイルの On1/On2 は不明。音声なし（画面収録）なので、テンポは 1×8 ≈ 2.4秒と推定した。',
      '即興の多いソーシャルで、技は CBL とインサイドターンが中心。そこに男性の自分ターンとクローズドの密着ベーシックが混ざる。カメラが2人の周りを回り込む撮影。',
      '',
      '## 振付シート',
      '## 詳細（根拠）',
    ].join('\n');
    expect(reportSummary(real)).toEqual(['リーダーは開始時点で画面右にいる帽子・白黒柄シャツの男性。スタイルの On1/On2 は不明。']);
    // 最初の文だけで長すぎるなら出さない
    expect(reportSummary(`# t\n\n${'あ'.repeat(80)}。\n## 詳細`)).toEqual([]);
    // 技名の「?」では切らない
    expect(reportSummary('# t\n\n技は CBL＋アウトサイド? が中心。\n## 詳細')).toEqual(['技は CBL＋アウトサイド? が中心。']);
  });
});

describe('ReportModal の振付シート表示', () => {
  beforeEach(() => {
    vi.mocked(getJobDetail).mockResolvedValue({
      id: JOB_ID, videoId: 'v', status: 'done', preset: 'salsa-pair', retryCount: 0,
      errorMessage: null, createdAt: '', finishedAt: null,
      reportMd: REPORT_MD, resultJson: JSON.stringify(RESULT), specSnapshot: '',
    } as Awaited<ReturnType<typeof getJobDetail>>);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(INDEX_URL);
      expect(init?.cache).toBe('no-store');
      return {
        ok: true,
        json: async () => ({ version: 1, moves: [{ index: 2, start: 14.2, end: 19.4, url: `/analysis-output/${JOB_ID}/out/move_frames/03_014.2.jpg` }] }),
      };
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('1行 = 1技のカード（技名・カウントごとの動き・普通の言葉・写真）で出し、詳細は折りたたむ', async () => {
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
    expect(third.getByText('5-6-7')).toBeInTheDocument();
    expect(third.getByText('頭上で回す')).toBeInTheDocument();
    expect(third.getByText('左回り1½')).toBeInTheDocument();
    expect(third.getByText('男の左手と女の右手 → 右手同士（握手）に持ち替え ／ 女が左回り1½回転 ／ 女が男の左側を通る')).toBeInTheDocument();
    expect(third.queryByText('3行目は出さない')).toBeNull();
    await waitFor(() => {
      expect(third.getByRole('img')).toHaveAttribute('src', `${BASE}/analysis-output/${JOB_ID}/out/move_frames/03_014.2.jpg`);
    });
    expect(within(rows[0]).queryByRole('img')).toBeNull();
    expect(within(rows[0]).queryByLabelText('推定')).toBeNull();
    // 元動画が無ければカードは押せない
    expect(rows[0]).not.toHaveAttribute('role', 'button');

    // 詳細（元の Markdown）は押すまで出ない
    expect(screen.queryByText('詳しい根拠の文章')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /詳細を表示/ }));
    expect(screen.getByText('詳しい根拠の文章')).toBeInTheDocument();
  });

  it('v2 の写真は1コマずつ横スクロールの列で出す', async () => {
    const frames = [0, 1, 2, 3, 4].map(k => ({ t: 14.2 + k, url: `/analysis-output/${JOB_ID}/out/move_frames/03_014.2_${k}.jpg` }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: 2, complete: true, moves: [{ index: 2, start: 14.2, end: 19.4, url: `/analysis-output/${JOB_ID}/out/move_frames/03_014.2.jpg`, frames }] }),
    })));
    render(<ReportModal jobId={JOB_ID} videoTitle="テスト" baseUrl={BASE} onClose={() => {}} />);
    const rows = await screen.findAllByTestId('choreo-row');
    const third = within(rows[2]);
    await waitFor(() => expect(third.getAllByRole('img')).toHaveLength(5));
    const imgs = third.getAllByRole('img');
    expect(imgs[0]).toHaveAttribute('src', `${BASE}/analysis-output/${JOB_ID}/out/move_frames/03_014.2_0.jpg`);
    expect(imgs[4]).toHaveAttribute('alt', '#3 CBL＋インサイドターン 5/5コマ目');
    expect(third.getByTestId('choreo-shots')).toBeInTheDocument();
    // 元動画が無い（カードが押せない）ときは、コマを押すと原寸を開く
    expect(imgs[1].closest('a')).toHaveAttribute('href', `${BASE}/analysis-output/${JOB_ID}/out/move_frames/03_014.2_1.jpg`);
  });

  it('写真がまだ無い・作成途中なら、揃うまで読み直す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const responses = [
      { ok: false, json: async () => null },
      { ok: true, json: async () => ({ version: 1, complete: false, moves: [] }) },
      { ok: true, json: async () => ({ version: 1, complete: true, moves: [{ index: 0, start: 0, end: 5, url: '/x/01.jpg' }] }) },
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? responses[0]);
    vi.stubGlobal('fetch', fetchMock);
    render(<ReportModal jobId={JOB_ID} videoTitle="テスト" baseUrl={BASE} onClose={() => {}} />);
    const rows = await screen.findAllByTestId('choreo-row');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(within(rows[0]).queryByRole('img')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
    await waitFor(() => expect(within(rows[0]).getByRole('img')).toHaveAttribute('src', `${BASE}/x/01.jpg`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 完成したらもう読まない
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('元動画があればカードを押すとその技の区間をスロー再生する', async () => {
    render(<ReportModal jobId={JOB_ID} videoTitle="テスト" baseUrl={BASE} videoUrl={`${BASE}/hls/v/playlist.m3u8`} onClose={() => {}} />);
    const rows = await screen.findAllByTestId('choreo-row');
    expect(screen.queryByText(/0\.5×/)).toBeNull();
    fireEvent.click(rows[2]);
    expect(await screen.findByText('#3 CBL＋インサイドターン（1-8）')).toBeInTheDocument();
    expect(screen.getByText('0.5×')).toBeInTheDocument();
    expect(rows[2]).toHaveAttribute('aria-label', '#3 CBL＋インサイドターン を再生');
    // もう一度押すと閉じる
    fireEvent.click(rows[2]);
    await waitFor(() => expect(screen.queryByText('0.5×')).toBeNull());
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
