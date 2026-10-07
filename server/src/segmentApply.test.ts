import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRowsToResult, holdFromHands, rowToMove } from './segmentApply.js';
import { findCandidates, holdCode } from './segmentCandidates.js';
import { parseHands, type TrackFrame, type TrackPerson } from './segmentDigest.js';

test('parseHands / holdFromHands: 手の文字列を RoutineHold にする', () => {
  assert.deepEqual(parseHands('男性右手×女性右手'), { man: 'R', woman: 'R' });
  assert.deepEqual(parseHands('男性左手で'), { man: 'L', woman: null });
  assert.equal(holdFromHands('右手同士'), 'RR');
  assert.equal(holdFromHands('男性左手×女性右手'), 'LR');
  assert.equal(holdFromHands('両手'), 'double');
  assert.equal(holdFromHands('手を離して'), 'none');
  assert.equal(holdFromHands('男性左手で'), null);
});

test('rowToMove: フロントが読む欄（move・name・start・counts・hold・turn）を満たし、今のカードの start/counts を引き継ぐ', () => {
  const m = rowToMove(
    { start: 0.2, name: '女性ライトターン', hands: '男性右手×女性右手', move: 'right_turn', turn: { by: 'follower', direction: 'right', rotations: 1 }, description: '説明' },
    { start: 0, counts: 8 },
  );
  assert.equal(m.move, 'right_turn');
  assert.equal(m.start, 0);
  assert.equal(m.counts, 8);
  assert.equal(m.holdStart, 'RR');
  assert.equal(m.holdEnd, 'RR');
  assert.equal(m.leadHand, 'R');
  assert.deepEqual(m.turn, { by: 'follower', direction: 'right', rotations: 1 });
  assert.equal(m.evidence, 'seen');
  assert.equal('steps' in m, false);
  // 未知の move id は other、壊れた turn は null
  const o = rowToMove({ start: 5, name: 'x', move: 'ふしぎ', turn: { by: 'robot' } });
  assert.equal(o.move, 'other');
  assert.equal(o.turn, null);
  assert.equal(o.counts, 8);
});

test('applyRowsToResult: 区間内のカードを 1 対 1 で置き換え、他は残す。元は変えない', () => {
  const result = { leader: 'x', routine: { moves: [{ start: 0, counts: 8, name: 'A', move: 'basic' }, { start: 5, counts: 16, name: 'B', move: 'cbl' }, { start: 9, counts: 8, name: 'C' }] } };
  const before = JSON.stringify(result);
  const out = applyRowsToResult(result, 4, 8, [{ start: 5.4, name: 'N', hands: '右手同士', move: 'right_turn' }]) as typeof result;
  assert.deepEqual(out.routine.moves.map(m => m.name), ['A', 'N', 'C']);
  assert.equal(out.routine.moves[1].start, 5);
  assert.equal(out.routine.moves[1].counts, 16);
  assert.equal(JSON.stringify(result), before);
});

function person(pid: number, cx: number, h = 0.6): TrackPerson {
  return { pid, bbox: [cx - 0.1, 0.2, cx + 0.1, 0.2 + h] };
}

test('holdCode: リーダー左手×フォロワー右手 → LR', () => {
  assert.equal(holdCode('リーダー左手×フォロワー右手'), 'LR');
  assert.equal(holdCode('なし'), null);
});

test('findCandidates: hold の信頼度が低い区間・カードの食い違いを窓にし、きれいな区間は拾わない', () => {
  const frames: TrackFrame[] = [];
  for (let i = 0; i < 100; i++) {
    const t = i * 0.1;
    // 2〜4 秒は片方が隠れる（奥の別人は背が低い）。それ以外は2人が分かれる
    frames.push({ t, kept: t >= 2 && t < 4 ? [person(0, 0.3), person(1, 0.8, 0.2)] : [person(0, 0.3), person(1, 0.7)] });
  }
  const tracks = { frames, holdTimeline: [{ from: 2.5, to: 3.5, hold: 'リーダー左手×フォロワー右手' }, { from: 7, to: 8, hold: 'リーダー右手×フォロワー右手' }] };
  const c = findCandidates({ tracks, duration: 10 });
  assert.equal(c.length >= 1, true);
  assert.ok(c.some(x => x.from <= 2.5 && x.to >= 3.5));
  assert.ok(!c.some(x => x.from <= 7.5 && x.to >= 7.5)); // 7〜8 秒の hold は明瞭
  // カードの手と CV の hold が食い違う
  const result = { routine: { bpm: 120, moves: [{ start: 6.5, counts: 8, name: 'CBL', holdStart: 'LL', holdEnd: 'LL' }] } };
  const c2 = findCandidates({ tracks, result, duration: 10 });
  assert.ok(c2.some(x => x.from <= 7 && x.to >= 8 && x.reasons.some(r => r.includes('食い違う'))));
});
