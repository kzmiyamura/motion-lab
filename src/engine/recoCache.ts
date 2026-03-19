/**
 * パーソナライズ動画のキャッシュ（localStorage）
 * TTL: 1時間 — アプリが暇なときにバックグラウンドで更新される
 */

import type { PresetGenre } from './videoPresets';

/** VideoGrid のカード1枚分のデータ（プリセット・API結果の共通型） */
export interface VideoCardData {
  id: string;
  title: string;
  artist?: string;
  bpm?: number;
  genre?: PresetGenre;
}

interface RecoCacheEntry {
  items: VideoCardData[];
  queries: string[];   // 使用したクエリ（ラベル表示用）
  fetchedAt: number;
}

const KEY = 'motionlab:reco-cache';
const TTL_MS = 60 * 60 * 1000; // 1時間

export function loadRecoCache(): RecoCacheEntry | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as RecoCacheEntry;
  } catch { return null; }
}

export function isRecoCacheStale(entry: RecoCacheEntry): boolean {
  return Date.now() - entry.fetchedAt > TTL_MS;
}

export function saveRecoCache(items: VideoCardData[], queries: string[]): void {
  try {
    const entry: RecoCacheEntry = { items, queries, fetchedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(entry));
  } catch { /* quota超過は無視 */ }
}
