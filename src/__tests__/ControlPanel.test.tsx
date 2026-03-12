import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ControlPanel } from '../components/ControlPanel';

const baseProps = {
  isPlaying: false,
  bpm: 120,
  onStart: vi.fn(),
  onStop: vi.fn(),
  onBpmChange: vi.fn(),
  onFileLoad: vi.fn(),
  masterVolume: 0.8,
  onMasterVolumeChange: vi.fn(),
  backgroundPlay: false,
  onBackgroundPlayChange: vi.fn(),
  congaMuted: true,
  onCongaMuteToggle: vi.fn(),
  cowbellMuted: true,
  onCowbellMuteToggle: vi.fn(),
  randomFlipMode: false,
  onRandomFlipModeChange: vi.fn(),
  loudness: true,
  onLoudnessChange: vi.fn(),
};

describe('ControlPanel', () => {
  it('renders Start button when not playing', () => {
    render(<ControlPanel {...baseProps} />);
    expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
  });

  it('renders Stop button when playing', () => {
    render(<ControlPanel {...baseProps} isPlaying={true} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('calls onStart when Start is clicked', () => {
    const onStart = vi.fn();
    render(<ControlPanel {...baseProps} onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('calls onStop when Stop is clicked', () => {
    const onStop = vi.fn();
    render(<ControlPanel {...baseProps} isPlaying={true} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('calls onBpmChange with numeric value on slider change', () => {
    const onBpmChange = vi.fn();
    render(<ControlPanel {...baseProps} onBpmChange={onBpmChange} />);
    fireEvent.change(screen.getByLabelText('BPM'), { target: { value: '180' } });
    expect(onBpmChange).toHaveBeenCalledWith(180);
  });

  it('displays the current BPM', () => {
    render(<ControlPanel {...baseProps} bpm={180} />);
    expect(screen.getByText('180')).toBeInTheDocument();
  });

  it('calls onBpmChange when a category button is clicked', () => {
    const onBpmChange = vi.fn();
    render(<ControlPanel {...baseProps} onBpmChange={onBpmChange} />);
    fireEvent.click(screen.getByText('ミディアム'));
    expect(onBpmChange).toHaveBeenCalledWith(180);
  });

  it('highlights the active category based on current BPM', () => {
    render(<ControlPanel {...baseProps} bpm={210} />);
    // BPM 210 はファスト(196-225)に該当
    expect(screen.getByText('ファスト').closest('button')).toHaveAttribute('class', expect.stringContaining('catBtnActive'));
  });
});
