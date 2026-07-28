import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  insertRotationAnalysis, markRotationAnalysisReady, markRotationAnalysisError,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3';
const SCRIPT_PATH = path.resolve(__dirname, '../analysis/analyze_rotation.py');
const MODEL_PATH = process.env.POSE_MODEL_PATH
  ?? path.resolve(__dirname, '../models/pose_landmarker_heavy.task');
const TMP_DIR = path.resolve(__dirname, '../data/tmp');

interface PythonOutput {
  fps: number;
  totalFrames: number;
  detectedFrames: number;
  samples: { t: number; angleDeg: number }[];
}

let running = false;

/** 解析ジョブが実行中かどうか（アップロード等の重い処理をブロックする判定に使う） */
export function isAnalysisRunning(): boolean {
  return running;
}

/**
 * 回転角度解析をバックグラウンドで開始する。
 * 呼び出し元は 202 を即座に返し、完了は GET /:id/analysis でポーリングする想定。
 */
export function startRotationAnalysis(videoId: string, videoPath: string): void {
  if (running) throw new Error('analysis already running');
  if (!existsSync(MODEL_PATH)) {
    throw new Error(`pose model not found: ${MODEL_PATH}。server/CLAUDE.md の手順でダウンロードしてください`);
  }

  running = true;
  insertRotationAnalysis(videoId);

  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const outPath = path.join(TMP_DIR, `${videoId}.json`);

  const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, videoPath, MODEL_PATH, outPath]);

  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('error', err => {
    running = false;
    markRotationAnalysisError(videoId, `Pythonプロセス起動失敗: ${err.message}`);
  });

  proc.on('exit', code => {
    running = false;
    if (code !== 0) {
      markRotationAnalysisError(videoId, stderr.slice(-2000) || `python exited with code ${code}`);
      return;
    }
    try {
      const raw = readFileSync(outPath, 'utf-8');
      const data = JSON.parse(raw) as PythonOutput;
      markRotationAnalysisReady(videoId, {
        fps: data.fps,
        totalFrames: data.totalFrames,
        detectedFrames: data.detectedFrames,
        samplesJson: JSON.stringify(data.samples),
      });
    } catch (e) {
      markRotationAnalysisError(videoId, e instanceof Error ? e.message : String(e));
    } finally {
      rmSync(outPath, { force: true });
    }
  });
}
