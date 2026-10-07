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
  buildClaudeArgs, buildRunnerPrompt, collectOutputs, countImageReads, listJudgeImages, listWorkdirFiles, mainEnv, modelForStep, needsReadAllImages, readSessionLog, removeWorkdir, stageFlatDir, stageJobDir,
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

test('mainEnv: 本解析の python が UTF-8 で書くよう PYTHONUTF8=1 を足す（元の環境は残す）', () => {
  const e = mainEnv({ PATH: 'x', PYTHONUTF8: '0' });
  assert.equal(e.PYTHONUTF8, '1');
  assert.equal(e.PATH, 'x');
});

test('needsReadAllImages: sonnet のときだけ', () => {
  assert.equal(needsReadAllImages('sonnet'), true);
  assert.equal(needsReadAllImages('claude-sonnet-5-5'), true);
  assert.equal(needsReadAllImages('opus'), false);
  assert.equal(needsReadAllImages(null), false);
});

test('buildRunnerPrompt: readAllImages で全部読む指示と枚数・seen の注意が入る', () => {
  const info = { pythonBin: 'py', hasDigest: true, files: [] as string[] };
  const p = buildRunnerPrompt('BASE', 'SPEC', { ...info, readAllImages: true, imageCount: 23 });
  assert.ok(p.includes('全部 Read する'));
  assert.ok(p.includes('23 枚'));
  assert.ok(p.includes('"seen"'));
  assert.ok(p.endsWith('SPEC'));
  assert.ok(!buildRunnerPrompt('BASE', 'SPEC', info).includes('全部 Read する'));
  assert.ok(!buildRunnerPrompt('BASE', 'SPEC', { ...info, readAllImages: true, imageCount: 0 }).includes('全部 Read する'));
});

test('listJudgeImages: strip と detail だけ数える', () => {
  const d = tmp();
  try {
    for (const f of ['000003.5_turn_strip.jpg', '000003.5_turn_strip_2.jpg', '000003.5_turn_detail.jpg', '000033.2_contested.jpg', 'x.txt']) {
      writeFileSync(path.join(d, f), 'x');
    }
    assert.equal(listJudgeImages(d).length, 3);
    assert.deepEqual(listJudgeImages(path.join(d, 'none')), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('countImageReads / readSessionLog: セッションログから Read した画像を重複なしで数える', () => {
  const read = (p: string) => ({ type: 'tool_use', name: 'Read', input: { file_path: p } });
  const lines = [
    { type: 'assistant', message: { content: [read('out/digest.json'), read('out/keyframes/a_strip.jpg'), read('out\\keyframes\\b_detail.jpg')] } },
    { type: 'assistant', message: { content: [read('C:/w/out/keyframes/a_strip.jpg'), { type: 'tool_use', name: 'Write', input: { file_path: 'c.jpg' } }] } },
    { type: 'user', message: { content: [read('d.jpg')] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\nnot json "tool_use"\n';
  assert.equal(countImageReads(lines), 2);
  const proj = tmp();
  try {
    const workDir = 'C:\\Users\\x\\Temp\\motion-lab-claude\\job-abc_1';
    mkdirSync(path.join(proj, 'C--Users-x-Temp-motion-lab-claude-job-abc-1'));
    writeFileSync(path.join(proj, 'C--Users-x-Temp-motion-lab-claude-job-abc-1', 'sid-1.jsonl'), lines);
    assert.equal(readSessionLog(JSON.stringify({ session_id: 'sid-1' }), workDir, proj), lines);
    assert.equal(readSessionLog(JSON.stringify({ session_id: '../x' }), workDir, proj), null);
    assert.equal(readSessionLog('not json', workDir, proj), null);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
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

test('buildDigest: tracks があればイベントに handHints（つないだ手の候補）が付く。無ければ付かない', () => {
  // 2 人が離れて立ち、0.5〜1.5 秒に画面左の人の右手首が画面右の人の手首の近くにある（kps の 9/10 = 左/右手首）
  const kps = (wl: [number, number], wr: [number, number], faceConf: number) => {
    const k: number[][] = Array.from({ length: 17 }, () => [0.5, 0.5, 0.9]);
    for (const i of [0, 1, 2]) k[i] = [0.5, 0.3, faceConf];
    for (const i of [3, 4]) k[i] = [0.5, 0.3, 0.1];   // 耳も頭の高さに（頭の中心を y=0.3 に置く）
    k[5] = [0.4, 0.4, 0.9]; k[6] = [0.6, 0.4, 0.9]; k[11] = [0.45, 0.7, 0.9]; k[12] = [0.55, 0.7, 0.9];
    k[9] = [wl[0], wl[1], 0.9]; k[10] = [wr[0], wr[1], 0.9];
    return k;
  };
  const frames = Array.from({ length: 30 }, (_, i) => {
    const t = i * 0.1;
    const joined = t >= 0.5 && t <= 1.5;
    const a = { pid: 0, bbox: [0.05, 0.1, 0.35, 0.95], kps: kps([0.1, 0.8], [joined ? 0.5 : 0.2, 0.55], 0.9) };
    const b = { pid: 1, bbox: [0.6, 0.1, 0.9, 0.95], kps: kps([joined ? 0.52 : 0.8, 0.55], [0.85, 0.8], 0.1) };
    return { t, kept: [a, b] };
  });
  const m = { fps: 30, width: 888, height: 1920, summary: { events: [{ t: 0.4, type: 'CBL', by: 'pair' }, { t: 3.0, type: 'Turn', by: 'follower' }] } };
  const d = buildDigest(m, [], { pythonBin: 'py' }, { frames } as never) as Record<string, any>;
  const hh = d.events[0].handHints;
  assert.ok(hh, 'handHints が付く');
  assert.ok(Array.isArray(hh.jointHands) && hh.jointHands.length > 0, 'つないだ手の候補が出る');
  assert.ok(hh.jointHands.every((s: string) => /秒/.test(s)));
  const d0 = buildDigest(m, [], { pythonBin: 'py' }) as Record<string, any>;
  assert.equal(d0.events[0].handHints, undefined);
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
