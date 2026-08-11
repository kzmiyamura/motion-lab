import { useRef, useState, useCallback, useEffect, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MocapFigure, type MotionClip } from './MocapFigure';
import styles from './SalsaStage3D.module.css';

// 動画から復元した3Dモーション。server/analysis/prototype_lift3d.py 系のパイプラインが書き出す
// （YOLOのbboxで切り出し → MediaPipe単人検出で world landmarks → 弱透視で位置復元）
const CLIP_URL = '/motion/2fda2815.json';

/**
 * Salsa Stage 3D — 「骨格君」を卒業した 3D キャラで、動画解析のルーティンを再現する試作。
 *
 * B方式（アニメクリップ再生）: 検出イベント(events)で技を選び、技ごとの「手続きアニメ」を
 * ビートに同期して再生する。動きの自然さは骨格データの直流し込みではなくクリップ側が担う。
 * ここでは外部アセット(Mixamo等)を使わず、three のプリミティブで人型リグを手続き生成し、
 * 手続きアニメで動かす（アプリに重い GLB を持ち込まない・オフラインでも動く）。
 *
 * 本番はここを Mixamo/VRM のモーションクリップ + AnimationMixer に差し替えれば質が上がる。
 */

type MoveKind = 'basic' | 'cross-body' | 'inside-turn';
type Role = 'leader' | 'follower';

// 解析イベント(measurements.summary.events 形式)→ 技クリップ
function eventToMove(ev: { type?: string; by?: string }): MoveKind | null {
  if (ev.type === 'CBL') return 'cross-body';
  if (ev.type === 'Turn' && ev.by === 'follower') return 'inside-turn';
  return null;
}

// 2fda2815 の検出イベントを模したサンプル（CBL×フォロワーターン、9秒3回転・28秒ダブル）
const SAMPLE_EVENTS = [
  { t: 3.0, type: 'CBL', by: 'pair' },
  { t: 4.8, type: 'Turn', by: 'follower', rotations: 1 },
  { t: 8.0, type: 'CBL', by: 'pair' },
  { t: 9.0, type: 'Turn', by: 'follower', rotations: 3 },
  { t: 12.5, type: 'CBL', by: 'pair' },
  { t: 14.0, type: 'Turn', by: 'follower', rotations: 1 },
  { t: 19.0, type: 'CBL', by: 'pair' },
  { t: 28.0, type: 'Turn', by: 'follower', rotations: 2 },
];

const BEATS_PER_MOVE = 8; // 1技 = 1エイトカウント

// 全フレームで共有する再生ヘッド（React state を経由せず ref で回す）
type Playhead = {
  playing: boolean;
  bpm: number;
  beat: number;
  cycle: number;
  // random/replay = 手続きアニメ（技を選んで踊る） / mocap = 動画から復元した実モーションの再生
  mode: 'random' | 'replay' | 'mocap';
  current: MoveKind;
  rotations: number;
  moveStartBeat: number;
  queue: { move: MoveKind; rotations: number }[];
  onMove: (m: MoveKind, rotations: number) => void;
  // mocap 用: クリップ内の再生位置[秒]
  clipTime: number;
  clipDuration: number;
  onClipTime: (t: number) => void;
};

const damp = (cur: number, target: number, k: number) => cur + (target - cur) * k;

/** 手続き人型リグ。関節を group 階層で作り、useFrame で回転を与える */
function Dancer({ role, color, phRef }: { role: Role; color: string; phRef: RefObject<Playhead> }) {
  const root = useRef<THREE.Group>(null!);
  const hips = useRef<THREE.Group>(null!);
  const spine = useRef<THREE.Group>(null!);
  const thighL = useRef<THREE.Group>(null!);
  const thighR = useRef<THREE.Group>(null!);
  const shldrL = useRef<THREE.Group>(null!);
  const shldrR = useRef<THREE.Group>(null!);

  const baseX = role === 'leader' ? -0.62 : 0.62;
  const mirror = role === 'follower' ? -1 : 1;

  useFrame((_, delta) => {
    const ph = phRef.current;
    if (!root.current) return;
    const beat = ph.beat;
    const local = beat - Math.floor(beat);
    const dip = (1 - Math.cos(local * Math.PI * 2)) / 2; // 0(オン)→1(裏)
    const moveBeat = beat - ph.moveStartBeat;
    const prog = Math.min(1, Math.max(0, moveBeat / BEATS_PER_MOVE));

    // ── 体重移動（8カウントで左右一往復）＋ 拍ごとの沈み込み
    let x = baseX + Math.sin((beat / 8) * Math.PI * 2) * 0.06 * mirror;
    let z = 0;
    let yaw = 0;
    const y = 0.02 - dip * 0.05;

    // ── 技クリップ
    let rArmUp = 0;
    if (ph.current === 'inside-turn' && role === 'follower') {
      yaw = prog * Math.PI * 2 * (ph.rotations || 1); // その場で回転
      rArmUp = Math.sin(prog * Math.PI) * 0.9;         // つないだ手を上げる
    } else if (ph.current === 'inside-turn' && role === 'leader') {
      rArmUp = Math.sin(prog * Math.PI) * 1.1;         // リーダーは手を上げてリード
    } else if (ph.current === 'cross-body') {
      const arc = Math.sin(prog * Math.PI);
      if (role === 'follower') { z = -arc * 0.5; x += arc * 0.15; } // 前に抜けて通過
      else { x -= arc * 0.28; rArmUp = arc * 0.5; }                  // 道を空ける
    }

    root.current.position.x = damp(root.current.position.x, x, 0.18);
    root.current.position.y = damp(root.current.position.y, y, 0.3);
    root.current.position.z = damp(root.current.position.z, z, 0.18);
    root.current.rotation.y = ph.current === 'inside-turn' ? yaw : damp(root.current.rotation.y, yaw, 0.15);

    // ── 脚: 拍ごとに接地脚が交替（その場ステップ）
    const stepPhase = Math.sin(beat * Math.PI) * mirror;
    thighL.current.rotation.x = damp(thighL.current.rotation.x, 0.35 * stepPhase, 0.25);
    thighR.current.rotation.x = damp(thighR.current.rotation.x, -0.35 * stepPhase, 0.25);

    // ── 上体のわずかな縦揺れ
    spine.current.position.y = damp(spine.current.position.y, 0.9 - dip * 0.02, 0.3);

    // ── 腕: 基本は前方フレーム、技で右手を上げる
    shldrL.current.rotation.x = damp(shldrL.current.rotation.x, -1.15 + dip * 0.06, 0.2);
    shldrR.current.rotation.x = damp(shldrR.current.rotation.x, -1.15 - rArmUp, 0.2);

    void delta;
  });

  const limbMat = <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />;
  const skinMat = <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />;

  return (
    <group ref={root} position={[baseX, 0, 0]}>
      {/* 影がわりのソフトな円 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <circleGeometry args={[0.34, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} />
      </mesh>

      {/* 脚（付け根 group を回すと脚が振れる。カプセルは下向きにぶら下げる） */}
      <group ref={thighL} position={[-0.11, 0.9, 0]}>
        <mesh position={[0, -0.42, 0]} castShadow>
          <capsuleGeometry args={[0.075, 0.72, 6, 12]} />
          {limbMat}
        </mesh>
      </group>
      <group ref={thighR} position={[0.11, 0.9, 0]}>
        <mesh position={[0, -0.42, 0]} castShadow>
          <capsuleGeometry args={[0.075, 0.72, 6, 12]} />
          {limbMat}
        </mesh>
      </group>

      {/* 骨盤 */}
      <group ref={hips} position={[0, 0.9, 0]}>
        <mesh>
          <capsuleGeometry args={[0.14, 0.1, 6, 12]} />
          {skinMat}
        </mesh>
      </group>

      {/* 胴 + 頭（spine を肩の高さに） */}
      <group ref={spine} position={[0, 0.9, 0]}>
        <mesh position={[0, 0.22, 0]}>
          <capsuleGeometry args={[0.13, 0.34, 6, 12]} />
          {skinMat}
        </mesh>
        <mesh position={[0, 0.62, 0]}>
          <sphereGeometry args={[0.13, 20, 16]} />
          {skinMat}
        </mesh>

        {/* 腕（肩 group を回すと腕が振れる） */}
        <group ref={shldrL} position={[-0.2, 0.42, 0]}>
          <mesh position={[0, -0.26, 0]}>
            <capsuleGeometry args={[0.055, 0.46, 6, 10]} />
            {limbMat}
          </mesh>
        </group>
        <group ref={shldrR} position={[0.2, 0.42, 0]}>
          <mesh position={[0, -0.26, 0]}>
            <capsuleGeometry args={[0.055, 0.46, 6, 10]} />
            {limbMat}
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** 振付コントローラ: 拍を進め、エイトカウントの頭で次の技へ */
function Choreographer({ phRef }: { phRef: RefObject<Playhead> }) {
  useFrame((_, delta) => {
    const ph = phRef.current;
    if (!ph.playing) return;

    // mocap は実時間で流すだけ（拍で技を送る必要がない。動きは全部クリップに入っている）
    if (ph.mode === 'mocap') {
      ph.clipTime += delta;
      if (ph.clipDuration > 0 && ph.clipTime > ph.clipDuration) ph.clipTime = 0;
      ph.onClipTime(ph.clipTime);
      return;
    }

    ph.beat += delta * (ph.bpm / 60);
    const cyc = Math.floor(ph.beat / BEATS_PER_MOVE);
    if (cyc !== ph.cycle) {
      ph.cycle = cyc;
      let next: MoveKind = 'basic';
      let rot = 1;
      if (ph.mode === 'replay') {
        const item = ph.queue.shift();
        if (item) { next = item.move; rot = item.rotations; }
        else { ph.playing = false; }
      } else {
        const pool: MoveKind[] = ['basic', 'cross-body', 'inside-turn'];
        next = pool[Math.floor(Math.random() * pool.length)];
        rot = next === 'inside-turn' ? 1 + Math.floor(Math.random() * 2) : 1;
      }
      ph.current = next;
      ph.rotations = rot;
      ph.moveStartBeat = cyc * BEATS_PER_MOVE;
      ph.onMove(next, rot);
    }
  });
  return null;
}

/**
 * 軌道カメラ。3D復元の値打ちは「元の動画に無いアングルから見られる」ことなので、
 * 回り込みを触れるようにしておく（azRef を上のドラッグ操作と共有する）。
 */
function CameraRig({ azRef, autoRef }: { azRef: RefObject<number>; autoRef: RefObject<boolean> }) {
  const cam = useThree((s) => s.camera);
  useFrame((_, delta) => {
    if (autoRef.current) azRef.current += delta * 0.22;
    const r = 4.3, az = azRef.current;
    cam.position.set(Math.sin(az) * r, 1.5, Math.cos(az) * r);
    cam.lookAt(0, 0.95, 0);
  });
  return null;
}

const MOVE_LABEL: Record<MoveKind, string> = {
  'basic': 'ベーシック',
  'cross-body': 'クロスボディリード',
  'inside-turn': 'インサイドターン',
};

export function SalsaStage3D() {
  const phRef = useRef<Playhead>({
    playing: false, bpm: 170, beat: 0, cycle: -1, mode: 'random',
    current: 'basic', rotations: 1, moveStartBeat: 0, queue: [],
    onMove: () => {},
    clipTime: 0, clipDuration: 0, onClipTime: () => {},
  });
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpm] = useState(170);
  const [nowLabel, setNowLabel] = useState('—');
  const [clip, setClip] = useState<MotionClip | null>(null);
  const [clipErr, setClipErr] = useState<string | null>(null);
  const [isMocap, setIsMocap] = useState(false);
  const [clipT, setClipT] = useState(0);
  const clipTimeRef = useRef(0);
  const azRef = useRef(0);
  const autoOrbitRef = useRef(false);
  const [autoOrbit, setAutoOrbit] = useState(false);

  phRef.current.onMove = useCallback((m: MoveKind, rot: number) => {
    setNowLabel(MOVE_LABEL[m] + (rot >= 2 ? ` ×${rot}` : ''));
  }, []);

  // クリップ時刻は毎フレーム更新されるので ref に直接書き、React state は表示用に間引く
  phRef.current.onClipTime = useCallback((t: number) => {
    clipTimeRef.current = t;
    setClipT((prev) => (Math.abs(prev - t) > 0.1 ? t : prev));
  }, []);

  // 再生中の技ラベル: クリップの events から直近のものを拾う
  useEffect(() => {
    if (!isMocap || !clip) return;
    const ev = [...clip.events].filter((e) => e.t <= clipT + 0.01).pop();
    if (!ev || clipT - ev.t > 2.2) { setNowLabel('—'); return; }
    const name = ev.type === 'CBL' ? 'クロスボディリード'
      : ev.type === 'Turn' ? `ターン（${ev.by === 'follower' ? 'フォロワー' : 'リーダー'}）`
      : ev.type;
    setNowLabel(name + (ev.rotations && ev.rotations >= 2 ? ` ×${ev.rotations}` : ''));
  }, [isMocap, clip, clipT]);

  const loadClip = async () => {
    setClipErr(null);
    try {
      let c = clip;
      if (!c) {
        const res = await fetch(CLIP_URL);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        c = (await res.json()) as MotionClip;
        setClip(c);
      }
      const ph = phRef.current;
      ph.mode = 'mocap';
      ph.clipTime = 0;
      ph.clipDuration = c.duration;
      ph.playing = true;
      clipTimeRef.current = 0;
      setIsMocap(true);
      setPlaying(true);
      setNowLabel('—');
    } catch (e) {
      setClipErr(e instanceof Error ? e.message : String(e));
    }
  };

  // ステージのドラッグで回り込む
  const dragRef = useRef<number | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current === null) return;
    azRef.current += (e.clientX - dragRef.current) * 0.008;
    dragRef.current = e.clientX;
  };
  const onPointerUp = () => { dragRef.current = null; };

  const start = (mode: 'random' | 'replay', queue: { move: MoveKind; rotations: number }[]) => {
    const ph = phRef.current;
    ph.mode = mode; ph.queue = queue; ph.beat = 0; ph.cycle = -1;
    ph.current = 'basic'; ph.rotations = 1; ph.moveStartBeat = 0;
    ph.playing = true; setPlaying(true); setIsMocap(false);
    setNowLabel(mode === 'replay' ? '再現の準備…' : 'ベーシック');
  };
  const toggle = () => {
    const ph = phRef.current;
    ph.playing = !ph.playing; setPlaying(ph.playing);
    if (ph.playing && ph.mode !== 'mocap' && ph.cycle === -1) { ph.mode = 'random'; }
  };
  const replaySample = () => {
    const q = SAMPLE_EVENTS
      .map(e => ({ move: eventToMove(e), rotations: (e as { rotations?: number }).rotations ?? 1 }))
      .filter((x): x is { move: MoveKind; rotations: number } => x.move !== null);
    start('replay', q);
  };
  const onBpm = (v: number) => { setBpm(v); phRef.current.bpm = v; };

  return (
    <div className={styles.wrap}>
      <div
        className={styles.stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Canvas shadows camera={{ position: [0, 1.5, 4.3], fov: 42 }} dpr={[1, 2]}>
          <color attach="background" args={['#0a0e18']} />
          <fog attach="fog" args={['#0a0e18', 5, 11]} />
          <ambientLight intensity={0.55} />
          <directionalLight position={[3, 6, 4]} intensity={1.15} />
          <directionalLight position={[-4, 3, -2]} intensity={0.35} color="#4d7cff" />
          {/* 床 */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
            <circleGeometry args={[6, 48]} />
            <meshStandardMaterial color="#11172a" roughness={0.9} />
          </mesh>
          {isMocap && clip ? (
            <>
              <MocapFigure clip={clip} pid={clip.leaderPid} color="#3d8bff" timeRef={clipTimeRef} />
              <MocapFigure clip={clip} pid={1 - clip.leaderPid} color="#ff4db8" timeRef={clipTimeRef} />
            </>
          ) : (
            <>
              <Dancer role="leader" color="#3d8bff" phRef={phRef} />
              <Dancer role="follower" color="#ff4db8" phRef={phRef} />
            </>
          )}
          <Choreographer phRef={phRef} />
          <CameraRig azRef={azRef} autoRef={autoOrbitRef} />
        </Canvas>

        <div className={styles.overlay}>
          <span className={styles.badge}><i className={styles.dotL} />リーダー</span>
          <span className={styles.badge}><i className={styles.dotF} />フォロワー</span>
          <span className={styles.now}>{nowLabel}</span>
          {isMocap && (
            <span className={styles.badge}>
              動画のモーション {clipT.toFixed(1)}s / {clip?.duration.toFixed(1)}s
            </span>
          )}
        </div>
      </div>

      <div className={styles.bar}>
        <button className={`${styles.btn} ${styles.primary}`} onClick={toggle}>
          {playing ? '⏸ 停止' : '▶ 再生'}
        </button>
        <button className={styles.btn} onClick={replaySample}>📼 解析サンプルを再現</button>
        <button className={`${styles.btn} ${isMocap ? styles.primary : ''}`} onClick={loadClip}>
          🎥 動画のモーションで踊る
        </button>
        <button
          className={`${styles.btn} ${autoOrbit ? styles.primary : ''}`}
          onClick={() => { const v = !autoOrbit; setAutoOrbit(v); autoOrbitRef.current = v; }}
        >
          🔄 回り込み
        </button>
        <label className={styles.tempo}>
          BPM <input type="range" min={130} max={200} value={bpm} onChange={e => onBpm(Number(e.target.value))} />
          <b>{bpm}</b>
        </label>
      </div>

      {clipErr && <p className={styles.note}>モーションの読み込みに失敗しました: {clipErr}</p>}

      <p className={styles.note}>
        <b>🎥 動画のモーションで踊る</b> は、動画から復元した<b>関節の3D位置そのもの</b>を再生します
        （YOLOのbboxで1人ずつ切り出し → MediaPipe の world landmarks → 弱透視で2人を空間に配置）。
        薄く描かれているボーンは、隠れて観測できず時間補間で埋めた推定です。
        ステージは<b>ドラッグで回り込め</b>ます — 元の動画に無いアングルから見られるのが3D復元の値打ちです。
        ▶ 再生 / 📼 は従来どおり、技イベントだけ動画由来の手続きアニメ（B方式）です。
      </p>
    </div>
  );
}

export default SalsaStage3D;
