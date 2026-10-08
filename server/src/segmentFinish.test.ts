import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findWeakWindows, segmentFinishNote } from './segmentFinish.js';

test('仕上げ段の注記: 更新した区間を mm:ss で並べ、食い違うことを断る。読めなければ空', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'finish-note-'));
  const p = path.join(dir, 'finish-summary.json');
  writeFileSync(p, JSON.stringify({ windows: [{ from: 0.58, to: 4.56 }, { from: 62.29, to: 67.86 }] }));
  const note = segmentFinishNote(p);
  assert.ok(note.includes('0:00〜0:04') && note.includes('1:02〜1:07') && note.includes('食い違う'));
  assert.equal(segmentFinishNote(path.join(dir, 'nothing.json')), '');
  writeFileSync(p, JSON.stringify({ windows: [] }));
  assert.equal(segmentFinishNote(p), '');
});

const card = (start: number, extra: Record<string, unknown> = {}) => ({ start, counts: 8, holdStart: 'RR', holdEnd: 'RR', confidence: 0.6, ...extra });
const result = (moves: unknown[]) => ({ routine: { bpm: 100, moves } });

test('自信が低く手が空のカードは、次の次のカードの start までを窓にする', () => {
  const w = findWeakWindows({ result: result([card(0.58, { confidence: 0.3, holdStart: null, holdEnd: null }), card(1.86), card(4.56), card(7.2)]) });
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].from, w[0].to], [0.58, 4.56]);
  assert.deepEqual(w[0].cards, [0]);
  assert.ok(w[0].reasons.some(r => r.includes('自信が低い')) && w[0].reasons.some(r => r.includes('手が空')));
});

test('弱いカードが無ければ窓は無い', () => {
  assert.deepEqual(findWeakWindows({ result: result([card(0), card(2), card(4)]) }), []);
});

test('firstT より前には窓を作らない / 長さは maxWindow まで', () => {
  const w = findWeakWindows({ result: result([card(0.1, { confidence: 0.2 }), card(3), card(20)]), firstT: 0.15, maxWindow: 5 });
  assert.equal(w[0].from, 0.15);
  assert.equal(w[0].to, 5.15);
});

test('重なる窓は連結せず、弱さの点が高い方だけ残す', () => {
  const w = findWeakWindows({ result: result([card(0, { confidence: 0.2, holdStart: null, holdEnd: null }), card(2, { confidence: 0.4 }), card(4), card(6), card(8)]) });
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].cards, [0]);
  assert.deepEqual([w[0].from, w[0].to], [0, 4]);
});

test('点が高い順に maxWindows 個選び、時刻順に返す', () => {
  const m = [card(0, { confidence: 0.45 }), card(20, { confidence: 0.1, holdStart: null, holdEnd: null }), card(40, { confidence: 0.3 }), card(60), card(80)];
  const w = findWeakWindows({ result: result(m), maxWindows: 2, maxWindow: 4 });
  assert.deepEqual(w.map(x => x.cards[0]), [1, 2]);
});

test('holdUnclear・estimated と重なるカードも拾う', () => {
  const m = [card(0), card(5), card(10), card(15)];
  assert.equal(findWeakWindows({ result: result(m), holdUnclear: [{ from: 5.5, to: 6 }] }).length, 1);
  assert.equal(findWeakWindows({ result: result(m), holds: [{ from: 10.2, to: 11, estimated: [10, 11] }] }).length, 1);
  assert.equal(findWeakWindows({ result: result(m), holds: [{ from: 10.2, to: 11 }] }).length, 0);
});

test('maxWindows で打ち切る', () => {
  const m = Array.from({ length: 20 }, (_, i) => card(i * 10, { confidence: 0.1 }));
  assert.equal(findWeakWindows({ result: result(m), maxWindows: 3, maxWindow: 4 }).length, 3);
});
