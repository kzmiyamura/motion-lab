// 実行: cd server && npm test （node:test を tsx 経由で動かす）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  encodeProjectDirName, extractClaudeUsage, formatUsageLine, readClaudeUsageTotal, recordClaudeUsage, sumClaudeUsage,
} from './claudeUsage.js';
// @ts-expect-error .mjs ツール（型宣言なし）
import { encodeProjectDirName as encodeMjs, sumJsonlUsage } from '../tools/backfill-claude-usage.mjs';

const envelope = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 3, result: 'x',
  total_cost_usd: 0.5,
  usage: { input_tokens: 10, output_tokens: 600, cache_creation_input_tokens: 49000, cache_read_input_tokens: 250000 },
  modelUsage: { 'claude-sonnet-5-5': { outputTokens: 600 } },
});

test('extractClaudeUsage: エンベロープから取り出す', () => {
  const s = extractClaudeUsage(envelope, 'anchor', new Date('2026-10-06T00:00:00Z'));
  assert.ok(s);
  assert.equal(s.step, 'anchor');
  assert.equal(s.output_tokens, 600);
  assert.equal(s.cache_creation_input_tokens, 49000);
  assert.equal(s.cache_read_input_tokens, 250000);
  assert.equal(s.total_cost_usd, 0.5);
  assert.equal(s.num_turns, 3);
  assert.equal(s.duration_ms, 1234);
  assert.deepEqual(s.models, ['claude-sonnet-5-5']);
  assert.equal(s.at, '2026-10-06T00:00:00.000Z');
});

test('extractClaudeUsage: 読めなければ null（例外を投げない）', () => {
  assert.equal(extractClaudeUsage('', 'main'), null);
  assert.equal(extractClaudeUsage('not json', 'main'), null);
  assert.equal(extractClaudeUsage('{"result":"x"}', 'main'), null);
  assert.equal(extractClaudeUsage('[]', 'main'), null);
});

test('extractClaudeUsage: 前後にごみがあっても拾う / 一部欠けは null 値', () => {
  const s = extractClaudeUsage(`warn\n${JSON.stringify({ usage: { output_tokens: 5 } })}\n`, 'main');
  assert.equal(s?.output_tokens, 5);
  assert.equal(s?.input_tokens, null);
  assert.equal(s?.total_cost_usd, null);
});

test('sumClaudeUsage / formatUsageLine', () => {
  const a = extractClaudeUsage(envelope, 'anchor')!;
  const b = extractClaudeUsage(envelope, 'main')!;
  const t = sumClaudeUsage([a, b]);
  assert.equal(t.output_tokens, 1200);
  assert.equal(t.total_cost_usd, 1);
  assert.equal(t.calls, 2);
  assert.equal(
    formatUsageLine('86afab96-aaaa', a),
    '[claudeUsage] job=86afab96 step=anchor model=claude-sonnet-5-5 out=600 cacheW=49000 cacheR=250000 turns=3',
  );
});

test('extractClaudeUsage: 指定したモデル（--model）を requestedModel に残す', () => {
  const s = extractClaudeUsage(envelope, 'main', new Date(), 'sonnet')!;
  assert.equal(s.requestedModel, 'sonnet');
  assert.deepEqual(s.models, ['claude-sonnet-5-5']);
  assert.equal(extractClaudeUsage(envelope, 'main')!.requestedModel, null);
  // エンベロープに modelUsage が無いときはログに指定値を出す
  const bare = extractClaudeUsage(JSON.stringify({ usage: { output_tokens: 5 } }), 'main', new Date(), 'opus')!;
  assert.match(formatUsageLine('86afab96', bare), /model=opus /);
});

test('recordClaudeUsage: リトライ分も 1 回ずつ追記し total を再計算', () => {
  const jobDir = mkdtempSync(path.join(os.tmpdir(), 'cu-'));
  const outDir = path.join(jobDir, 'out');
  recordClaudeUsage(outDir, 'abcdef123456', extractClaudeUsage(envelope, 'main')!);
  recordClaudeUsage(outDir, 'abcdef123456', extractClaudeUsage(envelope, 'main')!);
  const f = JSON.parse(readFileSync(path.join(outDir, 'claude-usage.json'), 'utf-8'));
  assert.equal(f.steps.length, 2);
  assert.equal(f.total.output_tokens, 1200);
  assert.equal(readClaudeUsageTotal(jobDir)?.calls, 2);
  assert.equal(readClaudeUsageTotal(path.join(jobDir, 'none')), null);
});

test('encodeProjectDirName: : \\ / を - に', () => {
  const p = 'C:\\Users\\admin\\Desktop\\projects\\motion-lab\\server\\storage\\analysis-jobs\\abc\\out\\anchor';
  const want = 'C--Users-admin-Desktop-projects-motion-lab-server-storage-analysis-jobs-abc-out-anchor';
  assert.equal(encodeProjectDirName(p), want);
  assert.equal(encodeMjs(p), want);
  assert.equal(encodeProjectDirName('/home/u/x'), '-home-u-x');
});

test('sumJsonlUsage: message.id ごとに 1 回だけ数える', () => {
  const line = (id: string, out: number, ts: string) => JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
  });
  const text = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-06T00:00:00Z' }),
    line('m1', 10, '2026-10-06T00:00:01Z'),
    line('m1', 10, '2026-10-06T00:00:02Z'), // 同じ message の 2 行目
    line('m2', 20, '2026-10-06T00:00:05Z'),
    'broken line',
  ].join('\n');
  const s = sumJsonlUsage(text);
  assert.equal(s.output_tokens, 30);
  assert.equal(s.cache_creation_input_tokens, 200);
  assert.equal(s.cache_read_input_tokens, 2000);
  assert.equal(s.num_turns, 2);
  assert.equal(s.duration_ms, 5000);
  assert.deepEqual(s.models, ['claude-sonnet-5-5']);
});
