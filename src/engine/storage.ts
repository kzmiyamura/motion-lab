/** localStorage のキー定義と読み書きユーティリティ */

/**
 * スキーマバージョン — トラック構成が変わるたびにインクリメント。
 *   v1: cowbell を low/high に分割
 *   v2: conga を open/slap/heel に分割
 *   v3: Bachata トラック追加（bongo/guira/bass）
 */
const SCHEMA_VERSION = 3;

const KEYS = {
  schemaVersion:  'motionlab:schemaVersion',
  bpm:            'motionlab:bpm',
  patternId:      'motionlab:patternId',
  mutedTracks:    'motionlab:mutedTracks',
  backgroundPlay: 'motionlab:backgroundPlay',
  masterVolume:   'motionlab:masterVolume',
  loudness:       'motionlab:loudness',
  genre:          'motionlab:genre',
  reverbType:     'motionlab:reverbType',
  reverbWetLevel: 'motionlab:reverbWetLevel',
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

/**
 * トラック構成変更に伴う localStorage マイグレーション。
 * storage モジュールのインポート時に一度だけ実行される。
 * 旧バージョンのミュート状態は構造が合わないためリセットし、
 * 新しいデフォルト値を使用する。
 */
;(function migrate() {
  const savedVersion = load(KEYS.schemaVersion, 0, Number);
  if (savedVersion < SCHEMA_VERSION) {
    // ミュート状態をリセット（新しいトラック構成のデフォルトを使用）
    try { localStorage.removeItem(KEYS.mutedTracks); } catch { /* ignore */ }
    save(KEYS.schemaVersion, String(SCHEMA_VERSION));
  }
})();

// ── 検索ワード履歴 ────────────────────────────────────────────────────────
const SEARCH_HISTORY_KEY = 'motionlab:search-history';
const MAX_SEARCH_HISTORY = 6;

export const searchHistory = {
  load: (): string[] => {
    try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) ?? '[]'); }
    catch { return []; }
  },
  push: (query: string): string[] => {
    const prev = searchHistory.load();
    const next = [query, ...prev.filter(q => q !== query)].slice(0, MAX_SEARCH_HISTORY);
    try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next)); } catch { /* quota */ }
    return next;
  },
};

// ── メイン storage ─────────────────────────────────────────────────────────
export const storage = {
  getBpm:       ()         => load(KEYS.bpm, 180, Number),
  setBpm:       (v: number) => save(KEYS.bpm, String(v)),

  getPatternId: ()          => load(KEYS.patternId, 'son-2-3', s => s),
  setPatternId: (id: string) => save(KEYS.patternId, id),

  // デフォルト: clave のみ ON、残り全トラック OFF
  getMutedTracks: () => load(
    KEYS.mutedTracks,
    ['conga-open', 'conga-slap', 'conga-heel', 'cowbell-low', 'cowbell-high',
     'bongo-low', 'bongo-high', 'guira', 'bass'] as string[],
    v => JSON.parse(v) as string[],
  ),
  setMutedTracks: (ids: string[]) => save(KEYS.mutedTracks, JSON.stringify(ids)),

  getBackgroundPlay: ()           => load(KEYS.backgroundPlay, true, v => v === 'true'),
  setBackgroundPlay: (v: boolean) => save(KEYS.backgroundPlay, String(v)),

  getMasterVolume: ()           => load(KEYS.masterVolume, 1.0, Number),
  setMasterVolume: (v: number)  => save(KEYS.masterVolume, String(v)),

  getLoudness: ()           => load(KEYS.loudness, true, v => v === 'true'),
  setLoudness: (v: boolean) => save(KEYS.loudness, String(v)),

  getGenre: () => load(KEYS.genre, 'salsa' as 'salsa' | 'bachata', s => s as 'salsa' | 'bachata'),
  setGenre: (v: 'salsa' | 'bachata') => save(KEYS.genre, v),

  getReverbType:     () => load(KEYS.reverbType, 'none' as import('./AudioEngine').ReverbType, s => s as import('./AudioEngine').ReverbType),
  setReverbType:     (v: import('./AudioEngine').ReverbType) => save(KEYS.reverbType, v),
  getReverbWetLevel: () => load(KEYS.reverbWetLevel, 0.8, Number),
  setReverbWetLevel: (v: number) => save(KEYS.reverbWetLevel, String(v)),
};
