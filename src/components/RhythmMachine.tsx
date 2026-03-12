import { audioEngine, type TrackId } from '../engine/AudioEngine';
import { type Genre } from '../hooks/useAudioEngine';
import { TrackRow } from './TrackRow';
import styles from './RhythmMachine.module.css';

type Props = {
  genre: Genre;
  currentBeat: number;
  mutedTracks: Set<TrackId>;
  onToggleMute: (id: TrackId) => void;
};

const CONGA_TRACKS: { id: TrackId; label: string; sublabel: string }[] = [
  { id: 'conga-open', label: 'Conga Open', sublabel: 'Open / ドーン' },
  { id: 'conga-slap', label: 'Conga Slap', sublabel: 'Slap / パシッ'  },
  { id: 'conga-heel', label: 'Conga Heel', sublabel: 'Heel・Toe / ゴソゴソ' },
];

const COWBELL_TRACKS: { id: TrackId; label: string; sublabel: string }[] = [
  { id: 'cowbell-low',  label: 'Cowbell Low',  sublabel: 'Open / Campana'  },
  { id: 'cowbell-high', label: 'Cowbell High', sublabel: 'Muted / Accent'  },
];

const BACHATA_TRACKS: { id: TrackId; label: string; sublabel: string }[] = [
  { id: 'bongo-low',  label: 'Bongo Low',  sublabel: 'Macho / ドン' },
  { id: 'bongo-high', label: 'Bongo High', sublabel: 'Hembra / タン' },
  { id: 'guira',      label: 'Güira',      sublabel: 'Scraper / シャッ' },
  { id: 'bass',       label: 'Bass',       sublabel: 'Beat 4 & 8 accent' },
];

export function RhythmMachine({ genre, currentBeat, mutedTracks, onToggleMute }: Props) {
  if (genre === 'bachata') {
    return (
      <div className={styles.machine}>
        <div className={styles.group}>
          <span className={styles.groupLabel}>Bachata</span>
          {BACHATA_TRACKS.map(({ id, label, sublabel }) => (
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

  return (
    <div className={styles.machine}>
      {/* ── Clave ── */}
      <TrackRow
        id="clave"
        label="Clave"
        sublabel="Wood stick click"
        pattern={audioEngine.getTrack('clave').pattern}
        currentBeat={currentBeat}
        muted={mutedTracks.has('clave')}
        onToggleMute={() => onToggleMute('clave')}
      />

      {/* ── Tumbao (Conga) ── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Tumbao</span>
        {CONGA_TRACKS.map(({ id, label, sublabel }) => (
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

      {/* ── Campana (Cowbell) ── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Campana</span>
        {COWBELL_TRACKS.map(({ id, label, sublabel }) => (
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
