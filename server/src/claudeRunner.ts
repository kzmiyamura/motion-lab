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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const PROMPT_PATH = path.resolve(__dirname, '../prompts/runner-prompt.md');
const ANCHOR_PROMPT_PATH = path.resolve(__dirname, '../prompts/anchor-prompt.md');
const MAX_TURNS = process.env.CLAUDE_MAX_TURNS ?? '30';

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
    const proc = spawn(CLAUDE_BIN, [
      '-p',
      '--allowedTools', 'Read',
      '--max-turns', '10',
      '--output-format', 'json',
    ], {
      cwd: anchorDir,
      env: { ...process.env },
      signal,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stdin.on('error', () => { /* noop */ });
    proc.stdin.write(promptText);
    proc.stdin.end();
    proc.on('error', () => resolve(null));
    proc.on('exit', code => {
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

export function runClaude(jobDir: string, specMarkdown: string, signal: AbortSignal): Promise<ClaudeRunResult> {
  const promptText = `${readFileSync(PROMPT_PATH, 'utf-8')}\n\n---\n\n${specMarkdown}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p',
      '--allowedTools', 'Bash(python*) Read Write',
      '--max-turns', MAX_TURNS,
      '--output-format', 'json',
    ], {
      cwd: jobDir,
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
      reject(new ClaudeAuthError(
        `claude CLI を起動できません（未インストールの可能性）: ${err.message}。` +
        `server/CLAUDE.md の手順で claude CLI を導入し、CLAUDE_BIN にパスを設定してください`,
      ));
    });

    proc.on('exit', code => {
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
