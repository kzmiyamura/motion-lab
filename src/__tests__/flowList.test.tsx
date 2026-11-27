import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { flowThumbUrl, pickDenseShots } from '../engine/flowList';
import { FlowList } from '../components/FlowList';
import { FlipView } from '../components/FlipView';
import type { ChoreoSheetData, MoveFrameSet, SheetRow } from '../engine/choreoSheet';

function row(i: number, over: Partial<SheetRow> = {}): SheetRow {
  return {
    index: i, no: i + 1, start: i * 3, end: i * 3 + 3, time: `0:0${i}`, counts: '1-8', name: `技${i + 1}`,
    steps: [], hold: i === 0 ? '右手同士（握手）' : null, turn: null, leaderTurn: null, pass: null,
    uncertain: false, diagram: null, startPos: null, ...over,
  };
}

const rows = [row(0), row(1), row(2)];
const frames = new Map<number, MoveFrameSet>(rows.map(r => [r.index, {
  strip: null,
  frames: [{ t: 0, url: `/a${r.index}.jpg` }, { t: 1, url: `/b${r.index}.jpg` }, { t: 2, url: `/c${r.index}.jpg` }],
}]));

describe('flowList（純粋な計算）', () => {
  it('代表コマは真ん中、コマが無ければ null', () => {
    expect(flowThumbUrl(frames.get(0))).toBe('/b0.jpg');
    expect(flowThumbUrl(undefined)).toBeNull();
    expect(flowThumbUrl({ strip: '/s.jpg', frames: [] })).toBeNull();
  });

  it('PC のコマ増: 多ければ max 枚を等間隔（先頭と最後を含む）、少なければそのまま', () => {
    const flip = Array.from({ length: 32 }, (_, i) => ({ t: i, url: `/f${i}.jpg` }));
    const picked = pickDenseShots(flip, 8);
    expect(picked).toHaveLength(8);
    expect(picked[0].url).toBe('/f0.jpg');
    expect(picked[7].url).toBe('/f31.jpg');
    expect(pickDenseShots(flip.slice(0, 5), 8)).toHaveLength(5);
  });
});

describe('FlowList（技の流れ）', () => {
  it('番号順に、技名・手・カウントを出し、押すとその技の index を返す', () => {
    const onPick = vi.fn();
    render(<FlowList rows={rows} frames={frames} currentIndex={1} onPick={onPick} layout="list" />);
    const items = screen.getAllByTestId('flow-item');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('1');
    expect(items[0]).toHaveTextContent('技1');
    expect(items[0]).toHaveTextContent('右手同士（握手）');
    expect(items[0]).toHaveTextContent('1-8');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('全 3 技')).toBeInTheDocument();
    fireEvent.click(items[2]);
    expect(onPick).toHaveBeenCalledWith(2);
  });
});

describe('FlipView の「流れ」', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const sheet: ChoreoSheetData = { header: [], rows, legend: '', beatSec: 0.32 };

  it('携帯: 「流れ」ボタンで開き、技を押すとそのページに飛ぶ。前後の技名と「今◯/全◯」が常にある', () => {
    render(<FlipView sheet={sheet} frames={frames} />);
    expect(screen.getByTestId('flip-page')).toHaveTextContent('1 / 3');
    expect(screen.getByRole('button', { name: /次の技: #2 技2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '流れ' }));
    const sheetEl = screen.getByTestId('flow-sheet');
    fireEvent.click(within(sheetEl).getAllByTestId('flow-item')[2]);
    expect(screen.queryByTestId('flow-sheet')).toBeNull();
    expect(screen.getByTestId('flip-page')).toHaveTextContent('3 / 3');
    expect(screen.getByRole('button', { name: /前の技: #2 技2/ })).toBeInTheDocument();
  });

  it('PC 幅: 流れが左の列に常に出る（ボタンは出ない）', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {},
    }));
    render(<FlipView sheet={sheet} frames={frames} />);
    expect(screen.queryByRole('button', { name: '流れ' })).toBeNull();
    const rail = screen.getByRole('complementary', { name: '技の流れ' });
    fireEvent.click(within(rail).getAllByTestId('flow-item')[1]);
    expect(screen.getByTestId('flip-page')).toHaveTextContent('2 / 3');
  });
});
