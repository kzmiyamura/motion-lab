import { audioEngine, type TrackId } from '../engine/AudioEngine';
import { TrackRow } from './TrackRow';
import styles from './RhythmMachine.module.css';

type Props = {
  currentBeat: number;
  mutedTracks: Set<TrackId>;
  onToggleMute: (id: TrackId) => void;
};

const TRACKS: { id: TrackId; label: string; sublabel: string }[] = [
  { id: 'clave',   label: 'Clave',   sublabel: 'Wood stick click' },
  { id: 'conga',   label: 'Conga',   sublabel: 'Tumbao pattern' },
  { id: 'cowbell', label: 'Cowbell', sublabel: 'Metal accent' },
];

export function RhythmMachine({ currentBeat, mutedTracks, onToggleMute }: Props) {
  return (
    <div className={styles.machine}>
      {TRACKS.map(({ id, label, sublabel }) => (
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
  );
}
