import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VideoControls } from '../components/VideoControls';
import type { SlowRate } from '../hooks/useVideoTraining';

const baseProps = {
  ytPlaying: false,
  onTogglePlay: vi.fn(),
  onStep: vi.fn(),
  slowRate: 1.0 as SlowRate,
  onSlowRate: vi.fn(),
  loopStart: null,
  loopEnd: null,
  isLooping: false,
  onMarkLoop: vi.fn(),
  onClearLoop: vi.fn(),
  onToggleLoop: vi.fn(),
  onPreset: vi.fn(),
};

describe('VideoControls', () => {
  it('renders play button', () => {
    render(<VideoControls {...baseProps} />);
    expect(screen.getByText('▶')).toBeInTheDocument();
  });

  it('does not render mirror button when onMirrorToggle is not provided', () => {
    render(<VideoControls {...baseProps} />);
    expect(screen.queryByLabelText('ミラー反転')).not.toBeInTheDocument();
  });

  it('renders mirror button when onMirrorToggle is provided', () => {
    render(<VideoControls {...baseProps} onMirrorToggle={vi.fn()} />);
    expect(screen.getByLabelText('ミラー反転')).toBeInTheDocument();
  });

  it('calls onMirrorToggle when mirror button is clicked', () => {
    const onMirrorToggle = vi.fn();
    render(<VideoControls {...baseProps} onMirrorToggle={onMirrorToggle} />);
    fireEvent.click(screen.getByLabelText('ミラー反転'));
    expect(onMirrorToggle).toHaveBeenCalledOnce();
  });

  it('mirror button shows active state when isMirrored is true', () => {
    render(<VideoControls {...baseProps} isMirrored={true} onMirrorToggle={vi.fn()} />);
    const btn = screen.getByLabelText('ミラー反転');
    expect(btn.title).toBe('ミラー解除');
  });

  it('mirror button shows inactive state when isMirrored is false', () => {
    render(<VideoControls {...baseProps} isMirrored={false} onMirrorToggle={vi.fn()} />);
    const btn = screen.getByLabelText('ミラー反転');
    expect(btn.title).toBe('ミラー反転');
  });
});
