import { useCallback, useEffect, useState } from 'react';
import { loadReportView, saveReportView, type ReportView } from '../engine/flipView';

/**
 * 振付シートの表示（めくり / 一覧）の選び方。localStorage に覚える（無ければ 600px 以下 = めくり）。
 * at = めくりで開く技（SheetRow.index）。一覧でカードを押した技を覚えておく
 */
export function useReportView() {
  const [view, setViewState] = useState<ReportView>(() => loadReportView());
  const [at, setAt] = useState<number | null>(null);
  const setView = useCallback((v: ReportView) => {
    setViewState(v);
    saveReportView(v);
  }, []);
  const openAt = useCallback((rowIndex: number) => {
    setAt(rowIndex);
    setView('flip');
  }, [setView]);
  return { view, setView, at, setAt, openAt };
}

/**
 * 一覧のカード（ChoreoSheet の data-testid="choreo-row"）を押したら onTap(行 index)。
 * ChoreoSheet には手を入れず、document の click（キャプチャ）で拾う。モーダルが click の伝わりを止めるので
 * バブルでは届かない。範囲選び・長押しの後の click は ChoreoSheet が preventDefault するので、
 * click の処理が全部終わってから（setTimeout 0）defaultPrevented を見て除く。カードの中のリンク（写真を開く）も除く
 */
export function useCardTap(enabled: boolean, onTap: (rowIndex: number) => void) {
  useEffect(() => {
    if (!enabled) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest || target.closest('a')) return;
      const card = target.closest('[data-testid="choreo-row"][data-index]');
      if (!card) return;
      const idx = Number(card.getAttribute('data-index'));
      if (!Number.isFinite(idx)) return;
      const id = setTimeout(() => {
        timers.delete(id);
        if (!e.defaultPrevented) onTap(idx);
      }, 0);
      timers.add(id);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      timers.forEach(clearTimeout);
    };
  }, [enabled, onTap]);
}
