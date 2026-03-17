/**
 * Reads ?bpm=&vid=&offset= from the URL on first render.
 * Used by iPhone to auto-apply analysis data received via QR code.
 */
import { useMemo } from 'react';

export type UrlAnalysisParams = {
  bpm: number | null;
  youtubeId: string | null;
  offset: number;
};

export function useUrlAnalysis(): UrlAnalysisParams {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const bpmRaw = p.get('bpm');
    const vid = p.get('vid');
    const offsetRaw = p.get('offset');
    const bpm = bpmRaw ? parseInt(bpmRaw, 10) : null;
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
    return {
      bpm: bpm !== null && isFinite(bpm) ? bpm : null,
      youtubeId: vid ?? null,
      offset: isFinite(offset) ? offset : 0,
    };
  }, []);
}
