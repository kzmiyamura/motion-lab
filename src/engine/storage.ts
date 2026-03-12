/** localStorage のキー定義と読み書きユーティリティ */

/**
 * スキーマバージョン — トラック構成が変わるたびにインクリメント。
 *   v1: cowbell を low/high に分割
 *   v2: conga を open/slap/heel に分割（現在）
 */
const SCHEMA_VERSION = 2;

const KEYS = {
  schemaVersion:  'motionlab:schemaVersion',
  bpm:            'motionlab:bpm',
  patternId:      'motionlab:patternId',
  mutedTracks:    'motionlab:mutedTracks',
  backgroundPlay: 'motionlab:backgroundPlay',
  masterVolume:   'motionlab:masterVolume',
  loudness:       'motionlab:loudness',
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

export const storage = {
  getBpm:       ()         => load(KEYS.bpm, 180, Number),
  setBpm:       (v: number) => save(KEYS.bpm, String(v)),

  getPatternId: ()          => load(KEYS.patternId, 'son-2-3', s => s),
  setPatternId: (id: string) => save(KEYS.patternId, id),

  // デフォルト: clave のみ ON、残り全トラック OFF
  getMutedTracks: () => load(
    KEYS.mutedTracks,
    ['conga-open', 'conga-slap', 'conga-heel', 'cowbell-low', 'cowbell-high'] as string[],
    v => JSON.parse(v) as string[],
  ),
  setMutedTracks: (ids: string[]) => save(KEYS.mutedTracks, JSON.stringify(ids)),

  getBackgroundPlay: ()           => load(KEYS.backgroundPlay, true, v => v === 'true'),
  setBackgroundPlay: (v: boolean) => save(KEYS.backgroundPlay, String(v)),

  getMasterVolume: ()           => load(KEYS.masterVolume, 1.0, Number),
  setMasterVolume: (v: number)  => save(KEYS.masterVolume, String(v)),

  getLoudness: ()           => load(KEYS.loudness, true, v => v === 'true'),
  setLoudness: (v: boolean) => save(KEYS.loudness, String(v)),
};
