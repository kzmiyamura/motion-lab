/** Persists BPM analysis results in localStorage, keyed by YouTube video ID. */
export type AnalysisResult = {
  bpm: number;
  offset: number; // ms
  analyzedAt: number; // Unix timestamp ms
};

const PREFIX = 'motionlab:analysis:';

export const analysisStorage = {
  save(youtubeId: string, result: AnalysisResult): void {
    try { localStorage.setItem(PREFIX + youtubeId, JSON.stringify(result)); } catch { /* quota */ }
  },
  load(youtubeId: string): AnalysisResult | null {
    try {
      const raw = localStorage.getItem(PREFIX + youtubeId);
      return raw ? (JSON.parse(raw) as AnalysisResult) : null;
    } catch { return null; }
  },
  remove(youtubeId: string): void {
    try { localStorage.removeItem(PREFIX + youtubeId); } catch { /* ignore */ }
  },
};
