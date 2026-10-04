import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  buildCardStates, clockHour, parseSheetStates, partChips, positionOf, type CardState, type MoveIn,
} from '../engine/sheetState';
import { ContinuityMark, StateStrip } from '../components/StateStrip';

const mv = (o: Partial<MoveIn>): MoveIn => ({ move: 'basic', evidence: 'seen', confidence: 0.6, ...o } as MoveIn);
const hours = (s: CardState['start']) => [clockHour(s.leaderFacing), clockHour(s.followerFacing)];
const states = (moves: MoveIn[]) => buildCardStates(moves) as CardState[];

describe('clock / position helpers', () => {
  it('maps degrees to clock hours (0 → 12, clockwise)', () => {
    expect(clockHour(0)).toBe(12);
    expect(clockHour(90)).toBe(3);
    expect(clockHour(-90)).toBe(9);
    expect(clockHour(540)).toBe(6);
    expect(clockHour(null)).toBeNull();
  });
  it('maps bearing to the follower position', () => {
    expect(positionOf(0)).toBe('front');
    expect(positionOf(90)).toBe('right');
    expect(positionOf(-180)).toBe('behind');
    expect(positionOf(270)).toBe('left');
    expect(positionOf(null)).toBeNull();
  });
});

describe('state chaining', () => {
  it('starts face to face (男12 女6) and a CBL turns both around, ending at the opposite end', () => {
    const [a] = states([mv({ move: 'cbl', passSide: 'left', holdStart: 'RR', holdEnd: 'RR', sides: { followerStart: 'right', followerEnd: 'left' } })]);
    expect(hours(a.start)).toEqual([12, 6]);
    expect(a.start.position).toBe('front');
    expect(hours(a.end)).toEqual([6, 12]);
    expect(a.end.position).toBe('front');
    expect(a.slotEnd).toBe('opposite');
    expect(a.slotProv).toBe('seen');
    expect(a.end.hold).toBe('RR');
    expect(a.end.holdProv).toBe('seen');
  });

  it("the end of one move is the start of the next", () => {
    const [a, b, c] = states([
      mv({ move: 'cbl', passSide: 'left', holdStart: 'LR', holdEnd: 'LR' }),
      mv({ move: 'right_turn', turn: { by: 'follower', direction: 'right', rotations: 1 } }),
      mv({ move: 'cbl_inside_turn', passSide: 'left', holdStart: 'LR', holdEnd: 'LR', turn: { by: 'follower', direction: 'left', rotations: 1.5 } }),
    ]);
    expect(b.start).toEqual({ ...a.end, holdProv: 'inferred' });
    expect(hours(b.end)).toEqual([6, 12]);      // 1 回転なので向きは変わらない
    expect(b.end.hold).toBe('LR');              // 手は欄に無いので前から引き継いで推定
    expect(b.end.holdProv).toBe('inferred');
    expect(b.slotEnd).toBe('same');
    expect(hours(c.start)).toEqual([6, 12]);
    expect(hours(c.end)).toEqual([12, 6]);      // CBL＋1½（通過の½込み）で向かい合って反対の端
    expect(c.warnings).toEqual([]);
  });

  it('a leader turn of ½ leaves the follower behind him', () => {
    const [a] = states([mv({ move: 'leader_turn', turn: { by: 'leader', direction: 'right', rotations: 0.5 } })]);
    expect(hours(a.end)).toEqual([6, 6]);
    expect(a.end.position).toBe('behind');
  });

  it('a wrap puts her at his right, facing the same way', () => {
    const [a] = states([mv({ move: 'wrap', holdStart: 'double', holdEnd: 'double' })]);
    expect(a.end.position).toBe('right');
    expect(a.end.leaderFacing).toBe(a.end.followerFacing);
  });

  it('uses inferredHold when the hold was not seen, and marks it inferred', () => {
    const [, b] = states([
      mv({ move: 'cbl', passSide: 'left', holdStart: 'RR', holdEnd: 'RR' }),
      mv({ move: 'left_turn', holdStart: null, holdEnd: null, inferredHold: 'LR', holdSource: 'inferred', turn: { by: 'follower', direction: 'left', rotations: 1 } }),
    ]);
    expect(b.start.hold).toBe('LR');
    expect(b.start.holdProv).toBe('inferred');
    expect(b.end.hold).toBe('LR');
  });

  it('falls back gracefully on missing data', () => {
    const out = buildCardStates([null, 'x', {}]);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    const c = out[2]!;
    expect(c.start.hold).toBeNull();
    expect(c.start.holdProv).toBeNull();
    expect(hours(c.end)).toEqual([12, 6]);
    expect(c.warnings).toEqual([]);
    // 向きの分からない¼回転は向きを「?」にし、次の向かい合う技で黙って戻す
    const [q, n] = states([
      mv({ move: 'other', turn: { by: 'follower', direction: null, rotations: 0.75 } }),
      mv({ move: 'basic' }),
    ]);
    expect(q.end.followerFacing).toBeNull();
    expect(hours(n.start)).toEqual([12, 6]);
    expect(n.warnings).toEqual([]);
  });

  it('parseSheetStates reads result.json and tolerates bad input', () => {
    expect(parseSheetStates(null)).toBeNull();
    expect(parseSheetStates('{bad')).toBeNull();
    expect(parseSheetStates(JSON.stringify({ routine: { moves: [] } }))).toBeNull();
    expect(parseSheetStates(JSON.stringify({ routine: { moves: [{ move: 'basic' }] } }))).toHaveLength(1);
  });
});

describe('continuity check', () => {
  it('flags a hold change without a hand change', () => {
    const [, b] = states([
      mv({ move: 'cbl', passSide: 'left', holdStart: 'RR', holdEnd: 'RR' }),
      mv({ move: 'cbl', passSide: 'left', holdStart: 'LL', holdEnd: 'LL' }),
    ]);
    expect(b.warnings.map(w => w.kind)).toEqual(['hold']);
    expect(b.warnings[0].detail).toContain('男右手×女右手');
  });

  it('flags a hold change only when both holds were seen (not on inferred / very-low-confidence rows)', () => {
    const r = states([
      mv({ move: 'cbl', passSide: 'left', holdStart: 'RR', holdEnd: 'RR' }),
      mv({ move: 'cbl', passSide: 'left', holdStart: 'LL', holdEnd: 'LL', evidence: 'inferred' }),
      mv({ move: 'cbl', passSide: 'left', holdStart: 'RR', holdEnd: 'RR', confidence: 0.2 }),
      mv({ move: 'cbl', passSide: 'left', holdStart: 'LL', holdEnd: 'LL' }),
    ]);
    expect(r.flatMap(s => s.warnings.filter(w => w.kind === 'hold'))).toEqual([]);
  });

  it('does not flag a hold change around a hand change, a release or closed position', () => {
    const r = states([
      mv({ move: 'basic', holdStart: 'RR', holdEnd: 'RR' }),
      mv({ move: 'hand_change', holdStart: 'LL', holdEnd: 'LR' }),
      mv({ move: 'basic', holdStart: 'closed', holdEnd: 'none' }),
      mv({ move: 'basic', holdStart: 'RR', holdEnd: 'RR' }),
    ]);
    expect(r.flatMap(s => s.warnings)).toEqual([]);
  });

  it('flags a screen side that jumps between cards', () => {
    const [, b] = states([
      mv({ move: 'cbl', passSide: 'left', sides: { followerStart: 'left', followerEnd: 'right' } }),
      mv({ move: 'basic', sides: { followerStart: 'left', followerEnd: 'left' } }),
    ]);
    expect(b.warnings.map(w => w.kind)).toEqual(['side']);
  });

  it('flags facing that does not come back face to face (CBL＋turn with a whole number of rotations)', () => {
    const [a, b] = states([
      mv({ move: 'cbl_inside_turn', passSide: 'left', turn: { by: 'follower', direction: 'left', rotations: 1 } }),
      mv({ move: 'basic' }),
    ]);
    expect(hours(a.end)).toEqual([6, 6]);
    expect(b.warnings.map(w => w.kind)).toEqual(['facing']);
    expect(hours(b.start)).toEqual([6, 12]);     // 次の始まりは向かい合いに戻して続ける
  });

  it('does not flag facing after a shine', () => {
    const [, , c] = states([
      mv({ move: 'leader_turn', turn: { by: 'leader', direction: 'right', rotations: 0.5 } }),
      mv({ move: 'shine', holdStart: 'none', holdEnd: 'none' }),
      mv({ move: 'basic' }),
    ]);
    expect(c.warnings).toEqual([]);
  });
});

describe('seen vs inferred', () => {
  it('marks every part seen on a clean, seen row', () => {
    const chips = partChips(mv({
      move: 'cbl_inside_turn', passSide: 'left', sides: { followerStart: 'right', followerEnd: 'left' },
      turn: { by: 'follower', direction: 'left', rotations: 1.5 },
    }));
    expect(chips.map(c => [c.part, c.label, c.prov])).toEqual([
      ['pass', '男の左を通る', 'seen'], ['dir', '左回り', 'seen'], ['rot', '1½回転', 'seen'],
    ]);
  });

  it('marks parts inferred from the correction flags', () => {
    const chips = partChips(mv({
      move: 'cbl_inside_turn', passSide: 'left', passCheck: 'passButNoSwap:cbl_inside_turn',
      rotationCheck: 'rotations:2.0->1.5(prior)',
      turn: { by: 'follower', direction: 'left', rotations: 1.5, rotationSource: 'prior' },
    }));
    expect(Object.fromEntries(chips.map(c => [c.part, c.prov]))).toEqual({ pass: 'inferred', dir: 'seen', rot: 'inferred' });
  });

  it('a direction corrected by CV (Claude disagreed) is inferred, and so is its rotation count', () => {
    const chips = partChips(mv({
      move: 'left_turn', directionCheck: 'direction:right->left',
      turn: { by: 'follower', direction: 'left', rotations: 1, directionSource: 'cv' },
    }));
    expect(chips.map(c => c.prov)).toEqual(['inferred', 'inferred']);
    expect(partChips(mv({ move: 'left_turn', turn: { by: 'follower', direction: 'left', rotations: 1, dirSource: 'cv?' } }))[0].prov).toBe('inferred');
    expect(partChips(mv({ move: 'left_turn', turn: { by: 'follower', direction: 'left', rotations: 1, dirSource: 'claude' } }))[0].prov).toBe('seen');
  });

  it('an inferred row or a very low confidence makes everything inferred', () => {
    const t = { by: 'follower' as const, direction: 'right' as const, rotations: 1 };
    expect(partChips(mv({ move: 'right_turn', evidence: 'inferred', turn: t })).every(c => c.prov === 'inferred')).toBe(true);
    expect(partChips(mv({ move: 'right_turn', confidence: 0.2, turn: t })).every(c => c.prov === 'inferred')).toBe(true);
    expect(partChips(mv({ move: 'right_turn', confidence: 'doubtful', turn: t })).every(c => c.prov === 'inferred')).toBe(true);
    // 0.3〜0.4 は技名の「?」で出ているので、部品は見えたまま
    expect(partChips(mv({ move: 'right_turn', confidence: 0.3, turn: t })).every(c => c.prov === 'seen')).toBe(true);
  });

  it('a pass known only from the move type or the screen sides is inferred; a missing direction shows 向き?', () => {
    expect(partChips(mv({ move: 'cbl' }))[0]).toEqual({ part: 'pass', label: '反対側へ', prov: 'inferred' });
    expect(partChips(mv({ move: 'shine', sides: { followerStart: 'left', followerEnd: 'right' } }))[0].prov).toBe('inferred');
    expect(partChips(mv({ move: 'leader_turn', turn: { by: 'leader', rotations: 1 } }))[0]).toEqual({ part: 'dir', label: '男 向き?', prov: 'inferred' });
  });

  it('shows a leaderTurn next to the follower turn', () => {
    const chips = partChips(mv({
      move: 'left_turn', turn: { by: 'follower', direction: 'left', rotations: 1 },
      leaderTurn: { direction: 'right', rotations: 1 },
    }));
    expect(chips.map(c => c.label)).toEqual(['左回り', '1回転', '男 右回り1']);
    const [s] = states([mv({ move: 'left_turn', turn: { by: 'follower', direction: 'left', rotations: 1 }, leaderTurn: { direction: 'right', rotations: 0.5 } })]);
    expect(s.end.position).toBe('behind');
  });
});

describe('StateStrip', () => {
  it('renders start/end lines, chips and the ⚠ mark', () => {
    const [, b] = states([
      mv({ move: 'cbl', passSide: 'left', holdStart: 'RR', holdEnd: 'RR' }),
      mv({ move: 'left_turn', holdStart: 'LL', holdEnd: 'LL', turn: { by: 'follower', direction: 'left', rotations: 1, rotationSource: 'prior' } }),
    ]);
    render(<><ContinuityMark warnings={b.warnings} /><StateStrip state={b} /></>);
    expect(screen.getByTestId('state-start').textContent).toContain('男6');
    expect(screen.getByTestId('state-start').textContent).toContain('女12');
    expect(screen.getByTestId('state-end').textContent).toContain('同じ端');
    expect(screen.getAllByText('男左手×女左手')).toHaveLength(2);
    const rot = screen.getByText('1回転');
    expect(rot.closest('[data-prov]')!.getAttribute('data-prov')).toBe('inferred');
    expect(rot.closest('[data-prov]')!.textContent).toContain('推定');
    expect(screen.getByText('左回り').closest('[data-prov]')!.getAttribute('data-prov')).toBe('seen');
    expect(screen.getByTestId('continuity-warning').textContent).toContain('手が合わない');
  });

  it('renders nothing for a card without warnings', () => {
    const { container } = render(<ContinuityMark warnings={[]} />);
    expect(container.textContent).toBe('');
  });
});
