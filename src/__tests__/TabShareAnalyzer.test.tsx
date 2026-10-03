import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { TabShareAnalyzer } from '../components/TabShareAnalyzer';
import type { YtPlayerLike } from '../engine/tabShare';

const origMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true });
}

afterEach(() => {
  if (origMediaDevices) Object.defineProperty(navigator, 'mediaDevices', origMediaDevices);
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
});

function renderIt() {
  const playerRef = createRef<YtPlayerLike | null>();
  return render(
    <TabShareAnalyzer bpm={0} videoId="abcdefghijk" playerRef={playerRef} getIframe={() => null} />,
  );
}

describe('TabShareAnalyzer', () => {
  it('getDisplayMedia が無い環境（iOS Safari など）では骨格解析ボタンを無効化し理由を表示する', () => {
    setMediaDevices(undefined);
    renderIt();
    const btn = screen.getByRole('button', { name: '骨格解析' });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/画面共有/);
    expect(screen.getByText(/対応していないため骨格解析できません/)).toBeInTheDocument();
  });

  it('getDisplayMedia がある環境では骨格解析ボタンが押せる。JSON書き出しはイベントが無い間は無効', () => {
    setMediaDevices({ getDisplayMedia: () => Promise.reject(new DOMException('x', 'NotAllowedError')) });
    renderIt();
    expect(screen.getByRole('button', { name: '骨格解析' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'JSON書き出し' })).toBeDisabled();
  });
});
