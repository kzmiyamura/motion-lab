/**
 * usePersonalizedRecs — stale-while-revalidate パーソナライズ推薦フック
 *
 * - マウント時: キャッシュがあれば即返す
 * - キャッシュが古い (> 1h) または存在しない場合: バックグラウンドで検索 API を呼び出し更新
 * - エラー時: 既存キャッシュ or 空配列のまま（プリセットにフォールバック）
 */

import { useEffect, useRef, useState } from 'react';
import { searchHistory } from '../engine/storage';
import { searchYouTube } from '../engine/youtubeApi';
import {
  loadRecoCache,
  isRecoCacheStale,
  saveRecoCache,
  type VideoCardData,
} from '../engine/recoCache';

export interface PersonalizedRecsResult {
  items: VideoCardData[];
  isPersonalized: boolean;   // true = APIから取得したパーソナライズ結果
  isFetching: boolean;       // バックグラウンド更新中
  queries: string[];         // 使用したクエリ（デバッグ / ラベル表示用）
}

export function usePersonalizedRecs(): PersonalizedRecsResult {
  const [items, setItems] = useState<VideoCardData[]>([]);
  const [isPersonalized, setIsPersonalized] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [queries, setQueries] = useState<string[]>([]);
  const fetchingRef = useRef(false);

  useEffect(() => {
    // 1. キャッシュをロードして即座に表示
    const cached = loadRecoCache();
    if (cached && cached.items.length > 0) {
      setItems(cached.items);
      setIsPersonalized(true);
      setQueries(cached.queries);

      // 2. 新鮮なら更新不要
      if (!isRecoCacheStale(cached)) return;
    }

    // 3. 検索履歴がなければ何もしない（プリセットにフォールバック）
    const history = searchHistory.load();
    if (history.length === 0) return;

    // 4. バックグラウンド更新
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setIsFetching(true);

    // 上位 2 クエリで検索、結果をマージして重複排除
    const topQueries = history.slice(0, 2);

    Promise.all(
      topQueries.map(q =>
        searchYouTube(q, 8).catch(() => []),
      ),
    )
      .then(results => {
        const seen = new Set<string>();
        const merged: VideoCardData[] = [];
        for (const batch of results) {
          for (const item of batch) {
            if (!seen.has(item.videoId)) {
              seen.add(item.videoId);
              merged.push({
                id: item.videoId,
                title: item.title,
                artist: item.channelTitle,
              });
            }
          }
        }
        if (merged.length > 0) {
          saveRecoCache(merged, topQueries);
          setItems(merged);
          setIsPersonalized(true);
          setQueries(topQueries);
        }
      })
      .catch(() => { /* silent fail */ })
      .finally(() => {
        setIsFetching(false);
        fetchingRef.current = false;
      });
  }, []); // マウント時のみ

  return { items, isPersonalized, isFetching, queries };
}
