import { useEffect, useRef, useState } from 'react';
import { countAt } from '../engine/choreoSheet';
import styles from './MoveClipPlayer.module.css';

type Props = {
  /** 元動画（HLS の playlist.m3u8 か mp4） */
  src: string;
  start: number;
  end: number;
  /** 1拍の秒数。分かればカウント（1〜8）を重ねる */
  beatSec: number | null;
  label: string;
  onClose: () => void;
};

const RATE = 0.5;

/**
 * 振付シートのカードを押したときの「見て覚える」プレイヤー。
 * 技の区間 [start, end) だけを 0.5 倍で繰り返し、今が何カウント目かを大きく出す。
 * 音は要らない（スローで音程が崩れる・画面収録は無音）ので消音にし、自動再生を確実にする
 */
export function MoveClipPlayer({ src, start, end, beatSec, label, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // ソースの読み込み（Safari は HLS をそのまま再生、それ以外は hls.js を遅延読み込み）
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let destroyed = false;
    let hls: { destroy: () => void } | null = null;
    const isHls = /\.m3u8(\?|$)/.test(src);
    if (!isHls || video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) { setFailed(true); return; }
        const h = new Hls();
        hls = h;
        h.loadSource(src);
        h.attachMedia(video);
      }).catch(() => setFailed(true));
    }
    return () => {
      destroyed = true;
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  // 区間の頭へ飛んで 0.5 倍で再生
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const go = () => {
      video.playbackRate = RATE;
      video.currentTime = start;
      void video.play().catch(() => { /* 自動再生が止められたらコントロールで再生してもらう */ });
    };
    if (video.readyState >= 1) go();
    else video.addEventListener('loadedmetadata', go, { once: true });
    return () => video.removeEventListener('loadedmetadata', go);
  }, [src, start]);

  // 区間の終わりで頭へ戻す + カウント表示（rAF で滑らかに）
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const tick = () => {
      const t = video.currentTime;
      if (t >= end - 0.02 || t < start - 0.3) {
        video.currentTime = start;
      }
      if (video.playbackRate !== RATE) video.playbackRate = RATE;
      setCount(beatSec ? countAt(Math.max(t, start), start, beatSec) : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, end, beatSec]);

  return (
    <div className={styles.player}>
      <div className={styles.bar}>
        <span className={styles.label}>{label}</span>
        <span className={styles.rate}>0.5×</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="再生を閉じる">✕</button>
      </div>
      <div className={styles.stage}>
        <video ref={videoRef} className={styles.video} muted playsInline controls={false} preload="auto" />
        {count !== null && (
          <div className={styles.count} aria-live="off">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className={i + 1 === count ? styles.on : (i === 0 || i === 4) ? styles.accent : undefined}>
                {i + 1}
              </span>
            ))}
          </div>
        )}
        {failed && <p className={styles.err}>この端末では動画を再生できません</p>}
      </div>
    </div>
  );
}
