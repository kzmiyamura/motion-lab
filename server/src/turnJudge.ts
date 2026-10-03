/**
 * ターンの判定（turn judge）: CV が読み違える回る向きを、0.1 秒刻みの上半身の一覧画像で Claude に読ませて上書きする。
 *   1. turn_judge.py strips — ターン（と手を上げた CBL）ごとに一覧画像 1 枚と events.json
 *   2. runClaudeTurnJudge — 動画 1 本につき claude を 1 回だけ呼ぶ
 *   3. turn_judge.py merge — 自信 medium 以上なら向き・回転数を Claude の値に（CV の値は dirCV 等に残す）、
 *      それ以外は CV のまま dirSource: "cv?"
 * jobWorker（analyze_pair の直後）と tools/judge-turns.ts（評価・既存ジョブへの適用）が使う
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeTurnJudge, type TurnJudgeItem } from './claudeRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../analysis/turn_judge.py');

export interface TurnJudgeOptions {
  pythonBin: string;
  videoPath: string;
  tracksPath: string;
  measurementsPath: string;
  /** 一覧画像・events.json・judge.json の置き場 */
  workDir: string;
  /** 書き戻し先（省略時は measurementsPath を上書き） */
  outPath?: string;
  signal: AbortSignal;
}

export interface TurnJudgeSummary {
  asked: number;
  bytes: number;
  elapsedMs: number;
  merged: string;
}

function runPy(pythonBin: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { signal });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => reject(new Error(`python起動失敗: ${err.message}`)));
    proc.on('exit', code => (code === 0 ? resolve(`${stdout}\n${stderr}`) : reject(new Error(stderr.slice(-1500) || `python exited ${code}`))));
  });
}

/** 判定して measurements に書き戻す。聞く場面が無ければ claude は呼ばない。レート制限・認証エラーはそのまま投げる */
export async function judgeTurns(o: TurnJudgeOptions): Promise<TurnJudgeSummary | null> {
  await runPy(o.pythonBin, [SCRIPT, 'strips', o.videoPath, o.tracksPath, o.measurementsPath, o.workDir], o.signal);
  const listingPath = path.join(o.workDir, 'events.json');
  const listing = JSON.parse(readFileSync(listingPath, 'utf-8')) as { events: TurnJudgeItem[]; totalBytes: number };
  if (listing.events.length === 0) return null;
  const run = await runClaudeTurnJudge(o.workDir, listing.events, o.signal);
  const judgePath = path.join(o.workDir, 'judge.json');
  writeFileSync(judgePath, JSON.stringify(run.judge ?? { events: [], raw: run.raw.slice(-2000) }, null, 1), 'utf-8');
  const out = await runPy(o.pythonBin, [
    SCRIPT, 'merge', o.measurementsPath, listingPath, judgePath, ...(o.outPath ? [`--out=${o.outPath}`] : []),
  ], o.signal);
  const merged = out.split('\n').find(l => l.startsWith('turn judge merge:')) ?? '';
  return { asked: listing.events.length, bytes: listing.totalBytes, elapsedMs: run.elapsedMs, merged };
}

export function hasTurnJudge(measurementsPath: string): boolean {
  try {
    return existsSync(measurementsPath)
      && Boolean((JSON.parse(readFileSync(measurementsPath, 'utf-8')) as { summary?: { turnJudge?: unknown } }).summary?.turnJudge);
  } catch {
    return false;
  }
}
