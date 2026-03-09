/** localStorage のキー定義と読み書きユーティリティ */

const KEYS = {
  bpm:         'motionlab:bpm',
  patternId:   'motionlab:patternId',
  mutedTracks: 'motionlab:mutedTracks',
} as const;

function load<T>(key: string, fallback: T, parse: (v: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* quota超過等は無視 */ }
}

export const storage = {
  getBpm:       ()         => load(KEYS.bpm, 180, Number),
  setBpm:       (v: number) => save(KEYS.bpm, String(v)),

  getPatternId: ()          => load(KEYS.patternId, 'son-2-3', s => s),
  setPatternId: (id: string) => save(KEYS.patternId, id),

  getMutedTracks: () => load(KEYS.mutedTracks, [] as string[], v => JSON.parse(v) as string[]),
  setMutedTracks: (ids: string[]) => save(KEYS.mutedTracks, JSON.stringify(ids)),
};
