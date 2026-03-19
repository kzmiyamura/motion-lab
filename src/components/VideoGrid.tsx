import { useState } from 'react';
import { PRESET_VIDEOS, type PresetGenre } from '../engine/videoPresets';
import styles from './VideoGrid.module.css';

type HistoryEntry = { url: string; bpm: number | null };
type GenreFilter = 'all' | PresetGenre;

type Props = {
  history: HistoryEntry[];
  onSelect: (videoId: string, bpm: number | null) => void;
};

function extractId(urlOrId: string): string | null {
  const t = urlOrId.trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  try {
    const url = new URL(t);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0];
    return url.searchParams.get('v');
  } catch { return null; }
}

function ThumbCard({
  videoId,
  title,
  artist,
  bpm,
  genre,
  onClick,
}: {
  videoId: string;
  title?: string;
  artist?: string;
  bpm?: number | null;
  genre?: string;
  onClick: () => void;
}) {
  return (
    <button className={styles.card} onClick={onClick}>
      <div className={styles.thumbWrap}>
        <img
          className={styles.thumb}
          src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
          alt={title ?? videoId}
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.opacity = '0';
          }}
        />
      </div>
      <div className={styles.info}>
        {title && <p className={styles.title}>{title}</p>}
        {artist && <p className={styles.artist}>{artist}</p>}
        <div className={styles.meta}>
          {bpm != null && (
            <span className={styles.bpmBadge}>{bpm} BPM</span>
          )}
          {genre && (
            <span
              className={`${styles.genreBadge} ${
                genre === 'salsa' ? styles.genreSalsa : styles.genreBachata
              }`}
            >
              {genre === 'salsa' ? 'Salsa' : 'Bachata'}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export function VideoGrid({ history, onSelect }: Props) {
  const [filter, setFilter] = useState<GenreFilter>('all');

  // history から有効な videoId のみ抽出
  const historyCards = history
    .map(e => ({ id: extractId(e.url), bpm: e.bpm }))
    .filter((e): e is { id: string; bpm: number | null } => e.id !== null);

  const filteredPresets =
    filter === 'all'
      ? PRESET_VIDEOS
      : PRESET_VIDEOS.filter(p => p.genre === filter);

  return (
    <div className={styles.wrapper}>
      {/* ── 最近の動画 ── */}
      {historyCards.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionLabel}>最近の動画</h3>
          <div className={styles.grid}>
            {historyCards.map(({ id, bpm }) => (
              <ThumbCard
                key={id}
                videoId={id}
                bpm={bpm}
                onClick={() => onSelect(id, bpm)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── 練習におすすめ ── */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionLabel}>練習におすすめ</h3>
          <div className={styles.filterRow}>
            {(['all', 'salsa', 'bachata'] as GenreFilter[]).map(g => (
              <button
                key={g}
                className={`${styles.filterBtn} ${filter === g ? styles.filterBtnActive : ''}`}
                onClick={() => setFilter(g)}
              >
                {g === 'all' ? 'All' : g === 'salsa' ? '💃 Salsa' : '🌹 Bachata'}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.grid}>
          {filteredPresets.map(p => (
            <ThumbCard
              key={p.id}
              videoId={p.id}
              title={p.title}
              artist={p.artist}
              bpm={p.bpm}
              genre={p.genre}
              onClick={() => onSelect(p.id, p.bpm)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
