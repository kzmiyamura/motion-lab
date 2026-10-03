import type { Routine } from './routineClip';

/**
 * 解析レポート → 3D タブへルーティンを渡す受け渡し口。
 * 3D タブは開いている間だけマウントされるので、まず置いておき、
 * イベントで App（タブ切り替え）と SalsaStage3D（読み込み）に知らせる。
 */
export const ROUTINE_EVENT = 'motionlab:routine';

let pending: { routine: Routine; title: string } | null = null;

export function sendRoutineTo3D(routine: Routine, title: string): void {
  pending = { routine, title };
  window.dispatchEvent(new Event(ROUTINE_EVENT));
}

/** 受け取ったら消す（同じルーティンを二重に読み込まない） */
export function takePendingRoutine(): { routine: Routine; title: string } | null {
  const p = pending;
  pending = null;
  return p;
}
