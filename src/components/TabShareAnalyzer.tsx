import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { usePoseEstimation, type VizMode, type PoseEstimationOptions } from '../hooks/usePoseEstimation';
import {
  makeYouTubeClock, buildTabShareExport, tabShareFileName, type YtPlayerLike,
} from '../engine/tabShare';
import { SequenceView } from './SequenceView';
import styles from './TabShareAnalyzer.module.css';

interface Props {
  bpm: number;
  videoId: string;
  /** YouTube IFrame API の YT.Player（onReady の e.target） */
  playerRef: RefObject<YtPlayerLike | null>;
  /** 切り出し対象の YouTube iframe を返す（見つからなければ null） */
  getIframe: () => HTMLIFrameElement | null;
  /** 時刻源を差し替える（既定は YouTube 用の makeYouTubeClock）。参照が変わると解析が作り直されるので useMemo すること */
  clock?: () => number;
  /** 表示用の配信元名（既定 YouTube） */
  sourceLabel?: string;
  /** JSON の videoId（既定は videoId） */
  exportVideoId?: string;
  /** 書き出しファイル名に使う部分（既定は videoId） */
  fileLabel?: string;
}

const VIZ_OPTIONS: Array<{ mode: Exclude<VizMode, 'off'>; label: string }> = [
  { mode: 'full', label: '全身' },
  { mode: 'salsa', label: '中心軸' },
  { mode: 'trail', label: '足跡' },
];

const UNSUPPORTED_TEXT =
  'このブラウザは画面共有（getDisplayMedia）に対応していないため骨格解析できません（iPhone / iPad の Safari など）。PC の Chrome / Edge で開いてください。';

/** 画面共有（getDisplayMedia）が使える環境か。iOS Safari などには無い */
export function canShareTab(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

type CropTargetStatic = { fromElement(el: Element): Promise<unknown> };
type CroppableTrack = MediaStreamTrack & { cropTo?: (target: unknown) => Promise<void> };

/** Region Capture（CropTarget）が使えるなら iframe 部分だけに切り出す。成功したら true */
async function cropToElement(track: MediaStreamTrack, el: Element | null): Promise<boolean> {
  const CropTarget = (window as unknown as { CropTarget?: CropTargetStatic }).CropTarget;
  const t = track as CroppableTrack;
  if (!CropTarget || typeof t.cropTo !== 'function' || !el) return false;
  try {
    const target = await CropTarget.fromElement(el);
    await t.cropTo(target);
    return true;
  } catch (e) {
    // 別のタブ・ウィンドウを選んだときなどは失敗する → タブ全体で続行
    console.warn('[TabShare] cropTo failed', e);
    return false;
  }
}

/**
 * YouTube 骨格解析 — アプリ自身のタブを画面共有（getDisplayMedia）で受け取り、
 * YouTube プレイヤー部分を切り出して既存の骨格推定パイプラインに流す。
 * 動画はダウンロードも保存もしない（共有中の映像をブラウザ内で読むだけ）。
 * イベントの時刻は共有映像の currentTime ではなく YouTube の再生位置（スロー・ループでも正しい）。
 */
export function TabShareAnalyzer({
  bpm, videoId, playerRef, getIframe, clock: clockProp, sourceLabel = 'YouTube', exportVideoId, fileLabel,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [cropped, setCropped] = useState(false);
  const [vizMode, setVizMode] = useState<Exclude<VizMode, 'off'>>('full');
  const [error, setError] = useState<string | null>(null);
  const [ytTime, setYtTime] = useState(0);
  const [ytDuration, setYtDuration] = useState(0);
  const supported = canShareTab();

  // YouTube の再生位置を読む時計（getCurrentTime の間欠更新を補間）
  const ytClock = useMemo(() => makeYouTubeClock(() => playerRef.current), [playerRef]);
  const clock = clockProp ?? ytClock;
  const poseOptions = useMemo<PoseEstimationOptions>(
    () => ({ getTime: clock, disableTimeCache: true }),
    [clock],
  );

  const { sequence, clearSequence, swapRoles, roleDetected, syncError } = usePoseEstimation(
    videoRef, canvasRef, sharing ? vizMode : 'off', bpm,
    false, 'on1', false, undefined, null, null, 'v2',
    poseOptions,
  );

  const stop = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((t) => {
      t.removeEventListener('ended', stopRef.current);
      t.stop();
    });
    const v = videoRef.current;
    if (v) { v.pause(); v.srcObject = null; }
    setSharing(false);
    setCropped(false);
  }, []);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = useCallback(async () => {
    if (!canShareTab()) return;
    setError(null);
    try {
      // preferCurrentTab: Chrome で「このタブを共有」の簡易ダイアログを出す（型定義に無いのでキャスト）
      const opts = {
        video: true,
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
      } as DisplayMediaStreamOptions;
      const stream = await navigator.mediaDevices.getDisplayMedia(opts);
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) { stop(); return; }
      // ブラウザの「共有を停止」やタブを閉じたときは track が ended になる
      track.addEventListener('ended', stopRef.current);

      setCropped(await cropToElement(track, getIframe()));

      const v = videoRef.current;
      if (!v || streamRef.current !== stream) { stop(); return; }
      v.srcObject = stream;
      v.muted = true;
      await v.play();
      clearSequence();
      setSharing(true);
    } catch (e) {
      // ユーザーが選択画面でキャンセルしたときは NotAllowedError
      const name = e instanceof DOMException ? e.name : '';
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setError(`画面共有を開始できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
      stop();
    }
  }, [stop, clearSequence, getIframe]);

  // 動画を切り替えた・プレイヤーを閉じたときは共有を止める
  useEffect(() => () => stopRef.current(), [videoId]);

  // SequenceView 用の YouTube 再生位置・長さ（ライブ配信は duration が当てにならないので最大値で代用）
  useEffect(() => {
    if (!sharing) return;
    const id = window.setInterval(() => {
      const t = clock();
      if (!Number.isFinite(t)) return;
      setYtTime(t);
      let dur = 0;
      try { dur = playerRef.current?.getDuration?.() ?? 0; } catch { /* ignore */ }
      setYtDuration((prev) => Math.max(prev, Number.isFinite(dur) ? dur : 0, t));
    }, 500);
    return () => window.clearInterval(id);
  }, [sharing, clock, playerRef]);

  const handleSeek = useCallback((t: number) => {
    try { playerRef.current?.seekTo?.(t, true); } catch { /* ignore */ }
  }, [playerRef]);

  const handleExport = useCallback(() => {
    const p = playerRef.current;
    let title: string | undefined;
    let playbackRate = 1;
    try { title = p?.getVideoData?.()?.title || undefined; } catch { /* ignore */ }
    try { playbackRate = p?.getPlaybackRate?.() ?? 1; } catch { /* ignore */ }
    const now = new Date();
    const data = buildTabShareExport({ videoId: exportVideoId ?? videoId, title, playbackRate, createdAt: now, events: sequence });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = tabShareFileName(fileLabel ?? videoId, now);
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [playerRef, videoId, exportVideoId, fileLabel, sequence]);

  // タブ全体を共有しているときは、プレビューを出すと共有映像に映り込んで（合わせ鏡）誤検出するので隠す
  const showPreview = sharing && cropped;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h3 className={styles.title}>🦴 骨格解析</h3>
        <div className={styles.headerBtns}>
          {!sharing ? (
            <button
              className={styles.primaryBtn}
              onClick={() => void start()}
              disabled={!supported}
              title={supported ? `このタブを画面共有して ${sourceLabel} の映像を骨格解析します（ダウンロードしません）` : UNSUPPORTED_TEXT}
            >骨格解析</button>
          ) : (
            <button className={styles.stopBtn} onClick={stop}>停止</button>
          )}
          <button
            className={styles.segBtn}
            onClick={handleExport}
            disabled={sequence.length === 0}
            title={`検出した技を ${sourceLabel} の再生位置つきで JSON に書き出します`}
          >JSON書き出し</button>
        </div>
      </div>

      {!supported && <p className={styles.note}>{UNSUPPORTED_TEXT}</p>}
      {supported && !sharing && (
        <p className={styles.note}>
          「骨格解析」を押すとブラウザの共有ダイアログが出るので、<strong>このタブ</strong>を共有してください。
          {sourceLabel} の映像は保存しません。スロー再生・ループ中も時刻は {sourceLabel} の再生位置で記録します。
        </p>
      )}
      {sharing && !cropped && (
        <p className={styles.note}>
          この環境ではプレイヤー部分だけの切り出し（Region Capture）が使えないため、タブ全体を解析しています。
          骨格の重ね表示は映り込み防止のためオフです（検出した技は下のシーケンスに記録されます）。
          PC 版 Chrome / Edge で「このタブ」を共有すると切り出しが有効になります。
        </p>
      )}
      {error && <p className={styles.error}>{error}</p>}

      <div className={showPreview ? styles.stage : styles.stageHidden} aria-hidden={!showPreview}>
        <video ref={videoRef} className={styles.video} muted playsInline />
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>

      {sharing && (
        <div className={styles.controls}>
          {VIZ_OPTIONS.map((o) => (
            <button
              key={o.mode}
              className={`${styles.segBtn} ${vizMode === o.mode ? styles.segBtnActive : ''}`}
              onClick={() => setVizMode(o.mode)}
            >{o.label}</button>
          ))}
          <button className={styles.segBtn} onClick={swapRoles} disabled={!roleDetected}>⇄ 男女入替</button>
          {syncError && <span className={styles.warn}>動きの向きが揃っていない</span>}
        </div>
      )}

      {(sharing || sequence.length > 0) && (
        <SequenceView
          events={sequence}
          duration={ytDuration}
          currentTime={ytTime}
          onClear={clearSequence}
          onSeek={handleSeek}
          isAnalyzing={sharing}
        />
      )}
    </div>
  );
}
