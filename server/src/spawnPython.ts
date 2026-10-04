/**
 * 解析用の python を起動する共通口。mediapipe / torch / numpy が全コアを使い切って
 * PC 全体が重くなるのを防ぐ。
 *   - スレッド数を PY_THREADS（既定: 論理コア数の半分）に制限する
 *   - プロセス優先度を「通常以下」に下げる
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';

const THREADS = String(Number(process.env.PY_THREADS) || Math.max(1, Math.floor(os.cpus().length / 2)));

export function spawnPython(bin: string, args: string[], opts: { signal?: AbortSignal } = {}): ChildProcessWithoutNullStreams {
  const proc = spawn(bin, args, {
    ...opts,
    env: {
      ...process.env,
      OMP_NUM_THREADS: THREADS,
      MKL_NUM_THREADS: THREADS,
      OPENBLAS_NUM_THREADS: THREADS,
      NUMEXPR_NUM_THREADS: THREADS,
      TF_NUM_INTRAOP_THREADS: THREADS,
    },
  });
  if (proc.pid) {
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 権限が無ければそのまま */ }
  }
  return proc;
}
