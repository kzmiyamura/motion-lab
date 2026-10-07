/**
 * リーダーアンカーだけを単体で試す（claude 呼び出し 1〜2 回。解析本体は走らせない）。
 *
 * usage: tsx tools/anchor-probe.ts <video.mp4> <workDir>
 *   workDir/job/out/anchor に静止画を作り、runClaudeAnchorReport の結果（ヒント・試行回数・失敗理由）を JSON で出す。
 *   usage ログは workDir/job/out に書かれるので、本番のジョブには混ざらない。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeAnchorReport } from '../src/claudeRunner.js';

const [video, workDir] = process.argv.slice(2);
if (!video || !workDir) {
  console.error('usage: tsx tools/anchor-probe.ts <video.mp4> <workDir>');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const anchorDir = path.join(path.resolve(workDir), 'job', 'out', 'anchor');
mkdirSync(anchorDir, { recursive: true });
const py = process.env.PYTHON_BIN ?? 'python';
const r = spawnSync(py, [path.resolve(here, '../analysis/extract_keyframes.py'), video, anchorDir, 'anchor', '2.0', '5.0', '9.0'], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const report = await runClaudeAnchorReport(anchorDir, new AbortController().signal);
console.log(JSON.stringify(report));
