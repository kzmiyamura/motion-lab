import { useState, useCallback, useRef, useEffect } from 'react';
import type { YouTubePlayer } from 'react-youtube';

// ── Types ──────────────────────────────────────────────────────────────────
export type SlowRate = 0.25 | 0.5 | 0.75 | 0.8 | 0.9 | 1.0 | 1.1 | 1.2 | 1.25 | 1.5 | 1.75 | 2.0;
export const SLOW_RATES: SlowRate[] = [0.25, 0.5, 0.75, 0.8, 0.9, 1.0, 1.1, 1.2, 1.25, 1.5, 1.75, 2.0];

export interface ZoomState {
  scale: number; // 1–3
  x: number;     // translateX px (unscaled coords)
  y: number;     // translateY px (unscaled coords)
}

export const ZOOM_PRESETS = [
  { id: 'full',  label: '全体',   scale: 1.0, x: 0,  y: 0   },
  { id: 'feet',  label: '足元',   scale: 2.5, x: 0,  y: -50 },
  { id: 'upper', label: '上半身', scale: 2.0, x: 0,  y: 30  },
] as const;
export type ZoomPresetId = typeof ZOOM_PRESETS[number]['id'];

// ── Main hook ──────────────────────────────────────────────────────────────
export function useVideoTraining(
  playerRef: React.MutableRefObject<YouTubePlayer | null>,
  enabled: boolean,
  onTapRef?: React.MutableRefObject<(() => void) | undefined>,
) {
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, x: 0, y: 0 });
  const [slowRate, setSlowRateState] = useState<SlowRate>(1.0);
  const [ytPlaying, setYtPlaying] = useState(false);
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [isLooping, setIsLooping] = useState(false);
  const loopIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Loop polling ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !isLooping || loopStart === null || loopEnd === null) {
      if (loopIntervalRef.current) {
        clearInterval(loopIntervalRef.current);
        loopIntervalRef.current = null;
      }
      return;
    }
    loopIntervalRef.current = setInterval(() => {
      try {
        const t = playerRef.current?.getCurrentTime?.();
        if (typeof t === 'number' && loopEnd !== null && loopStart !== null && t >= loopEnd) {
          playerRef.current?.seekTo(loopStart, true);
        }
      } catch { /* ignore */ }
    }, 100);
    return () => {
      if (loopIntervalRef.current) {
        clearInterval(loopIntervalRef.current);
        loopIntervalRef.current = null;
      }
    };
  }, [enabled, isLooping, loopStart, loopEnd, playerRef]);

  // ── Actions ────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    try {
      if (ytPlaying) {
        playerRef.current?.pauseVideo();
      } else {
        playerRef.current?.playVideo();
      }
    } catch { /* ignore */ }
  }, [ytPlaying, playerRef]);

  const setSlowRate = useCallback((rate: SlowRate) => {
    setSlowRateState(rate);
  }, []);

  // Apply current slow rate to the player (called on mode switch)
  const activateSlowRate = useCallback((rate?: SlowRate) => {
    try { playerRef.current?.setPlaybackRate(rate ?? slowRate); } catch { /* ignore */ }
  }, [playerRef, slowRate]);

  const stepFrame = useCallback((direction: 1 | -1) => {
    try {
      const t = playerRef.current?.getCurrentTime?.() ?? 0;
      playerRef.current?.seekTo(Math.max(0, t + direction * 0.033), true);
    } catch { /* ignore */ }
  }, [playerRef]);

  const markLoop = useCallback((point: 'start' | 'end') => {
    try {
      const t = playerRef.current?.getCurrentTime?.();
      if (typeof t !== 'number') return;
      if (point === 'start') setLoopStart(t);
      else setLoopEnd(t);
    } catch { /* ignore */ }
  }, [playerRef]);

  const clearLoop = useCallback(() => {
    setLoopStart(null);
    setLoopEnd(null);
    setIsLooping(false);
  }, []);

  const applyPreset = useCallback((id: ZoomPresetId) => {
    const p = ZOOM_PRESETS.find(pr => pr.id === id);
    if (p) setZoom({ scale: p.scale, x: p.x, y: p.y });
  }, []);

  // ── Zoom gesture handlers (for overlay element) ────────────────────────
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastDistRef = useRef<number | null>(null);
  const tapStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const onOverlayPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tapStartRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      lastDistRef.current = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      tapStartRef.current = null; // not a tap if two fingers
    }
  }, []);

  const onOverlayPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    e.preventDefault();
    const prev = pointersRef.current.get(e.pointerId)!;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size >= 2) {
      // Pinch zoom
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (lastDistRef.current !== null && lastDistRef.current > 0) {
        const ratio = dist / lastDistRef.current;
        setZoom(prev => ({ ...prev, scale: Math.min(3, Math.max(1, prev.scale * ratio)) }));
      }
      lastDistRef.current = dist;
      tapStartRef.current = null;
    } else if (pointersRef.current.size === 1) {
      // Single-finger drag — cancel tap if moved significantly
      if (tapStartRef.current && Math.hypot(
        e.clientX - tapStartRef.current.x,
        e.clientY - tapStartRef.current.y,
      ) > 8) {
        tapStartRef.current = null;
      }
      setZoom(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    }
  }, []);

  const onOverlayPointerUp = useCallback((e: React.PointerEvent) => {
    // Detect tap → call onTapRef if provided, else toggle play/pause
    if (
      tapStartRef.current !== null &&
      pointersRef.current.size === 1 &&
      Date.now() - tapStartRef.current.t < 250 &&
      Math.hypot(
        e.clientX - tapStartRef.current.x,
        e.clientY - tapStartRef.current.y,
      ) < 8
    ) {
      if (onTapRef?.current) {
        onTapRef.current();
      } else {
        try {
          if (ytPlaying) playerRef.current?.pauseVideo();
          else playerRef.current?.playVideo();
        } catch { /* ignore */ }
      }
    }
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) lastDistRef.current = null;
    tapStartRef.current = null;
  }, [ytPlaying, playerRef, onTapRef]);

  const overlayHandlers = {
    onPointerDown: onOverlayPointerDown,
    onPointerMove: onOverlayPointerMove,
    onPointerUp: onOverlayPointerUp,
    onPointerCancel: onOverlayPointerUp,
  };

  return {
    zoom, setZoom,
    slowRate, setSlowRate, activateSlowRate,
    ytPlaying, setYtPlaying,
    loopStart, loopEnd, isLooping, setIsLooping,
    markLoop, clearLoop,
    stepFrame, togglePlay,
    applyPreset,
    overlayHandlers,
  };
}
