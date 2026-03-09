import { audioEngine, type TrackId } from '../engine/AudioEngine';
import { TrackRow } from './TrackRow';
import styles from './RhythmMachine.module.css';

type Props = {
  currentBeat: number;
  mutedTracks: Set<TrackId>;
  onToggleMute: (id: TrackId) => void;
};

const TRACKS: { id: TrackId; label: string; sublabel: string }[] = [
  { id: 'clave',        label: 'Clave',        sublabel: 'Wood stick click'    },
  { id: 'conga',        label: 'Conga',        sublabel: 'Tumbao pattern'      },
  { id: 'cowbell-low',  label: 'Cowbell Low',  sublabel: 'Open / Campana'      },
  { id: 'cowbell-high', label: 'Cowbell High', sublabel: 'Muted / Accent'      },
];

export function RhythmMachine({ currentBeat, mutedTracks, onToggleMute }: Props) {
  return (
    <div className={styles.machine}>
      {/* ── Clave & Conga ── */}
      {TRACKS.slice(0, 2).map(({ id, label, sublabel }) => (
        <TrackRow
          key={id}
          id={id}
          label={label}
          sublabel={sublabel}
          pattern={audioEngine.getTrack(id).pattern}
          currentBeat={currentBeat}
          muted={mutedTracks.has(id)}
          onToggleMute={() => onToggleMute(id)}
        />
      ))}

      {/* ── Campana (Cowbell) ── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Campana</span>
        {TRACKS.slice(2).map(({ id, label, sublabel }) => (
          <TrackRow
            key={id}
            id={id}
            label={label}
            sublabel={sublabel}
            pattern={audioEngine.getTrack(id).pattern}
            currentBeat={currentBeat}
            muted={mutedTracks.has(id)}
            onToggleMute={() => onToggleMute(id)}
          />
        ))}
      </div>
    </div>
  );
}
