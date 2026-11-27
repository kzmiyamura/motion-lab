import { useEffect, useState } from 'react';

/** PC 幅（900px 以上）か。画面幅の変化に追従する */
export function useWideScreen(minWidth = 900): boolean {
  const query = `(min-width: ${minWidth}px)`;
  const [wide, setWide] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return wide;
}
