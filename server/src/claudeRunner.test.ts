/**
 * claude 実行の組み立てテスト（claude -p は実行しない）。
 * 引数・作業ディレクトリ・プロンプトの中身・digest の生成を確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClaudeArgs, buildRunnerPrompt, collectOutputs, listWorkdirFiles, modelForStep, removeWorkdir, stageFlatDir, stageJobDir,
} from './claudeRunner.js';
import { buildDigest, parseKeyframeName, writeDigest } from './digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ml-claude-test-'));
}

test('buildClaudeArgs: main は safe-mode・strict-mcp・ツール限定つき', () => {
  const a = buildClaudeArgs('main', '30');
  assert.equal(a[0], '-p');
  assert.ok(a.includes('--safe-mode'));
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(a.includes('--disable-slash-commands'));
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Bash(python*) Read Write');
  assert.equal(a[a.indexOf('--tools') + 1], 'Bash,Read,Write');
  assert.equal(a[a.indexOf('--max-turns') + 1], '30');
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  // 認証を無効にする --bare は使わない（OAuth ログインが読めなくなる）
  assert.ok(!a.includes('--bare'));
  assert.ok(!a.includes('--dangerously-skip-permissions'));
});

test('buildClaudeArgs: anchor / turnJudge は Read だけ', () => {
  for (const kind of ['anchor', 'turnJudge'] as const) {
    const a = buildClaudeArgs(kind, '10');
    assert.equal(a[a.indexOf('--allowedTools') + 1], 'Read');
    assert.equal(a[a.indexOf('--tools') + 1], 'Read');
    assert.ok(a.includes('--safe-mode'));
  }
});

test('modelForStep: 段階ごとの環境変数。未設定・空・変な文字は null', () => {
  const env = { CLAUDE_MODEL_MAIN: 'sonnet', CLAUDE_MODEL_ANCHOR: ' ', CLAUDE_MODEL_TURNJUDGE: 'opus & echo x' };
  assert.equal(modelForStep('main', env), 'sonnet');
  assert.equal(modelForStep('anchor', env), null);
  assert.equal(modelForStep('turnJudge', env), null);
  assert.equal(modelForStep('main', {}), null);
  assert.equal(modelForStep('main', { CLAUDE_MODEL_MAIN: 'claude-opus-5-5[1m]' }), 'claude-opus-5-5[1m]');
});

test('buildClaudeArgs: モデル指定があれば --model、無ければ付けない', () => {
  const a = buildClaudeArgs('main', '30', 'sonnet');
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
  assert.ok(!buildClaudeArgs('anchor', '10', null).includes('--model'));
});

function makeJob(): string {
  const jobDir = path.join(tmp(), 'job-abc');
  mkdirSync(path.join(jobDir, 'out', 'keyframes'), { recursive: true });
  mkdirSync(path.join(jobDir, 'out', 'move_frames'), { recursive: true });
  mkdirSync(path.join(jobDir, 'out', 'anchor'), { recursive: true });
  mkdirSync(path.join(jobDir, 'knowledge'), { recursive: true });
  writeFileSync(path.join(jobDir, 'spec.md'), '# spec');
  writeFileSync(path.join(jobDir, 'knowledge', 'move-dictionary.md'), 'dict');
  writeFileSync(path.join(jobDir, 'out', 'measurements.json'), JSON.stringify({ summary: { events: [] } }));
  writeFileSync(path.join(jobDir, 'out', 'measurements.tracks.json'), '{}');
  writeFileSync(path.join(jobDir, 'out', 'skeleton.mp4'), 'x');
  writeFileSync(path.join(jobDir, 'out', 'move_frames', 'a.jpg'), 'x');
  writeFileSync(path.join(jobDir, 'out', 'anchor', 'a.jpg'), 'x');
  writeFileSync(path.join(jobDir, 'out', 'keyframes', '000003.5_turn_strip.jpg'), 'x');
  return jobDir;
}

test('stageJobDir: リポジトリ外・上位に CLAUDE.md が無い場所へ、必要なファイルだけ写す', () => {
  const jobDir = makeJob();
  const work = stageJobDir(jobDir);
  try {
    // リポジトリの中ではない（上の階層の CLAUDE.md を拾わない）
    const rel = path.relative(REPO_ROOT, work);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `作業場所がリポジトリ内: ${work}`);
    for (let d = work; ; d = path.dirname(d)) {
      assert.ok(!existsSync(path.join(d, 'CLAUDE.md')), `上の階層に CLAUDE.md: ${d}`);
      if (path.dirname(d) === d) break;
    }
    assert.ok(existsSync(path.join(work, 'spec.md')));
    assert.ok(existsSync(path.join(work, 'knowledge', 'move-dictionary.md')));
    assert.ok(existsSync(path.join(work, 'out', 'measurements.json')));
    assert.ok(existsSync(path.join(work, 'out', 'keyframes', '000003.5_turn_strip.jpg')));
    // 動画・コマ画像・原盤は写さない
    assert.ok(!existsSync(path.join(work, 'out', 'skeleton.mp4')));
    assert.ok(!existsSync(path.join(work, 'out', 'measurements.tracks.json')));
    assert.ok(!existsSync(path.join(work, 'out', 'move_frames')));
    assert.ok(!existsSync(path.join(work, 'out', 'anchor')));
  } finally {
    removeWorkdir(work);
    rmSync(path.dirname(jobDir), { recursive: true, force: true });
  }
});

test('collectOutputs: report.md と result.json だけ jobDir/out へ戻す', () => {
  const jobDir = makeJob();
  const work = stageJobDir(jobDir);
  try {
    writeFileSync(path.join(work, 'out', 'report.md'), '# r');
    writeFileSync(path.join(work, 'out', 'result.json'), '{"a":1}');
    writeFileSync(path.join(work, 'out', 'scratch.py'), 'print(1)');
    collectOutputs(work, jobDir);
    assert.equal(readFileSync(path.join(jobDir, 'out', 'report.md'), 'utf-8'), '# r');
    assert.equal(readFileSync(path.join(jobDir, 'out', 'result.json'), 'utf-8'), '{"a":1}');
    assert.ok(!existsSync(path.join(jobDir, 'out', 'scratch.py')));
  } finally {
    removeWorkdir(work);
    rmSync(path.dirname(jobDir), { recursive: true, force: true });
  }
});

test('stageFlatDir: 画像フォルダを別の場所へ写す', () => {
  const src = tmp();
  writeFileSync(path.join(src, '000002.0_anchor.jpg'), 'x');
  const dst = stageFlatDir(src, 'anchor');
  try {
    assert.notEqual(path.resolve(dst), path.resolve(src));
    assert.deepEqual(readdirSync(dst), ['000002.0_anchor.jpg']);
  } finally {
    removeWorkdir(dst);
    rmSync(src, { recursive: true, force: true });
  }
});

test('buildRunnerPrompt: digest のパス・PYTHON_BIN・ファイル一覧・下調べ不要が入る', () => {
  const jobDir = makeJob();
  const work = stageJobDir(jobDir);
  try {
    writeFileSync(path.join(work, 'out', 'digest.json'), '{}');
    const files = listWorkdirFiles(work);
    const py = 'C:\\Users\\admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
    const p = buildRunnerPrompt('BASE', 'SPEC BODY', { pythonBin: py, hasDigest: true, files });
    assert.ok(p.startsWith('BASE'));
    assert.ok(p.includes(py));
    assert.ok(p.includes('out/digest.json'));
    assert.ok(p.includes('measurements.json'));
    assert.ok(p.includes('下調べ不要'));
    assert.ok(p.includes('knowledge/move-dictionary.md'));
    assert.ok(p.includes('out/keyframes/'));
    assert.ok(p.endsWith('SPEC BODY'));
    const none = buildRunnerPrompt('BASE', 'S', { pythonBin: py, hasDigest: false, files });
    assert.ok(!none.includes('最初に `out/digest.json`'));
  } finally {
    removeWorkdir(work);
    rmSync(path.dirname(jobDir), { recursive: true, force: true });
  }
});

test('runner-prompt.md: 下調べ不要と digest の指示がある', () => {
  const p = readFileSync(path.resolve(__dirname, '../prompts/runner-prompt.md'), 'utf-8');
  assert.ok(p.includes('下調べ不要'));
  assert.ok(p.includes('out/digest.json'));
});

test('parseKeyframeName', () => {
  assert.deepEqual(parseKeyframeName('000003.5_turn_strip_2.jpg'), { file: '000003.5_turn_strip_2.jpg', t: 3.5, kind: 'turn', part: 2 });
  assert.equal(parseKeyframeName('000033.2_contested.jpg')?.kind, 'contested');
  assert.deepEqual(parseKeyframeName('000003.5_turn_detail.jpg'), { file: '000003.5_turn_detail.jpg', t: 3.5, kind: 'turn', part: 1, detail: true });
  assert.equal(parseKeyframeName('sheet_01.jpg'), null);
});

test('buildDigest: persons を落とし、イベントにストリップを紐づける', () => {
  const m = {
    fps: 30, persons: [{ t: 0 }],
    summary: {
      verdictByRule: { leaderExists: true },
      events: [
        { t: 3.52, type: 'Turn', by: 'follower', rotations: 1, spinCoarse: { x: 1 }, span: { from: 1 }, tMid: 3 },
        { t: 17.5, type: 'CBL', by: 'pair' },
      ],
      contested: [{ from: 33.23, to: 37.49, reason: 'x' }],
    },
  };
  const kf = ['000003.5_turn_strip.jpg', '000003.5_turn_strip_2.jpg', '000017.5_cbl_strip.jpg', '000035.4_contested.jpg']
    .map(f => parseKeyframeName(f)!);
  const d = buildDigest(m, kf, { pythonBin: 'py' }) as Record<string, any>;
  assert.equal(d.persons, undefined);
  assert.deepEqual(d.events[0].strips, ['000003.5_turn_strip.jpg', '000003.5_turn_strip_2.jpg']);
  assert.equal(d.events[0].spinCoarse, undefined);
  assert.equal(d.events[0].mmss, '0:03.5');
  assert.deepEqual(d.events[1].strips, ['000017.5_cbl_strip.jpg']);
  assert.deepEqual(d.contested[0].frames, ['000035.4_contested.jpg']);
  assert.equal(d.env.pythonBin, 'py');
});

// 実ジョブの out（読み取りのみ）。無い環境ではスキップ
const REAL_OUT = process.env.DIGEST_SAMPLE_OUT
  ?? 'C:\\Users\\admin\\Desktop\\projects\\motion-lab\\server\\storage\\analysis-jobs\\86afab96-8133-4089-8fa0-395b45e2e498\\out';

test('writeDigest: 実ジョブの out から数 KB〜数十 KB の digest を一時ディレクトリへ', { skip: !existsSync(path.join(REAL_OUT, 'measurements.json')) }, () => {
  const dst = tmp();
  try {
    const p = writeDigest(REAL_OUT, { pythonBin: 'PY' }, dst);
    assert.ok(p);
    const size = statSync(p!).size;
    console.log(`[digest] ${size} bytes (measurements.json ${statSync(path.join(REAL_OUT, 'measurements.json')).size} bytes)`);
    assert.ok(size > 2_000 && size < 60_000, `digest size ${size}`);
    const d = JSON.parse(readFileSync(p!, 'utf-8'));
    assert.ok(d.events.length > 0);
    assert.ok(d.verdictByRule);
    assert.ok(d.keyframes.length > 0);
    assert.equal(d.persons, undefined);
    // 元の out には書いていない
    assert.ok(!existsSync(path.join(REAL_OUT, 'digest.json')));
  } finally {
    rmSync(dst, { recursive: true, force: true });
  }
});
