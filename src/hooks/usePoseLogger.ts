import { useRef, useState, useCallback } from 'react';
import type { RawLandmark, RawPoseFrame, RawPoseLog } from '../types/pose';

const SAMPLING_MS = 100; // 10fps サンプリング

export interface UsePoseLoggerResult {
  isRecording: boolean;
  frameCount: number;
  startRecording: () => void;
  stopRecording: () => void;
  exportJson: (videoName: string) => void;
  /** 記録済みデータを RawPoseLog として返す（navigate 用） */
  getLog: (videoName: string) => RawPoseLog | null;
  /** usePoseEstimation の onRawPoses に渡すコールバック */
  onRawPoses: (poses: Array<{ landmarks: RawLandmark[] }>, videoTime: number) => void;
}

export function usePoseLogger(): UsePoseLoggerResult {
  const [isRecording, setIsRecording] = useState(false);
  const [frameCount, setFrameCount] = useState(0);

  const recordingRef   = useRef(false);
  const framesRef      = useRef<RawPoseFrame[]>([]);
  const lastSampleRef  = useRef(-Infinity);
  const frameIdxRef    = useRef(0);

  const startRecording = useCallback(() => {
    framesRef.current    = [];
    lastSampleRef.current = -Infinity;
    frameIdxRef.current  = 0;
    recordingRef.current = true;
    setIsRecording(true);
    setFrameCount(0);
  }, []);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setIsRecording(false);
  }, []);

  const getLog = useCallback((videoName: string): RawPoseLog | null => {
    if (framesRef.current.length === 0) return null;
    return {
      version: 'salsa_raw_v2',
      datetime: new Date().toISOString(),
      videoName,
      samplingMs: SAMPLING_MS,
      frames: framesRef.current,
    };
  }, []);

  const exportJson = useCallback((videoName: string) => {
    const log = getLog(videoName);
    if (!log) return;
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href     = url;
    a.download = `salsa_raw_v2_${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const onRawPoses = useCallback((
    poses: Array<{ landmarks: RawLandmark[] }>,
    videoTime: number,
  ) => {
    if (!recordingRef.current) return;
    const now = performance.now();
    if (now - lastSampleRef.current < SAMPLING_MS) return;
    lastSampleRef.current = now;

    const frame: RawPoseFrame = {
      t: Math.round(videoTime * 1000) / 1000, // ms 精度で切り捨て
      frameIdx: frameIdxRef.current++,
      poses,
    };
    framesRef.current.push(frame);
    setFrameCount(framesRef.current.length);
  }, []);

  return { isRecording, frameCount, startRecording, stopRecording, exportJson, getLog, onRawPoses };
}
