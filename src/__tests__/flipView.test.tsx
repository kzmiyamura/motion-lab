import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';

vi.mock('../engine/homeServer', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../engine/homeServer')>();
  return { ...orig, getJobDetail: vi.fn() };
});

import { getJobDetail } from '../engine/homeServer';
import { ReportModal } from '../components/ReportModal';
import { parseChoreoSheet, type ChoreoSheetData, type SheetRow } from '../engine/choreoSheet';
import {
  clampPage, dragOffset, frameAt, frameBeats, frameCaption, frameDurationsMs, frameSpans, keyStep, loadReportView,
  loopTime, moveWindow, pageLabel, parseFlipIndex, preloadUrls, rowCounts, saveReportView, sourceFromFrameSet,
  splitStrip, stripTileCount, swipeStep, VIEW_STORAGE_KEY, type FlipFrame,
  FLIP_SPEEDS, SPEED_STORAGE_KEY, loadFlipSpeed, saveFlipSpeed,
} from '../engine/flipView';
import { FlipView } from '../components/FlipView';

const BEAT = 0.32;

function row(over: Partial<SheetRow> = {}): SheetRow {
  return {
    index: 0, no: 1, start: 10, end: 10 + 8 * BEAT, time: '0:10', counts: '1-8', name: 'CBL',
    steps: [], hold: null, turn: null, leaderTurn: null, pass: null, uncertain: false, diagram: null, startPos: null, ...over,
  };
}

describe('めくり: コマの時間割', () => {
  const win = { start: 10, end: 10 + 8 * BEAT };

  it('時刻のあるコマは次のコマまで出る（カウントの持ち分）', () => {
    const frames: FlipFrame[] = [
      { url: 'a', t: 10, count: 1 }, { url: 'b', t: 10 + 2 * BEAT, count: 3 },
      { url: 'c', t: 10 + 4 * BEAT, count: 5 }, { url: 'd', t: 10 + 7 * BEAT, count: 8 },
    ];
    const spans = frameSpans(frames, win, BEAT);
    expect(frameBeats(spans, BEAT).map(b => Math.round(b * 100) / 100)).toEqual([2, 2, 3, 1]);
    // 0.5 倍なら 2 倍の長さ（壁時計）
    expect(frameDurationsMs(spans, 0.5).map(Math.round)).toEqual([1280, 1280, 1920, 640]);
    expect(frameDurationsMs(spans, 1).map(Math.round)).toEqual([640, 640, 960, 320]);
    expect(frameAt(spans, 10)).toBe(0);
    expect(frameAt(spans, 10 + 2.5 * BEAT)).toBe(1);
    expect(frameAt(spans, 10 + 7.9 * BEAT)).toBe(3);
  });

  it('最初のコマが区間の頭より後でも頭から出す。区間の外の時刻は寄せる', () => {
    const spans = frameSpans([{ url: 'a', t: 10.2 }, { url: 'b', t: 99 }], win, BEAT);
    expect(spans[0].start).toBe(10);
    expect(spans[1]).toEqual({ start: win.end, end: win.end });
    expect(frameAt(spans, 12)).toBe(0);
  });

  it('時刻が無くカウントがあれば拍から、どちらも無ければ等分', () => {
    const byCount = frameSpans([{ url: 'a', t: null, count: 1 }, { url: 'b', t: null, count: 5 }], win, BEAT);
    expect(byCount[1].start).toBeCloseTo(10 + 4 * BEAT);
    const even = frameSpans([{ url: 'a', t: null }, { url: 'b', t: null }, { url: 'c', t: null }, { url: 'd', t: null }], win, BEAT);
    expect(frameBeats(even, BEAT).map(b => Math.round(b * 100) / 100)).toEqual([2, 2, 2, 2]);
  });

  it('技の区間: 時刻の無い行はカウント数 × 拍', () => {
    expect(moveWindow(row(), BEAT)).toEqual({ start: 10, end: 10 + 8 * BEAT });
    expect(moveWindow(row({ start: null, end: null, counts: '1-16' }), BEAT)).toEqual({ start: 0, end: 16 * BEAT });
    expect(rowCounts({ counts: '1-16' })).toBe(16);
  });

  it('繰り返し: 終わりを過ぎたら頭へ', () => {
    expect(loopTime(10 + 8 * BEAT + 0.1, win)).toBeCloseTo(10.1);
    expect(loopTime(9, win)).toBe(10);
    expect(loopTime(10.5, win)).toBe(10.5);
  });

  it('コマの大きな字は「2 通過」。拍の間は「2&」、最初のコマは立ち位置', () => {
    expect(frameCaption({ count: 2, label: '通過' })).toBe('2 通過');
    expect(frameCaption({ count: 4 })).toBe('4');
    expect(frameCaption({})).toBe('');
    expect(frameCaption({ count: 2, half: true })).toBe('2&');
    expect(frameCaption({ half: true })).toBe('&');
    expect(frameCaption({ count: 1, label: 'スタート（女は左）' }, 0, '男右・女左')).toBe('1 男右・女左');
    expect(frameCaption({ count: 1, label: 'スタート（女は左）' }, 0, null)).toBe('1 スタート（女は左）');
    expect(frameCaption({ count: 3, label: '通過' }, 4, '男右・女左')).toBe('3 通過');
  });

  it('半拍のコマ（新しい flip[]）も 1 拍のコマ（古い flip[]）も時刻どおりに並ぶ', () => {
    const half: FlipFrame[] = Array.from({ length: 16 }, (_, k) => ({
      url: `h${k}`, t: 10 + (k * BEAT) / 2, count: Math.floor(k / 2) + 1, ...(k % 2 ? { half: true } : {}),
    }));
    const spans = frameSpans(half, win, BEAT);
    expect(frameBeats(spans, BEAT).every(b => Math.abs(b - 0.5) < 1e-6)).toBe(true);
    // 0.25 倍: 半拍 = 0.16 秒 → 0.64 秒（壁時計）
    expect(frameDurationsMs(spans, 0.25).map(Math.round)[0]).toBe(640);
    expect(frameAt(spans, 10 + 1.6 * BEAT)).toBe(3);
    const old: FlipFrame[] = Array.from({ length: 8 }, (_, k) => ({ url: `o${k}`, t: 10 + k * BEAT, count: k + 1 }));
    expect(frameBeats(frameSpans(old, win, BEAT), BEAT).every(b => Math.abs(b - 1) < 1e-6)).toBe(true);
  });

  it('速さは 0.25 / 0.5 / 1 倍、既定は 0.25 倍。保存した速さを覚える', () => {
    localStorage.clear();
    expect(FLIP_SPEEDS).toEqual([0.25, 0.5, 1]);
    expect(loadFlipSpeed()).toBe(0.25);
    localStorage.setItem('motionlab.flipSpeed', '0.5'); // 前の既定で保存された値は引き継がない
    expect(loadFlipSpeed()).toBe(0.25);
    saveFlipSpeed(0.5);
    expect(loadFlipSpeed()).toBe(0.5);
    localStorage.setItem(SPEED_STORAGE_KEY, '3');
    expect(loadFlipSpeed()).toBe(0.25);
    localStorage.clear();
  });
});

describe('めくり: ページ送り', () => {
  it('端で止まる', () => {
    expect(clampPage(-1, 5)).toBe(0);
    expect(clampPage(9, 5)).toBe(4);
    expect(clampPage(2, 0)).toBe(0);
    expect(pageLabel(2, 58)).toBe('3 / 58');
  });

  it('払った量と速さでめくる。最初・最後のページから外へはめくらない', () => {
    expect(swipeStep(-120, 375, 300, 2, 5)).toBe(1);
    expect(swipeStep(120, 375, 300, 2, 5)).toBe(-1);
    expect(swipeStep(-30, 375, 400, 2, 5)).toBe(0);    // 短くゆっくり
    expect(swipeStep(-30, 375, 40, 2, 5)).toBe(1);     // 短くても速く払えばめくる
    expect(swipeStep(120, 375, 300, 0, 5)).toBe(0);
    expect(swipeStep(-120, 375, 300, 4, 5)).toBe(0);
    expect(swipeStep(-60, 0, 500, 1, 3)).toBe(1);      // 幅が測れない（0）とき
    expect(dragOffset(90, 0, 5)).toBe(30);             // 端では手応えだけ
    expect(dragOffset(90, 1, 5)).toBe(90);
  });

  it('矢印キー', () => {
    expect(keyStep('ArrowRight')).toBe(1);
    expect(keyStep('ArrowLeft')).toBe(-1);
    expect(keyStep('a')).toBe(0);
  });
});

describe('めくり: index.json の読み取り（v1 / v2 / flip）', () => {
  const rows = [row({ index: 0, start: 0.1 }), row({ index: 1, no: 2, start: 2.68 }), row({ index: 2, no: 3, start: 5.25 })];
  const abs = (u: string) => `https://h${u}`;

  it('flip[] があれば flip、無ければ frames[]、それも無ければ帯', () => {
    const json = {
      version: 2,
      moves: [
        { index: 0, start: 0.1, url: '/s0.jpg', frames: [{ t: 0.1, url: '/k0.jpg', count: 1, label: 'スタート' }],
          flip: [{ t: 0.1, url: '/f0.jpg', count: 1, label: 'スタート', key: true }, { t: 0.42, url: '/f1.jpg', count: 2, label: '' }] },
        { index: 1, start: 2.68, url: '/s1.jpg', frames: [{ t: 2.68, url: '/k1.jpg', count: 9 }, { url: 3 }] },
        { index: 2, start: 5.25, url: '/s2.jpg' },
      ],
    };
    const m = parseFlipIndex(json, rows, abs);
    const a = m.get(0)!;
    expect(a.kind).toBe('flip');
    expect(a.frames.map(f => f.url)).toEqual(['https://h/f0.jpg', 'https://h/f1.jpg']);
    expect(a.frames[0]).toMatchObject({ count: 1, label: 'スタート', key: true });
    expect(a.frames[1].label).toBeUndefined();
    const b = m.get(1)!;
    expect(b.kind).toBe('frames');
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0].count).toBeUndefined(); // 1〜8 の外は捨てる
    expect(m.get(2)).toEqual({ kind: 'strip', frames: [], strip: 'https://h/s2.jpg' });
  });

  it('半拍の flip[]: half の「&」は印にし、説明には残さない', () => {
    const json = { moves: [{ index: 0, start: 0.1, flip: [
      { t: 0.1, url: '/f0.jpg', count: 1, label: '' },
      { t: 0.26, url: '/f1.jpg', count: 1, label: '&', half: true },
      { t: 0.42, url: '/f2.jpg', count: 2, label: '男が下がる' },
    ] }] };
    const fr = parseFlipIndex(json, rows).get(0)!.frames;
    expect(fr[1]).toMatchObject({ count: 1, half: true });
    expect(fr[1].label).toBeUndefined();
    expect(frameCaption(fr[1])).toBe('1&');
    expect(fr[2].half).toBeUndefined();
    expect(frameCaption(fr[2])).toBe('2 男が下がる');
  });

  it('開始時刻が食い違う（routine が書き直された）行・知らない行は使わない', () => {
    const json = { moves: [{ index: 0, start: 3, url: '/x.jpg' }, { index: 7, start: 0, url: '/y.jpg' }, null] };
    expect(parseFlipIndex(json, rows).size).toBe(0);
    expect(parseFlipIndex(null, rows).size).toBe(0);
  });

  it('ReportModal が持っている写真（MoveFrameSet）からも作れる', () => {
    expect(sourceFromFrameSet({ strip: '/s.jpg', frames: [] })).toEqual({ kind: 'strip', frames: [], strip: '/s.jpg' });
    expect(sourceFromFrameSet({ strip: null, frames: [{ t: 1, url: '/a.jpg' }] })?.kind).toBe('frames');
    expect(sourceFromFrameSet(undefined)).toBeNull();
  });

  it('v1 の帯: 幅からコマ数が分かれば分ける、分からなければ null', () => {
    // サーバーの strip_of: 高さ 360、2:3 のコマ（幅 240）を 4px の隙間で 5 つ
    expect(stripTileCount(5 * 240 + 4 * 4, 360)).toBe(5);
    expect(stripTileCount(6 * 240 + 5 * 4, 360)).toBe(6);
    expect(stripTileCount(1000, 360)).toBeNull();
    expect(stripTileCount(0, 0)).toBeNull();
    const parts = splitStrip('/s.jpg', 5 * 240 + 16, 360)!;
    expect(parts).toHaveLength(5);
    expect(parts[3].strip).toEqual({ n: 5, i: 3, tileW: 240, gap: 4 });
  });

  it('先読みは今の技と次の技', () => {
    const json = { moves: [
      { index: 0, start: 0.1, flip: [{ t: 0.1, url: '/a.jpg' }, { t: 0.5, url: '/b.jpg' }] },
      { index: 1, start: 2.68, url: '/s1.jpg' },
      { index: 2, start: 5.25, frames: [{ t: 5.3, url: '/c.jpg' }] },
    ] };
    const m = parseFlipIndex(json, rows);
    expect(preloadUrls(m, rows, 0)).toEqual(['/a.jpg', '/b.jpg', '/s1.jpg']);
    expect(preloadUrls(m, rows, 2)).toEqual(['/c.jpg']);
  });
});

describe('めくり / 一覧 の選び方', () => {
  beforeEach(() => localStorage.clear());

  it('保存が無ければ 600px 以下はめくり', () => {
    expect(loadReportView(375)).toBe('flip');
    expect(loadReportView(600)).toBe('flip');
    expect(loadReportView(1024)).toBe('list');
  });

  it('選んだ方を覚える', () => {
    saveReportView('list');
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe('list');
    expect(loadReportView(375)).toBe('list');
  });

  it('localStorage が使えなくても落ちない', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const spy2 = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(loadReportView(375)).toBe('flip');
    expect(() => saveReportView('flip')).not.toThrow();
    spy.mockRestore();
    spy2.mockRestore();
  });
});

// ─── 画面 ───────────────────────────────────────────────────────────────────

const RESULT = {
  leader: { side: 'right' },
  routine: {
    timing: 'on2',
    grid: { beatSec: BEAT },
    moves: [
      { start: 0, counts: 8, move: 'basic', name: 'ベーシック',
        steps: [{ count: '1-2-3', leader: '前へ', follower: '後ろへ' }, { count: '5-6-7', leader: '後ろへ', follower: '前へ' }] },
      { start: 8 * BEAT, counts: 8, move: 'cbl', name: 'CBL', passSide: 'left', holdStart: 'LR', holdEnd: 'LR', evidence: 'inferred' },
      { start: 16 * BEAT, counts: 8, move: 'right_turn', name: '右ターン', turn: { by: 'follower', direction: 'right', rotations: 1 } },
    ],
  },
};

function sheetData(): ChoreoSheetData {
  return parseChoreoSheet(JSON.stringify(RESULT))!;
}

const INDEX = {
  version: 2,
  complete: true,
  moves: [0, 1, 2].map(i => ({
    index: i, start: Math.round(i * 8 * BEAT * 100) / 100, url: `/s${i}.jpg`,
    frames: [{ t: i * 8 * BEAT, url: `/k${i}.jpg`, count: 1, label: 'スタート' }],
    flip: Array.from({ length: 8 }, (_, k) => ({
      t: Math.round((i * 8 + k) * BEAT * 100) / 100, url: `/m${i}_${k}.jpg`, count: k + 1, label: k === 1 ? '通過' : '',
    })),
  })),
};

function currentPage() {
  const pages = screen.getByTestId('flip-pages');
  return pages.querySelector('[data-current="true"]') as HTMLElement;
}

describe('FlipView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1 技 1 ページ: 名前・カウントの行・男女・ページ番号・前後の技名', () => {
    render(<FlipView sheet={sheetData()} frames={new Map()} framesIndex={INDEX} />);
    const page = currentPage();
    expect(within(page).getByRole('heading', { name: '男右・女左 → ベーシック' })).toBeInTheDocument();
    expect(within(page).getByText('1-2-3')).toBeInTheDocument();
    expect(within(page).getAllByText('男')).toHaveLength(2);
    expect(screen.getByTestId('flip-page')).toHaveTextContent('1 / 3');
    expect(screen.getByRole('button', { name: /次の技: #2 CBL/ })).toBeInTheDocument();
    // パラパラ漫画: flip[] の 8 コマ、最初のコマの字は「1」
    expect(screen.getByTestId('flipbook').querySelectorAll('img')).toHaveLength(8);
    // 最初のコマの字は立ち位置（画面の左右）
    expect(screen.getByTestId('flip-caption')).toHaveTextContent('1男右・女左');
  });

  it('ターンの技は「男左・女右 → 女性ライトターン」（CBL で入れ替わった後）', async () => {
    render(<FlipView sheet={sheetData()} frames={new Map()} framesIndex={INDEX} initialIndex={2} />);
    expect(within(currentPage()).getByRole('heading', { name: '男左・女右 → 女性ライトターン' })).toBeInTheDocument();
  });

  it('半拍のコマ: 「1」「1&」「2」… と出る', () => {
    const idx = { moves: [{ index: 0, start: 0, flip: Array.from({ length: 16 }, (_, k) => ({
      t: Math.round((k * BEAT) / 2 * 1000) / 1000, url: `/h${k}.jpg`, count: Math.floor(k / 2) + 1,
      label: k % 2 ? '&' : '', ...(k % 2 ? { half: true } : {}),
    })) }] };
    render(<FlipView sheet={sheetData()} frames={new Map()} framesIndex={idx} />);
    expect(screen.getByTestId('flipbook').querySelectorAll('img')).toHaveLength(16);
    fireEvent.click(screen.getByTestId('flipbook'));
    fireEvent.change(screen.getByTestId('flip-scrubber'), { target: { value: '1' } });
    expect(screen.getByTestId('flip-caption')).toHaveTextContent(/^1&$/);
    fireEvent.click(screen.getByRole('button', { name: '次のコマ' }));
    expect(screen.getByTestId('flip-caption')).toHaveTextContent(/^2$/);
  });

  it('← → キーで前後の技へ。上のコマも替わる。端で止まる', async () => {
    const onIndex = vi.fn();
    render(<FlipView sheet={sheetData()} frames={new Map()} framesIndex={INDEX} onIndexChange={onIndex} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByTestId('flip-page')).toHaveTextContent('2 / 3');
    expect(within(currentPage()).getByRole('heading', { name: /CBL/ })).toBeInTheDocument();
    expect(within(currentPage()).getByLabelText('推定')).toBeInTheDocument();
    expect(onIndex).toHaveBeenLastCalledWith(1);
    const imgs = [...screen.getByTestId('flipbook').querySelectorAll('img')].map(i => i.getAttribute('src'));
    expect(imgs[0]).toBe('/m1_0.jpg');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByTestId('flip-page')).toHaveTextContent('1 / 3');
  });

  it('指で左へ払うと次、右へ払うと前。少しだけなら戻る', async () => {
    render(<FlipView sheet={sheetData()} frames={new Map()} framesIndex={INDEX} initialIndex={1} />);
    expect(screen.getByTestId('flip-page')).toHaveTextContent('2 / 3');
    const pages = screen.getByTestId('flip-pages');
    const swipe = async (dx: number, ms: number) => {
      fireEvent.pointerDown(pages, { pointerId: 1, button: 0, clientX: 200, clientY: 100, timeStamp: 1000 });
      fireEvent.pointerMove(pages, { pointerId: 1, clientX: 200 + dx / 2, clientY: 102, timeStamp: 1000 + ms / 2 });
      fireEvent.pointerMove(pages, { pointerId: 1, clientX: 200 + dx, clientY: 103, timeStamp: 1000 + ms });
      fireEvent.pointerUp(pages, { pointerId: 1, clientX: 200 + dx, clientY: 103, timeStamp: 1000 + ms });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    };
    await swipe(-150, 300);
    expect(screen.getByTestId('flip-page')).toHaveTextContent('3 / 3');
    await swipe(-150, 300); // 最後のページから先へはめくらない
    expect(screen.getByTestId('flip-page')).toHaveTextContent('3 / 3');
    await swipe(150, 300);
    expect(screen.getByTestId('flip-page')).toHaveTextContent('2 / 3');
    await swipe(20, 600); // 少しだけ・ゆっくり
    expect(screen.getByTestId('flip-page')).toHaveTextContent('2 / 3');
    // 縦に動かしたのは縦スクロール（めくらない）
    fireEvent.pointerDown(pages, { pointerId: 2, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(pages, { pointerId: 2, clientX: 195, clientY: 200 });
    fireEvent.pointerUp(pages, { pointerId: 2, clientX: 60, clientY: 220 });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByTestId('flip-page')).toHaveTextContent('2 / 3');
  });

  it('タップで止めるとスライダーで 1 コマずつ。速度は 0.25（既定）/ 0.5 / 1 倍', async () => {
    render(<FlipView sheet={sheetData()} frames={new Map()} framesIndex={INDEX} />);
    expect(screen.getByRole('button', { name: '0.25×' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('flip-scrubber')).toBeNull();
    fireEvent.click(screen.getByTestId('flipbook'));
    const scrub = screen.getByTestId('flip-scrubber') as HTMLInputElement;
    fireEvent.change(scrub, { target: { value: '1' } });
    expect(screen.getByTestId('flip-caption')).toHaveTextContent('2通過');
    fireEvent.click(screen.getByRole('button', { name: '次のコマ' }));
    expect(screen.getByTestId('flip-caption')).toHaveTextContent('3');
    fireEvent.click(screen.getByRole('button', { name: '1×' }));
    expect(screen.getByRole('button', { name: '1×' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '0.25×' })).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem(SPEED_STORAGE_KEY)).toBe('1');
  });

  it('古いジョブ（帯だけ）でも出る', () => {
    const json = { version: 1, moves: [{ index: 0, start: 0, url: '/old.jpg' }] };
    render(<FlipView sheet={sheetData()} frames={new Map()} framesIndex={json} />);
    // 帯の寸法が分かるまでは読み込み中（jsdom は画像を読まない）
    expect(screen.getByTestId('flipbook')).toHaveTextContent('読み込み中');
  });

  it('一覧へ戻る・閉じる', () => {
    const onList = vi.fn(), onClose = vi.fn();
    render(<FlipView sheet={sheetData()} frames={new Map()} onList={onList} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '一覧' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onList).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('flipbook')).toHaveTextContent('この技の写真はまだありません');
  });
});

describe('ReportModal の めくり / 一覧', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getJobDetail).mockResolvedValue({
      id: 'j', videoId: 'v', status: 'done', preset: 'salsa-pair', retryCount: 0,
      errorMessage: null, createdAt: '', finishedAt: null,
      reportMd: null, resultJson: JSON.stringify(RESULT), specSnapshot: '',
    } as Awaited<ReturnType<typeof getJobDetail>>);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => INDEX })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('一覧のカードを押すと、その技のめくりが開く（動画が無いとき）。選んだ表示を覚える', async () => {
    render(<ReportModal jobId="j" videoTitle="t" baseUrl="https://home.example" onClose={() => {}} />);
    const rows = await screen.findAllByTestId('choreo-row', {}, { timeout: 10000 });
    expect(screen.queryByTestId('flip-view')).toBeNull(); // 広い画面（jsdom 1024px）の既定は一覧
    fireEvent.click(rows[2]);
    await waitFor(() => expect(screen.getByTestId('flip-view')).toBeInTheDocument(), { timeout: 10000 });
    expect(screen.getByTestId('flip-page')).toHaveTextContent('3 / 3');
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe('flip');
    // flip[] の URL はホームサーバーへ解決される
    await waitFor(() => expect(screen.getByTestId('flipbook').querySelector('img')?.getAttribute('src'))
      .toBe('https://home.example/m2_0.jpg'), { timeout: 10000 });
    fireEvent.click(within(screen.getByTestId('flip-view')).getByRole('button', { name: '一覧' }));
    expect(screen.queryByTestId('flip-view')).toBeNull();
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe('list');
    fireEvent.click(screen.getByRole('button', { name: 'めくり' }));
    expect(screen.getByTestId('flip-page')).toHaveTextContent('3 / 3');
  }, 30000); // 全体で回すと重くて既定の 5 秒を超えることがある（単体では通る）
});
