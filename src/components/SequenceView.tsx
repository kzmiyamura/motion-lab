import { useState, useCallback } from 'react';
import type { SequenceEvent } from '../hooks/usePoseEstimation';
import styles from './SequenceView.module.css';

interface Props {
  events: SequenceEvent[];
  duration: number;        // video duration in seconds (0 if unknown)
  currentTime: number;
  onClear: () => void;
}

const ACTION_COLORS: Record<string, string> = {
  Turn:       '#a855f7',
  SideStep:   '#3b82f6',
  Dip:        '#ef4444',
  CBL:        '#22c55e',
  Hammerlock: '#f97316',
};

function getActionColor(action: string): string {
  return ACTION_COLORS[action] ?? '#94a3b8';
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

function qualityToStars(q: number): string {
  const filled = Math.round(q * 5);
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

export function SequenceView({ events, duration, currentTime, onClear }: Props) {
  const [toast, setToast] = useState('');

  const handleCopyMarkdown = useCallback(async () => {
    const header = '## Salsa Routine Sequence\n\n| 時刻 | アクション | クオリティ | ビート |\n|------|-----------|-----------|-------|';
    const rows = events.map(e => {
      const timeStr = formatTime(e.time);
      const stars = qualityToStars(e.quality);
      const beat = e.beatNum !== undefined ? `♩${e.beatNum}/8` : '';
      return `| ${timeStr} | ${e.action} | ${stars} | ${beat} |`;
    });
    const md = [header, ...rows].join('\n');

    try {
      await navigator.clipboard.writeText(md);
      setToast('コピーしました');
      setTimeout(() => setToast(''), 2000);
    } catch {
      // ignore clipboard errors
    }
  }, [events]);

  const showTimeline = duration > 0 && events.length > 0;
  const visibleEvents = events.slice(-50).reverse();

  return (
    <div className={styles.wrap}>
      {toast && <div className={styles.toast}>{toast}</div>}

      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>📋 シーケンス ({events.length}件)</span>
        <div className={styles.btnGroup}>
          <button className={styles.clearBtn} onClick={onClear}>クリア</button>
          <button className={styles.copyBtn} onClick={handleCopyMarkdown}>📋 Markdown コピー</button>
        </div>
      </div>

      {/* Mini timeline */}
      {showTimeline && (
        <>
          <div className={styles.timeline}>
            <div className={styles.timelineBar}>
              {events.map(evt => (
                <div
                  key={evt.id}
                  className={styles.timelineChip}
                  style={{
                    left: `${(evt.time / duration) * 100}%`,
                    width: Math.max(8, (duration > 0 ? 4 : 8)),
                    background: getActionColor(evt.action),
                  }}
                  title={`${formatTime(evt.time)} ${evt.action}`}
                />
              ))}
              {/* Current time cursor */}
              <div
                className={styles.timelineCursor}
                style={{ left: `${(currentTime / duration) * 100}%` }}
              />
            </div>
          </div>
          <div className={styles.timeLabels}>
            <span>00:00</span>
            <span>{formatTime(duration)}</span>
          </div>
        </>
      )}

      {/* Event list */}
      <div className={styles.eventList}>
        {visibleEvents.length === 0 ? (
          <div className={styles.empty}>イベントなし（動画再生中に検出されます）</div>
        ) : (
          visibleEvents.map(evt => (
            <div key={evt.id} className={styles.eventRow}>
              <span className={styles.timeTag}>{formatTime(evt.time)}</span>
              <span
                className={styles.actionBadge}
                style={{ background: getActionColor(evt.action) }}
              >
                {evt.action}
              </span>
              <span className={styles.quality}>{qualityToStars(evt.quality)}</span>
              <span className={styles.beatTag}>
                {evt.beatNum !== undefined ? `♩${evt.beatNum}` : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
