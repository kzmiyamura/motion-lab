import { useState, useCallback, useRef, useEffect } from 'react';
import { searchYouTube, type YTVideoItem, YouTubeApiError } from '../engine/youtubeApi';
import { searchHistory as historyStore } from '../engine/storage';
import styles from './SearchPanel.module.css';

type Props = {
  /** 動画カードをタップしたとき */
  onSelect: (videoId: string, bpm: null) => void;
  /** 検索結果の有無を親に通知（true: 結果あり → VideoGrid を隠す） */
  onSearchStateChange: (active: boolean) => void;
};

export function SearchPanel({ onSelect, onSearchStateChange }: Props) {
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<string[]>(() => historyStore.load());
  const [results, setResults] = useState<YTVideoItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 結果の有無を親に通知
  useEffect(() => {
    onSearchStateChange(activeQuery !== null);
  }, [activeQuery, onSearchStateChange]);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setIsLoading(true);
    setError(null);
    setResults([]);
    setActiveQuery(trimmed);

    // 履歴に保存
    const next = historyStore.push(trimmed);
    setHistory(next);

    try {
      const items = await searchYouTube(trimmed, 12);
      setResults(items);
    } catch (e) {
      if (e instanceof YouTubeApiError) {
        setError(e.message);
      } else {
        setError('検索中にエラーが発生しました');
      }
      setActiveQuery(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    runSearch(query);
  }, [query, runSearch]);

  const clearResults = useCallback(() => {
    setResults([]);
    setActiveQuery(null);
    setError(null);
    setQuery('');
    inputRef.current?.focus();
  }, []);

  const handleChipClick = useCallback((q: string) => {
    setQuery(q);
    runSearch(q);
  }, [runSearch]);

  return (
    <div className={styles.wrapper}>
      {/* ── 検索フォーム ── */}
      <form className={styles.searchRow} onSubmit={handleSubmit}>
        <div className={styles.inputWrap}>
          <span className={styles.searchIcon} aria-hidden>🔍</span>
          <input
            ref={inputRef}
            className={styles.input}
            type="search"
            placeholder="ダンス動画を検索…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
        <button
          className={styles.searchBtn}
          type="submit"
          disabled={isLoading || !query.trim()}
        >
          {isLoading ? '…' : '検索'}
        </button>
      </form>

      {/* ── 最近の検索 ── */}
      {history.length > 0 && !activeQuery && (
        <div className={styles.historyRow}>
          <span className={styles.historyLabel}>最近:</span>
          <div className={styles.chips}>
            {history.map(q => (
              <button
                key={q}
                className={styles.chip}
                onClick={() => handleChipClick(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── ローディング ── */}
      {isLoading && (
        <div className={styles.loading}>
          <span className={styles.spinner} />
          <span>検索中…</span>
        </div>
      )}

      {/* ── エラー ── */}
      {error && (
        <div className={styles.error}>
          <p className={styles.errorText}>{error}</p>
          <button className={styles.clearBtn} onClick={clearResults}>✕ 閉じる</button>
        </div>
      )}

      {/* ── 検索結果 ── */}
      {results.length > 0 && (
        <div className={styles.resultsSection}>
          <div className={styles.resultHeader}>
            <span className={styles.resultLabel}>「{activeQuery}」の検索結果</span>
            <button className={styles.clearBtn} onClick={clearResults}>✕ クリア</button>
          </div>
          <div className={styles.grid}>
            {results.map(item => (
              <button
                key={item.videoId}
                className={styles.card}
                onClick={() => onSelect(item.videoId, null)}
              >
                <div className={styles.thumbWrap}>
                  {item.thumbnailUrl ? (
                    <img
                      className={styles.thumb}
                      src={item.thumbnailUrl}
                      alt={item.title}
                      loading="lazy"
                      onError={e => {
                        // fallback to youtube CDN
                        const img = e.currentTarget as HTMLImageElement;
                        const fallback = `https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`;
                        if (img.src !== fallback) img.src = fallback;
                        else img.style.opacity = '0';
                      }}
                    />
                  ) : (
                    <img
                      className={styles.thumb}
                      src={`https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`}
                      alt={item.title}
                      loading="lazy"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }}
                    />
                  )}
                </div>
                <div className={styles.info}>
                  <p className={styles.title}>{item.title}</p>
                  <p className={styles.channel}>{item.channelTitle}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 結果 0 件 */}
      {!isLoading && activeQuery && results.length === 0 && !error && (
        <div className={styles.empty}>
          <p>「{activeQuery}」に一致する動画が見つかりませんでした</p>
          <button className={styles.clearBtn} onClick={clearResults}>← 戻る</button>
        </div>
      )}
    </div>
  );
}
