/**
 * Claude ランナー — ジョブ作業ディレクトリで claude CLI をヘッドレス実行する。
 * docs/folder-analysis-detailed-design.md §6 参照
 *
 * - プロンプトは prompts/runner-prompt.md 固定部 + spec.md 本文の連結
 * - 設計書は `-p <promptText>` の引数渡しだが、Windows の argv 長制限（~32KB）と
 *   .cmd シム経由の引用符地獄を避けるため stdin 渡しに変更（`claude -p` は
 *   プロンプト引数が無ければ stdin を読む）。argv にはフラグのみを置く
 * - `--dangerously-skip-permissions` は使わない。`--allowedTools` で完結させる
 * - 成否判定は「exit 0 かつ out/report.md 生成」。文言によるレート制限/認証失効の
 *   識別は割れやすいので、判定に使った出力の末尾を必ずエラーメッセージに含める
 */
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordClaudeUsageFromStdout } from './claudeUsage.js';
import { writeDigest } from './digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 使用量の記録先（<jobDir>/out）とジョブ ID。anchor / turn_judge は <jobDir>/out/<sub> が cwd */
function usageTargetOfSub(subDir: string): { outDir: string; jobId: string } {
  const outDir = path.dirname(subDir);
  return { outDir, jobId: path.basename(path.dirname(outDir)) };
}

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const PROMPT_PATH = path.resolve(__dirname, '../prompts/runner-prompt.md');
const ANCHOR_PROMPT_PATH = path.resolve(__dirname, '../prompts/anchor-prompt.md');
const MAX_TURNS = process.env.CLAUDE_MAX_TURNS ?? '30';
const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3';
/**
 * 裁定役が必要なときだけ Read する技辞典・On2 の拍の資料（docs/salsa-knowledge）。
 * claude は cwd = jobDir・Read のみ許可で動くので、ジョブの作業ディレクトリの knowledge/ に写して渡す
 */
const KNOWLEDGE_DIR = path.resolve(__dirname, '../../docs/salsa-knowledge');
const KNOWLEDGE_FILES = ['move-dictionary.md', 'on2-timing-and-terms.md'];

/** 辞典を jobDir/knowledge/ に写す。無くても裁定はできる（プロンプトに要約がある）ので失敗は無視 */
function copyKnowledge(jobDir: string): void {
  try {
    const dst = path.join(jobDir, 'knowledge');
    mkdirSync(dst, { recursive: true });
    for (const f of KNOWLEDGE_FILES) {
      const src = path.join(KNOWLEDGE_DIR, f);
      if (existsSync(src)) copyFileSync(src, path.join(dst, f));
    }
  } catch (e) {
    console.warn(`[claudeRunner] knowledge copy failed: ${(e as Error).message}`);
  }
}

/**
 * claude CLI を「ジョブ専用の軽い文脈」で動かすための共通引数（`claude --help` 2.1.289 で確認済みのフラグのみ）。
 *   --safe-mode                 CLAUDE.md（~/.claude/CLAUDE.md を含む）・skills・plugins・hooks・MCP・カスタムコマンドを無効化。
 *                               認証・モデル・組み込みツール・--allowedTools の許可は通常どおり（ログインはそのまま使える）
 *   --strict-mcp-config         --mcp-config 以外の MCP を読まない（safe-mode と二重で MCP のツール定義を文脈に載せない）
 *   --disable-slash-commands    skills を無効化
 *   --exclude-dynamic-system-prompt-sections  cwd・環境情報・git status をシステムプロンプトから外す
 *   --tools <names>             使える組み込みツールをこの一覧だけにする（他のツールの定義を文脈に載せない）
 * CLAUDE_SLIM=0 で従来どおり（フラグ無し）に戻せる。
 */
export function claudeSlimArgs(tools: string[]): string[] {
  if (process.env.CLAUDE_SLIM === '0') return [];
  return [
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--exclude-dynamic-system-prompt-sections',
    '--tools', tools.join(','),
  ];
}

export type ClaudeKind = 'main' | 'anchor' | 'turnJudge';

const MODEL_ENV: Record<ClaudeKind, string> = {
  main: 'CLAUDE_MODEL_MAIN',
  anchor: 'CLAUDE_MODEL_ANCHOR',
  turnJudge: 'CLAUDE_MODEL_TURNJUDGE',
};

/**
 * 段階ごとのモデル（CLAUDE_MODEL_MAIN / CLAUDE_MODEL_ANCHOR / CLAUDE_MODEL_TURNJUDGE）。
 * 値は claude CLI の --model にそのまま渡す（例 sonnet / opus / claude-sonnet-5-5）。
 * 未設定・空なら null で --model を付けない（CLI の既定モデル = 従来どおり）。呼ぶたびに読むので再起動なしの単発実行でも効く
 */
export function modelForStep(kind: ClaudeKind, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[MODEL_ENV[kind]]?.trim();
  if (!v) return null;
  // Windows は shell 経由で起動するので、モデル名に使う文字以外は argv に置かない
  if (!/^[\w.\-[\]]+$/.test(v)) {
    console.warn(`[claudeRunner] ${MODEL_ENV[kind]} を無視しました（使えない文字を含む）: ${JSON.stringify(v)}`);
    return null;
  }
  return v;
}

/** claude に渡す引数（プロンプトは stdin。argv にはフラグだけ） */
export function buildClaudeArgs(kind: ClaudeKind, maxTurns: string, model: string | null = modelForStep(kind)): string[] {
  const read = kind !== 'main';
  return [
    '-p',
    '--allowedTools', read ? 'Read' : 'Bash(python*) Read Write',
    ...claudeSlimArgs(read ? ['Read'] : ['Bash', 'Read', 'Write']),
    ...(model ? ['--model', model] : []),
    '--max-turns', maxTurns,
    '--output-format', 'json',
  ];
}

/**
 * claude の作業ディレクトリ置き場。リポジトリの外（OS の一時ディレクトリ）にする。
 * ジョブの作業ディレクトリ（server/storage/analysis-jobs/<id>）はリポジトリ内なので、
 * そこを cwd にすると上の階層の CLAUDE.md（リポジトリ直下・server/CLAUDE.md）が毎回の文脈に載る
 */
const WORK_ROOT = process.env.CLAUDE_WORK_ROOT ?? path.join(os.tmpdir(), 'motion-lab-claude');

export function makeWorkdir(label: string, root: string = WORK_ROOT): string {
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, `${label.replace(/[^\w.-]/g, '_')}-`));
}

/** 作業場所を消す（失敗は無視。一時ディレクトリなので残っても害は無い） */
export function removeWorkdir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

/** 画像だけの作業フォルダ（anchor / turn_judge）を一時の作業場所へ写す */
export function stageFlatDir(srcDir: string, label: string, root?: string): string {
  const dst = makeWorkdir(label, root);
  for (const f of readdirSync(srcDir)) cpSync(path.join(srcDir, f), path.join(dst, f), { recursive: true });
  return dst;
}

/** 本解析で Claude に見せる out/ の中身。動画・コマ画像・原盤（tracks）は見せない */
const OUT_SKIP_DIRS = new Set(['report_frames', 'move_frames', 'anchor', 'turn_judge']);

export function stageJobDir(jobDir: string, root?: string): string {
  const dst = makeWorkdir(path.basename(jobDir), root);
  const specSrc = path.join(jobDir, 'spec.md');
  if (existsSync(specSrc)) copyFileSync(specSrc, path.join(dst, 'spec.md'));
  const knowledgeSrc = path.join(jobDir, 'knowledge');
  if (existsSync(knowledgeSrc)) cpSync(knowledgeSrc, path.join(dst, 'knowledge'), { recursive: true });
  const outSrc = path.join(jobDir, 'out');
  if (existsSync(outSrc)) {
    cpSync(outSrc, path.join(dst, 'out'), {
      recursive: true,
      filter: src => {
        if (src === outSrc) return true;
        const rel = path.relative(outSrc, src);
        const top = rel.split(path.sep)[0];
        if (OUT_SKIP_DIRS.has(top)) return false;
        const base = path.basename(src);
        return !(/\.mp4$/i.test(base) || /\.tracks\.json$/i.test(base) || /^audio\.wav$/i.test(base));
      },
    });
  } else {
    mkdirSync(path.join(dst, 'out'), { recursive: true });
  }
  return dst;
}

/** Claude が書いた成果物（report.md / result.json）を本来の out/ へ戻す */
export function collectOutputs(workDir: string, jobDir: string): void {
  const outDst = path.join(jobDir, 'out');
  mkdirSync(outDst, { recursive: true });
  for (const f of ['report.md', 'result.json']) {
    const src = path.join(workDir, 'out', f);
    if (existsSync(src)) copyFileSync(src, path.join(outDst, f));
  }
}

export interface RunnerPromptInfo {
  pythonBin: string;
  /** 作業場所の out/digest.json があるか */
  hasDigest: boolean;
  /** 作業場所のファイル一覧（相対パス）。プロンプトに載せて ls を不要にする */
  files: string[];
}

/** 作業場所の主なファイル（相対パス）。keyframes はファイル名が多いので digest 側に任せ、個数だけ書く */
export function listWorkdirFiles(workDir: string): string[] {
  const out: string[] = [];
  const add = (rel: string) => { if (existsSync(path.join(workDir, rel))) out.push(rel); };
  add('spec.md');
  for (const f of ['digest.json', 'measurements.json', 'report.md', 'result.json']) add(`out/${f}`);
  const kfDir = path.join(workDir, 'out', 'keyframes');
  if (existsSync(kfDir)) out.push(`out/keyframes/ （JPEG ${readdirSync(kfDir).filter(f => /\.jpe?g$/i.test(f)).length} 枚。一覧は digest.json の events[].strips / contested[].frames / keyframes）`);
  const knDir = path.join(workDir, 'knowledge');
  if (existsSync(knDir)) for (const f of readdirSync(knDir)) out.push(`knowledge/${f}`);
  return out;
}

/** 固定プロンプト + サーバーが埋めた実行環境 + spec.md 本文 */
export function buildRunnerPrompt(basePrompt: string, specMarkdown: string, info: RunnerPromptInfo): string {
  const env = [
    '## 実行環境（サーバーが用意した情報。**下調べ不要。`ls` や環境の探索（Python の場所探し・`.env` の確認など）をしない**）',
    '',
    `- Python の実パス: \`${info.pythonBin}\`（Bash で python を使うときはこのパスをそのまま使う。探さない）`,
    ...(info.hasDigest
      ? ['- **最初に `out/digest.json` を Read する。** 計測の要約（判定・信頼度・拍・技の候補・手のつなぎ・contested・キーフレーム一覧）をサーバーが先に作ってある。' +
         '`out/measurements.json` 全体（全フレームの骨格 `persons[]`）は読まなくてよい。要約に無い値が要るときだけ必要な範囲を読む',
         '- 計算（集計・整形）は要約に済んでいる。自作の要約スクリプトを書かない']
      : []),
    '- 作業ディレクトリのファイル（これで全部）:',
    ...info.files.map(f => `  - \`${f}\``),
    '- 成果物は `out/result.json` と `out/report.md`（Write で直接書く。result.json の組み立てに Python スクリプトが要るときだけ上の python を使う）',
  ].join('\n');
  return `${basePrompt}\n\n${env}\n\n---\n\n${specMarkdown}`;
}

/** レート制限・使用量上限。リトライ（バックオフ）対象 */
export class ClaudeRateLimitError extends Error {}
/** ログイン失効。人間の介入が必要なので即 error */
export class ClaudeAuthError extends Error {}

export interface ClaudeRunResult {
  reportMd: string;
  /** out/result.json の生文字列（生成されなかった場合 null） */
  resultJson: string | null;
}

function tailOf(stdout: string, stderr: string): string {
  return `stdout: ${stdout.slice(-1000)}\nstderr: ${stderr.slice(-1000)}`;
}

/**
 * リーダーアンカー: 解析前に Claude に静止画数枚を見せて
 * 「リーダーが画面左右どちらか」を1回だけ判定させる（CLAUDE.md その9 / ユーザー方針:
 * 写真を見れば間違えようがない意味判断は Claude、フレーム比例の計測はルールの分業）。
 *
 * 戻り値は analyze_pair.py の --leader-hint 形式（例: "right@5.00"）。
 * 判定不能・claude 不在・パース失敗は null（CV側の中央値多数決にフォールバック）
 */
export function runClaudeAnchor(anchorDir: string, signal: AbortSignal): Promise<string | null> {
  const promptText = readFileSync(ANCHOR_PROMPT_PATH, 'utf-8');
  return new Promise(resolve => {
    let workDir: string;
    try { workDir = stageFlatDir(anchorDir, 'anchor'); } catch { return resolve(null); }
    const model = modelForStep('anchor');
    const proc = spawn(CLAUDE_BIN, buildClaudeArgs('anchor', '10', model), {
      cwd: workDir,
      env: { ...process.env },
      signal,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stdin.on('error', () => { /* noop */ });
    proc.stdin.write(promptText);
    proc.stdin.end();
    proc.on('error', () => { removeWorkdir(workDir); resolve(null); });
    proc.on('exit', code => {
      removeWorkdir(workDir);
      const u = usageTargetOfSub(anchorDir);
      recordClaudeUsageFromStdout(u.outDir, u.jobId, 'anchor', stdout, model);
      if (code !== 0) return resolve(null);
      try {
        // --output-format json のエンベロープから結果テキストを取り出し、その中の JSON を拾う
        const envelope = JSON.parse(stdout) as { result?: string };
        const m = (envelope.result ?? '').match(/\{[^{}]*"leaderSide"[^{}]*\}/);
        if (!m) return resolve(null);
        const parsed = JSON.parse(m[0]) as { t: number | null; leaderSide: 'left' | 'right' | null; leaderLook?: string };
        if (parsed.leaderSide !== 'left' && parsed.leaderSide !== 'right') return resolve(null);
        if (typeof parsed.t !== 'number') return resolve(null);
        console.log(`[claudeAnchor] leader=${parsed.leaderSide} at t=${parsed.t} (${parsed.leaderLook ?? '?'})`);
        resolve(`${parsed.leaderSide}@${parsed.t.toFixed(2)}`);
      } catch {
        resolve(null);
      }
    });
  });
}

const TURN_JUDGE_PROMPT_PATH = path.resolve(__dirname, '../prompts/turn-judge-prompt.md');

/** turn_judge.py strips が書く events.json の 1 件 */
export interface TurnJudgeItem {
  id: string; file: string; t: number; kind: 'turn' | 'cbl'; cvTurner: 'leader' | 'follower';
  from: number; to: number; frames: number; cvRotations?: number | null;
}

export interface TurnJudgeRun {
  /** Claude の答え（{events: [...]}）。読めなければ null */
  judge: { events: unknown[] } | null;
  elapsedMs: number;
  raw: string;
}

/**
 * ターンの判定: 場面ごとの一覧画像（turn_judge.py strips）を 1 回の呼び出しでまとめて見せ、
 * 回った人・向き・回転数・自信を JSON で答えさせる（CLAUDE.md その9: 写真で分かる判断は Claude に聞く）。
 * 呼び出しは動画 1 本につき 1 回。画像は Read で 1 枚ずつ読むので max-turns は場面数 + 余裕。
 * レート制限は ClaudeRateLimitError、ログイン失効は ClaudeAuthError、それ以外の失敗は judge: null
 */
export function runClaudeTurnJudge(stripDir: string, items: TurnJudgeItem[], signal: AbortSignal): Promise<TurnJudgeRun> {
  const listing = items.map(it =>
    `- ${it.id}: \`${it.file}\` — ${it.kind === 'cbl' ? 'CBL（入れ替わり）で手が上がっていた' : 'ターン'}。` +
    `CV の見立て: ${it.cvTurner === 'leader' ? 'リーダー（青枠）' : 'フォロワー（ピンク枠）'}が回る。` +
    `${it.from.toFixed(2)}〜${it.to.toFixed(2)} 秒（${it.frames} コマ）`,
  ).join('\n');
  const promptText = `${readFileSync(TURN_JUDGE_PROMPT_PATH, 'utf-8')}\n\n## 場面の一覧（${items.length} 件）\n\n${listing}\n`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let workDir: string;
    try { workDir = stageFlatDir(stripDir, 'turnjudge'); } catch (e) { return reject(e as Error); }
    const model = modelForStep('turnJudge');
    const proc = spawn(CLAUDE_BIN, buildClaudeArgs('turnJudge', String(items.length + 10), model), {
      cwd: workDir,
      env: { ...process.env },
      signal,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdin.on('error', () => { /* noop */ });
    proc.stdin.write(promptText);
    proc.stdin.end();
    proc.on('error', err => { removeWorkdir(workDir); reject(new ClaudeAuthError(`claude CLI を起動できません: ${err.message}`)); });
    proc.on('exit', code => {
      removeWorkdir(workDir);
      const elapsedMs = Date.now() - started;
      const u = usageTargetOfSub(stripDir);
      recordClaudeUsageFromStdout(u.outDir, u.jobId, 'turnJudge', stdout, model);
      const combined = `${stdout}\n${stderr}`;
      let resultText = '';
      try {
        resultText = (JSON.parse(stdout) as { result?: string }).result ?? '';
      } catch { /* エンベロープが壊れている */ }
      if (/rate limit|usage limit|overloaded/i.test(code === 0 ? resultText : combined) && !/"events"\s*:/.test(resultText)) {
        reject(new ClaudeRateLimitError(`レート制限を検知しました。\n${tailOf(stdout, stderr)}`));
        return;
      }
      if (code !== 0 && /not logged in|please log ?in|authentication|invalid api key/i.test(combined)) {
        reject(new ClaudeAuthError(`Claude CLI の再ログインが必要です。\n${tailOf(stdout, stderr)}`));
        return;
      }
      resolve({ judge: code === 0 ? parseJudge(resultText) : null, elapsedMs, raw: resultText || tailOf(stdout, stderr) });
    });
  });
}

/** 答えの文字列から {"events": [...]} を拾う（前後に説明文・コードブロックが付いていても読む） */
export function parseJudge(text: string): { events: unknown[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { events?: unknown };
    return Array.isArray(parsed.events) ? { events: parsed.events } : null;
  } catch {
    return null;
  }
}

export interface RunClaudeOptions {
  /** prompts/ 内のファイル名。省略時は runner-prompt.md（salsa-pair） */
  promptFile?: string;
  /** サルサ用の技辞典を knowledge/ に写すか（省略時 true = 従来どおり） */
  copySalsaKnowledge?: boolean;
  /** out/digest.json を作って渡すか（省略時 true。measurements.json の形が salsa-pair 専用なので general は false） */
  digest?: boolean;
}

export function runClaude(jobDir: string, specMarkdown: string, signal: AbortSignal, opts: RunClaudeOptions = {}): Promise<ClaudeRunResult> {
  const promptPath = opts.promptFile ? path.resolve(__dirname, '../prompts', path.basename(opts.promptFile)) : PROMPT_PATH;
  if (opts.copySalsaKnowledge ?? true) copyKnowledge(jobDir);

  // リポジトリ外の作業場所へ必要なファイルだけ写して、そこを cwd にする（CLAUDE.md を拾わせない）。
  // 成果物（report.md / result.json）は終了後に jobDir/out へ戻す
  const workDir = stageJobDir(jobDir);
  if (opts.digest !== false) writeDigest(path.join(jobDir, 'out'), { pythonBin: PYTHON_BIN }, path.join(workDir, 'out'));
  const promptText = buildRunnerPrompt(readFileSync(promptPath, 'utf-8'), specMarkdown, {
    pythonBin: PYTHON_BIN,
    hasDigest: existsSync(path.join(workDir, 'out', 'digest.json')),
    files: listWorkdirFiles(workDir),
  });

  return new Promise((resolve, reject) => {
    const model = modelForStep('main');
    const proc = spawn(CLAUDE_BIN, buildClaudeArgs('main', MAX_TURNS, model), {
      cwd: workDir,
      env: { ...process.env },
      signal,
      // Windows で claude が .cmd シムの場合 shell 経由でないと起動できない。
      // argv にはユーザー由来の文字列を置かないためエスケープ問題は起きない
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdin.on('error', () => { /* 起動失敗時の EPIPE は exit/error 側で処理 */ });
    proc.stdin.write(promptText);
    proc.stdin.end();

    proc.on('error', err => {
      removeWorkdir(workDir);
      reject(new ClaudeAuthError(
        `claude CLI を起動できません（未インストールの可能性）: ${err.message}。` +
        `server/CLAUDE.md の手順で claude CLI を導入し、CLAUDE_BIN にパスを設定してください`,
      ));
    });

    proc.on('exit', code => {
      collectOutputs(workDir, jobDir);
      removeWorkdir(workDir);
      // リトライでも 1 回ずつ記録する（失敗終了でもエンベロープが読めれば残す）
      recordClaudeUsageFromStdout(path.join(jobDir, 'out'), path.basename(jobDir), 'main', stdout, model);
      const combined = `${stdout}\n${stderr}`;
      const tail = tailOf(stdout, stderr);

      if (/rate limit|usage limit|overloaded/i.test(combined)) {
        reject(new ClaudeRateLimitError(`レート制限を検知しました。\n${tail}`));
        return;
      }
      if (/not logged in|please log ?in|authentication|invalid api key/i.test(combined)) {
        reject(new ClaudeAuthError(
          `Claude CLI の再ログインが必要です。ThinkCentre で \`claude\` を対話起動してログインし直してください。\n${tail}`,
        ));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}。\n${tail}`));
        return;
      }
      const reportPath = path.join(jobDir, 'out', 'report.md');
      if (!existsSync(reportPath)) {
        reject(new Error(`claude は正常終了しましたが out/report.md が生成されていません。\n${tail}`));
        return;
      }
      const resultPath = path.join(jobDir, 'out', 'result.json');
      resolve({
        reportMd: readFileSync(reportPath, 'utf-8'),
        resultJson: existsSync(resultPath) ? readFileSync(resultPath, 'utf-8') : null,
      });
    });
  });
}
