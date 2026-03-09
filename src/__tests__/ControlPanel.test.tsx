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
    fireEvent.change(screen.getByRole('slider'), { target: { value: '140' } });
    expect(onBpmChange).toHaveBeenCalledWith(140);
  });

  it('displays the current BPM', () => {
    render(<ControlPanel {...baseProps} bpm={95} />);
    expect(screen.getByText('95')).toBeInTheDocument();
  });
});
