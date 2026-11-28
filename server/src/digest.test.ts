import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHandHints, expandHandHints } from './digest.js';

const SRC = [
  '3.91〜4.26 秒(区間のあと) 画面左の人の右手×画面右の人の右手の手首が近い',
  '4.34〜4.69 秒(区間のあと) 画面左の人の右手×画面右の人の左手の手首が近い（2人が重なっていて当てにならない）',
  '1.5〜1.67 秒 画面右の人の右手→画面左の人の頭が近い（胴長0.6以内）',
  '1.67〜1.67 秒 画面左の人の左手→画面右の人の頭が近い（胴長0.6以内）',
  '2.5〜2.6 秒 画面右の人の右手→画面左の人の頭が近い（胴長0.6以内）',
  '0.31〜0.8 秒 見えている1人の右手が頭より上',
  '1.41〜1.41 秒 見えている1人の右手が頭より上',
];

test('compactHandHints: 同じ中身は 1 行にまとめ、言い回しを短くする', () => {
  const c = compactHandHints(SRC);
  assert.deepEqual(c, [
    '1人の右手が頭より上: 0.31〜0.8, 1.41',
    '右人の右手→左人の頭が近い: 1.5〜1.67, 2.5〜2.6',
    '左人の左手→右人の頭が近い: 1.67',
    '(後) 左人の右手×右人の右手の手首が近い: 3.91〜4.26',
    '(後) 左人の右手×右人の左手の手首が近い※重: 4.34〜4.69',
  ]);
});

test('compactHandHints: 間が 0.3 秒以内の区間はつなぎ、それより空いたものは分ける', () => {
  const c = compactHandHints(['1〜1.2 秒 画面左の人の右手が頭より上', '1.4〜1.5 秒 画面左の人の右手が頭より上', '2.0〜2.1 秒 画面左の人の右手が頭より上']);
  assert.deepEqual(c, ['左人の右手が頭より上: 1〜1.5, 2〜2.1']);
});

test('expandHandHints: 圧縮の逆（時刻・手の組・(後)・重なりが元どおり戻る）', () => {
  const back = compactHandHints(SRC).flatMap(expandHandHints).sort();
  const want = [
    '0.31〜0.8 秒 見えている1人の右手が頭より上', '1.41〜1.41 秒 見えている1人の右手が頭より上',
    ...SRC.filter(s => !s.includes('見えている1人')),
  ].sort();
  assert.deepEqual(back, want);
});

test('compactHandHints: 区間の形でない文は短くするだけで残す', () => {
  assert.deepEqual(compactHandHints(['何か 画面左の人の説明']), ['何か 左人の説明']);
});
