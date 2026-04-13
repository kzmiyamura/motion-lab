import { useState, useCallback, useRef, useEffect } from 'react';
import type { YouTubePlayer } from 'react-youtube';

// ── Types ──────────────────────────────────────────────────────────────────
export type SlowRate = 0.1 | 0.25 | 0.5 | 0.75 | 0.8 | 0.9 | 1.0 | 1.1 | 1.2 | 1.25 | 1.5 | 1.75 | 2.0;
export const SLOW_RATES: SlowRate[] = [0.1, 0.25, 0.5, 0.75, 0.8, 0.9, 1.0, 1.1, 1.2, 1.25, 1.5, 1.75, 2.0];

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

// ── Step size based on playback rate ──────────────────────────────────────
export function getStepSize(slowRate: number): number {
  if (slowRate <= 0.25) return 0.033;  // 1 frame — detailed analysis
  if (slowRate <= 0.75) return 0.2;    // ~6 frames
  if (slowRate <= 1.25) return 1.0;    // 1 second
  return 3.0;                          // 3 seconds
}

function getZone(clientX: number, rect: DOMRect): 'left' | 'right' | 'center' {
  const x = clientX - rect.left;
  if (x < rect.width * 0.25) return 'left';
  if (x > rect.width * 0.75) return 'right';
  return 'center';
}

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

  // Cleanup double-tap hold interval on unmount
  useEffect(() => {
    return () => {
      if (doubleTapHoldRef.current) clearInterval(doubleTapHoldRef.current);
    };
  }, []);

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
      playerRef.current?.seekTo(Math.max(0, t + direction * getStepSize(slowRate)), true);
    } catch { /* ignore */ }
  }, [playerRef, slowRate]);

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
  const lastTapUpTimeRef = useRef<number>(0);
  const lastTapZoneRef = useRef<'left' | 'right' | 'center' | null>(null);
  const doubleTapHoldRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const onOverlayPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tapStartRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      lastDistRef.current = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      tapStartRef.current = null; // not a tap if two fingers
      return;
    }
    // Double-tap-hold detection (single finger, left/right zone)
    if (pointersRef.current.size === 1) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const zone = getZone(e.clientX, rect);
      const now = Date.now();
      if (zone !== 'center' && now - lastTapUpTimeRef.current < 400 && lastTapZoneRef.current === zone) {
        const dir: 1 | -1 = zone === 'left' ? -1 : 1;
        stepFrame(dir);
        doubleTapHoldRef.current = setInterval(() => stepFrame(dir), 120);
        tapStartRef.current = null; // prevent tap action on pointer up
      }
    }
  }, [stepFrame]);

  const onOverlayPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    e.preventDefault();
    if (doubleTapHoldRef.current) {
      // during hold, update position to avoid stale jump on release
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
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
    // Stop double-tap hold
    if (doubleTapHoldRef.current) {
      clearInterval(doubleTapHoldRef.current);
      doubleTapHoldRef.current = null;
      lastTapUpTimeRef.current = 0; // reset to prevent triple-tap
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) lastDistRef.current = null;
      tapStartRef.current = null;
      return;
    }
    // Record tap up for double-tap detection
    if (pointersRef.current.size === 1) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      lastTapZoneRef.current = getZone(e.clientX, rect);
      lastTapUpTimeRef.current = Date.now();
    }
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
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const zone = getZone(e.clientX, rect);
      // left/right zone when paused → reserved for double-tap, skip single-tap action
      if (zone === 'center' || ytPlaying) {
        if (onTapRef?.current) {
          onTapRef.current();
        } else {
          try {
            if (ytPlaying) playerRef.current?.pauseVideo();
            else playerRef.current?.playVideo();
          } catch { /* ignore */ }
        }
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
