import { useCallback, useMemo, useState } from 'react';
import type { ChoreoSheetData, SheetRow } from '../engine/choreoSheet';
import { buildTimeline, gridFromResultJson, type Timeline } from '../engine/practice';
import { practiceAudio } from '../engine/practiceAudio';

/** 練習の 1 回分: 1 技のループ・範囲ループ・通し練習 */
export type PracticeSession = { kind: 'move' | 'range' | 'run'; from: number; to: number; loop: boolean; label: string };

/**
 * 振付シートの練習モードの状態（ReportModal から使う）。
 * カード・ボタンの処理はタップの中で呼ばれるので、そこで音を準備する（iOS）
 */
export function usePracticeSession(sheet: ChoreoSheetData | null, resultJson: string | null) {
  const timeline: Timeline | null = useMemo(() => {
    if (!sheet) return null;
    const g = gridFromResultJson(resultJson);
    return buildTimeline(sheet.rows, sheet.beatSec ?? g.beatSec, { phaseSec: g.phaseSec, timing: g.timing });
  }, [sheet, resultJson]);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  /** 範囲選び: null = していない、-1 = 始め待ち、それ以外 = 始めの行 index */
  const [pickFrom, setPickFrom] = useState<number | null>(null);

  const rowsByIndex = useMemo(() => new Map((sheet?.rows ?? []).map(r => [r.index, r])), [sheet]);

  const start = useCallback((s: PracticeSession) => {
    practiceAudio.unlock();
    setCurrent(s.from);
    setSession(s);
  }, []);

  const close = useCallback(() => { setSession(null); setCurrent(null); }, []);

  /** カードを押した: その技を繰り返す（同じカードをもう一度押したら閉じる） */
  const playRow = useCallback((row: SheetRow) => {
    if (session?.kind === 'move' && session.from === row.index) { close(); return; }
    start({ kind: 'move', from: row.index, to: row.index, loop: true, label: `#${row.no} ${row.name}（${row.counts}）` });
  }, [session, start, close]);

  const runThrough = useCallback(() => {
    if (!timeline) return;
    const segs = timeline.segs;
    setPickFrom(null);
    start({ kind: 'run', from: segs[0].index, to: segs[segs.length - 1].index, loop: false, label: `通し練習（#${segs[0].no}〜#${segs[segs.length - 1].no}）` });
  }, [timeline, start]);

  const startRange = useCallback((a: number, b: number) => {
    const lo = rowsByIndex.get(Math.min(a, b)), hi = rowsByIndex.get(Math.max(a, b));
    if (!lo || !hi) return;
    setPickFrom(null);
    start({ kind: 'range', from: lo.index, to: hi.index, loop: true, label: `範囲ループ #${lo.no}〜#${hi.no}` });
  }, [rowsByIndex, start]);

  /** 範囲選び中にカードを押した: 1 枚目 = 始め、2 枚目 = 終わり（同じカードなら 1 技のループ） */
  const pick = useCallback((row: SheetRow) => {
    if (pickFrom === null || pickFrom < 0) { setPickFrom(row.index); return; }
    startRange(pickFrom, row.index);
  }, [pickFrom, startRange]);

  /** 長押し: 範囲の始めにする（もう一度長押しでやめる） */
  const longPress = useCallback((row: SheetRow) => {
    setPickFrom(p => (p === row.index ? null : row.index));
  }, []);

  return {
    timeline, session, current, setCurrent, close, playRow, runThrough, pick, longPress,
    pickFrom,
    pickFromNo: pickFrom === null ? null : pickFrom < 0 ? -1 : rowsByIndex.get(pickFrom)?.no ?? -1,
    startPick: () => setPickFrom(-1),
    cancelPick: () => setPickFrom(null),
  };
}
