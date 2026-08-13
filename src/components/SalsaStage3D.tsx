import { useRef, useState, useCallback, useEffect, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MocapFigure, type MotionClip } from './MocapFigure';
import { CoupleFigure } from './CoupleFigure';
import { detectFace, loadFaces, saveFaces, EMPTY_FACES, type FaceSlots } from '../engine/faceAvatar';
import { SAMPLE_AVATARS } from './AvatarHeads';
import styles from './SalsaStage3D.module.css';

// 動画から復元した3Dモーション。server/analysis/prototype_lift3d.py 系のパイプラインが書き出す
// （YOLOのbboxで切り出し → MediaPipe単人検出で world landmarks → 弱透視で位置復元）。
// クリップは個人の練習動画由来のため、リポジトリの public/ には置かず
// ThinkCentre サーバー（relay 経由の固定URL）の /api/motion から配信する
const HOME_SERVER_URL = (import.meta.env.VITE_HOME_SERVER_URL ?? '') as string;

type ClipInfo = { id: string; label: string | null; duration: number };

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
  // random/replay = 手続きアニメ（技を選んで踊る） / mocap = 実モーションの直再生
  // hybrid = 実データの動線・向き・拍 × 手続きアニメの手足（HybridFigure）
  mode: 'random' | 'replay' | 'mocap' | 'hybrid';
  current: MoveKind;
  rotations: number;
  moveStartBeat: number;
  queue: { move: MoveKind; rotations: number }[];
  onMove: (m: MoveKind, rotations: number) => void;
  // mocap 用: クリップ内の再生位置[秒]
  clipTime: number;
  clipDuration: number;
  clipSpeed: number;   // スロー再生（1 = 等速）
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

    // mocap / hybrid はクリップ時刻を実時間で流すだけ（拍で技を送る必要がない）
    if (ph.mode === 'mocap' || ph.mode === 'hybrid') {
      ph.clipTime += delta * ph.clipSpeed;
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

/** 自由視点カメラの状態。注視点まわりの球座標（方位角・仰角・距離） */
export type View = { az: number; el: number; dist: number };
export const VIEW_PRESETS: Record<string, View> = {
  正面: { az: 0, el: 0.13, dist: 4.3 },
  斜め: { az: 0.85, el: 0.35, dist: 4.3 },
  真横: { az: Math.PI / 2, el: 0.1, dist: 4.0 },
  真上: { az: 0, el: 1.35, dist: 4.6 },
  背面: { az: Math.PI, el: 0.13, dist: 4.3 },
};
const TARGET = new THREE.Vector3(0, 0.95, 0);
export const EL_MIN = -0.2, EL_MAX = 1.45, DIST_MIN = 1.8, DIST_MAX = 9;

/**
 * 自由視点カメラ。3D復元の値打ちは「元の動画に無いアングルから見られる」ことなので、
 * 方位角・仰角・距離を全部触れるようにする。目標値へ減衰追従させて、
 * プリセット切り替えやドラッグが飛ばずに繋がるようにしている。
 */
function CameraRig({
  viewRef, autoRef,
}: {
  viewRef: RefObject<View>;
  autoRef: RefObject<boolean>;
}) {
  const cam = useThree((s) => s.camera);
  const cur = useRef<View>({ ...VIEW_PRESETS.正面 });
  useFrame((_, delta) => {
    const want = viewRef.current;
    if (autoRef.current) want.az += delta * 0.22;
    const k = Math.min(1, delta * 9);
    // 方位角は最短方向に回す（0 と 2π をまたぐときに大回りしない）
    let dAz = want.az - cur.current.az;
    while (dAz > Math.PI) dAz -= Math.PI * 2;
    while (dAz < -Math.PI) dAz += Math.PI * 2;
    cur.current.az += dAz * k;
    cur.current.el += (want.el - cur.current.el) * k;
    cur.current.dist += (want.dist - cur.current.dist) * k;

    const { az, el, dist } = cur.current;
    const ce = Math.cos(el);
    cam.position.set(
      TARGET.x + Math.sin(az) * ce * dist,
      TARGET.y + Math.sin(el) * dist,
      TARGET.z + Math.cos(az) * ce * dist,
    );
    cam.lookAt(TARGET);
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
    clipTime: 0, clipDuration: 0, clipSpeed: 1, onClipTime: () => {},
  });
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpm] = useState(170);
  const [nowLabel, setNowLabel] = useState('—');
  const [clip, setClip] = useState<MotionClip | null>(null);
  const [clipErr, setClipErr] = useState<string | null>(null);
  // 押してからクリップ本体が届くまで数秒かかる。無反応に見えないよう読み込み中を出す
  const [clipBusy, setClipBusy] = useState<'mocap' | 'hybrid' | null>(null);
  const [clipMode, setClipMode] = useState<'off' | 'mocap' | 'hybrid'>('off');
  const [clipList, setClipList] = useState<ClipInfo[]>([]);
  const [clipId, setClipId] = useState<string | null>(null);
  const clipCacheRef = useRef(new Map<string, MotionClip>());
  const [clipT, setClipT] = useState(0);
  const clipTimeRef = useRef(0);
  const viewRef = useRef<View>({ ...VIEW_PRESETS.正面 });
  const autoOrbitRef = useRef(false);
  const [autoOrbit, setAutoOrbit] = useState(false);
  const [preset, setPreset] = useState('正面');
  const stageRef = useRef<HTMLDivElement>(null);
  // 写真から作った顔。端末の localStorage に置くだけで、どこへも送信しない
  const [faces, setFaces] = useState<FaceSlots>(EMPTY_FACES);
  const [faceBusy, setFaceBusy] = useState<'leader' | 'follower' | null>(null);
  const [faceErr, setFaceErr] = useState<string | null>(null);

  useEffect(() => { setFaces(loadFaces()); }, []);

  const onFacePick = async (slot: 'leader' | 'follower', file: File | undefined) => {
    if (!file) return;
    setFaceErr(null);
    setFaceBusy(slot);
    try {
      const avatar = await detectFace(file);
      setFaces((prev) => {
        const next = { ...prev, [slot]: avatar };
        saveFaces(next);
        return next;
      });
    } catch (e) {
      setFaceErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFaceBusy(null);
    }
  };

  // ── クリップの見返し: スロー再生・コマ送り・シーク
  const [speed, setSpeed] = useState(1);
  const onSpeed = (v: number) => { setSpeed(v); phRef.current.clipSpeed = v; };

  const seek = (t: number) => {
    const ph = phRef.current;
    const v = Math.min(ph.clipDuration || 0, Math.max(0, t));
    ph.clipTime = v; clipTimeRef.current = v; setClipT(v);
  };
  // 計測用（一時）: コンソールからクリップ時刻を直接動かすフック（__armDump と対で使う）
  (globalThis as unknown as { __clipSeek?: (t: number) => void }).__clipSeek = seek;
  /** コマ送り。止めてから1フレームぶん進める/戻す */
  const stepFrame = (dir: number) => {
    const ph = phRef.current;
    if (ph.playing) { ph.playing = false; setPlaying(false); }
    seek(ph.clipTime + dir / (clip?.fps || 30));
  };

  // 頭の選択。'photo' は取り込み済みの写真、それ以外はサンプルの id（'' = 素の球）
  const headChoice = (slot: 'leader' | 'follower') =>
    faces[slot] ? 'photo' : faces.sample[slot];

  const onHeadChoice = (slot: 'leader' | 'follower', value: string) => {
    if (value === 'photo') return; // 写真は取り込んだ時点で選ばれている
    setFaces((prev) => {
      // サンプルを選んだらその枠の写真は手放す（選択を1本にしておく）
      const next = { ...prev, [slot]: null, sample: { ...prev.sample, [slot]: value } };
      saveFaces(next);
      return next;
    });
    setFaceErr(null);
  };

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
    if (clipMode === 'off' || !clip) return;
    const ev = [...clip.events].filter((e) => e.t <= clipT + 0.01).pop();
    if (!ev || clipT - ev.t > 2.2) { setNowLabel('—'); return; }
    const name = ev.type === 'CBL' ? 'クロスボディリード'
      : ev.type === 'Turn' ? `ターン（${ev.by === 'follower' ? 'フォロワー' : 'リーダー'}）`
      : ev.type;
    setNowLabel(name + (ev.rotations && ev.rotations >= 2 ? ` ×${ev.rotations}` : ''));
  }, [clipMode, clip, clipT]);

  const fetchClipList = useCallback(async (): Promise<ClipInfo[]> => {
    const res = await fetch(`${HOME_SERVER_URL}/api/motion`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = (await res.json()) as { clips: ClipInfo[] };
    return data.clips;
  }, []);

  // クリップ一覧はタブを開いた時点で先読みしておく（失敗はボタン押下時に改めて表面化する）
  useEffect(() => {
    if (!HOME_SERVER_URL) return;
    fetchClipList()
      .then((clips) => {
        setClipList(clips);
        setClipId((prev) => prev ?? clips[0]?.id ?? null);
      })
      .catch(() => {});
  }, [fetchClipList]);

  const fetchClip = async (id: string): Promise<MotionClip> => {
    const cached = clipCacheRef.current.get(id);
    if (cached) return cached;
    const res = await fetch(`${HOME_SERVER_URL}/api/motion/${id}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const c = (await res.json()) as MotionClip;
    clipCacheRef.current.set(id, c);
    return c;
  };

  const loadClip = async (mode: 'mocap' | 'hybrid', idOverride?: string) => {
    setClipErr(null);
    if (!HOME_SERVER_URL) {
      setClipErr('VITE_HOME_SERVER_URL が未設定です（クリップはホームサーバーから配信されます）');
      return;
    }
    setClipBusy(mode);
    try {
      let id = idOverride ?? clipId;
      if (!id) {
        // 先読みが失敗していた場合はここで再取得する
        const clips = await fetchClipList();
        setClipList(clips);
        id = clips[0]?.id ?? null;
        setClipId(id);
      }
      if (!id) throw new Error('サーバーにクリップがありません');
      const c = await fetchClip(id);
      setClip(c);
      const ph = phRef.current;
      ph.mode = mode;
      ph.clipTime = 0;
      ph.clipDuration = c.duration;
      ph.playing = true;
      clipTimeRef.current = 0;
      setClipMode(mode);
      setPlaying(true);
      setNowLabel('—');
    } catch (e) {
      setClipErr(e instanceof Error ? e.message : String(e));
    } finally {
      setClipBusy(null);
    }
  };

  const onSelectClip = (id: string) => {
    setClipId(id);
    // 再生中にクリップを替えたら、同じモードのまま新しいクリップへ切り替える
    if (clipMode !== 'off') void loadClip(clipMode, id);
  };

  // ステージのドラッグで自由視点。横=回り込み、縦=見下ろし/見上げ
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const v = viewRef.current;
    v.az += (e.clientX - d.x) * 0.008;
    v.el = Math.min(EL_MAX, Math.max(EL_MIN, v.el + (e.clientY - d.y) * 0.006));
    dragRef.current = { x: e.clientX, y: e.clientY };
    setPreset('');
  };
  const onPointerUp = () => { dragRef.current = null; };

  // ホイールでドリー。ページスクロールを奪うので passive:false で自前登録する
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      v.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, v.dist * (1 + Math.sign(e.deltaY) * 0.09)));
      setPreset('');
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const applyPreset = (name: string) => {
    const p = VIEW_PRESETS[name];
    if (!p) return;
    viewRef.current.az = p.az;
    viewRef.current.el = p.el;
    viewRef.current.dist = p.dist;
    setPreset(name);
  };

  const start = (mode: 'random' | 'replay', queue: { move: MoveKind; rotations: number }[]) => {
    const ph = phRef.current;
    ph.mode = mode; ph.queue = queue; ph.beat = 0; ph.cycle = -1;
    ph.current = 'basic'; ph.rotations = 1; ph.moveStartBeat = 0;
    ph.playing = true; setPlaying(true); setClipMode('off');
    setNowLabel(mode === 'replay' ? '再現の準備…' : 'ベーシック');
  };
  const toggle = () => {
    const ph = phRef.current;
    ph.playing = !ph.playing; setPlaying(ph.playing);
    if (ph.playing && ph.mode !== 'mocap' && ph.mode !== 'hybrid' && ph.cycle === -1) { ph.mode = 'random'; }
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
        ref={stageRef}
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
          {clipMode === 'mocap' && clip ? (
            <>
              <MocapFigure clip={clip} pid={clip.leaderPid} color="#3d8bff" timeRef={clipTimeRef} />
              <MocapFigure clip={clip} pid={1 - clip.leaderPid} color="#ff4db8" timeRef={clipTimeRef} />
            </>
          ) : clipMode === 'hybrid' && clip ? (
            <CoupleFigure
              clip={clip}
              timeRef={clipTimeRef}
              leaderColor="#3d8bff"
              followerColor="#ff4db8"
              leaderFace={faces.leader}
              followerFace={faces.follower}
              leaderSample={faces.sample.leader}
              followerSample={faces.sample.follower}
            />
          ) : (
            <>
              <Dancer role="leader" color="#3d8bff" phRef={phRef} />
              <Dancer role="follower" color="#ff4db8" phRef={phRef} />
            </>
          )}
          <Choreographer phRef={phRef} />
          <CameraRig viewRef={viewRef} autoRef={autoOrbitRef} />
        </Canvas>

        <div className={styles.overlay}>
          <span className={styles.badge}><i className={styles.dotL} />リーダー</span>
          <span className={styles.badge}><i className={styles.dotF} />フォロワー</span>
          <span className={styles.now}>{nowLabel}</span>
          {clipMode !== 'off' && (
            <span className={styles.badge}>
              {clipMode === 'hybrid' ? '動画のモーション' : '復元データ（デバッグ）'}
              {' '}{clipT.toFixed(1)}s / {clip?.duration.toFixed(1)}s
            </span>
          )}
        </div>
      </div>

      <div className={styles.bar}>
        <button className={`${styles.btn} ${styles.primary}`} onClick={toggle}>
          {playing ? '⏸ 停止' : '▶ 再生'}
        </button>
        <button className={styles.btn} onClick={replaySample}>📼 解析サンプルを再現</button>
        <button
          className={`${styles.btn} ${clipMode === 'hybrid' ? styles.primary : ''}`}
          onClick={() => loadClip('hybrid')}
          disabled={clipBusy !== null}
        >
          {clipBusy === 'hybrid' ? '⏳ 読み込み中…' : '🎥 動画のモーションで踊る'}
        </button>
        <button
          className={`${styles.btn} ${clipMode === 'mocap' ? styles.primary : ''}`}
          onClick={() => loadClip('mocap')}
          disabled={clipBusy !== null}
        >
          {clipBusy === 'mocap' ? '⏳ 読み込み中…' : '🦴 復元データ（デバッグ）'}
        </button>
        {clipList.length > 1 && (
          <label className={styles.clipSel}>
            🎞
            <select value={clipId ?? ''} onChange={(e) => onSelectClip(e.target.value)}>
              {clipList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? c.id}（{Math.round(c.duration)}秒）
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className={`${styles.btn} ${autoOrbit ? styles.primary : ''}`}
          onClick={() => { const v = !autoOrbit; setAutoOrbit(v); autoOrbitRef.current = v; }}
        >
          🔄 回り込み
        </button>
        <span className={styles.views}>
          {Object.keys(VIEW_PRESETS).map((name) => (
            <button
              key={name}
              className={`${styles.viewBtn} ${preset === name ? styles.viewBtnActive : ''}`}
              onClick={() => applyPreset(name)}
            >
              {name}
            </button>
          ))}
        </span>
        <label className={styles.tempo}>
          BPM <input type="range" min={130} max={200} value={bpm} onChange={e => onBpm(Number(e.target.value))} />
          <b>{bpm}</b>
        </label>
        {/* 頭: 同梱サンプルから選ぶか、写真から作る（写真の処理も保存も端末内で完結） */}
        {(['leader', 'follower'] as const).map((slot) => (
          <span key={slot} className={styles.headSel}>
            <label className={styles.clipSel}>
              {slot === 'leader' ? '🙂 リーダー' : '🙂 フォロワー'}
              <select
                value={headChoice(slot)}
                onChange={(e) => onHeadChoice(slot, e.target.value)}
              >
                {SAMPLE_AVATARS.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
                <option value="">顔なし（色だけ）</option>
                {faces[slot] && <option value="photo">写真から作った顔</option>}
              </select>
            </label>
            <label className={`${styles.btn} ${faces[slot] ? styles.primary : ''}`}>
              {faceBusy === slot ? '⏳ 解析中…' : '📷 写真'}
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => { void onFacePick(slot, e.target.files?.[0]); e.target.value = ''; }}
              />
            </label>
          </span>
        ))}
      </div>

      {/* 見返し用: 速い動きは等速だと追えないので、スロー・コマ送り・シークを出す */}
      {clipMode !== 'off' && clip && (
        <div className={styles.bar}>
          <button className={styles.btn} onClick={() => stepFrame(-1)}>⏮ コマ戻し</button>
          <button className={styles.btn} onClick={() => stepFrame(1)}>コマ送り ⏭</button>
          <label className={styles.clipSel}>
            ⏱
            <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
              <option value={1}>等速</option>
              <option value={0.5}>0.5倍</option>
              <option value={0.25}>0.25倍</option>
              <option value={0.1}>0.1倍</option>
            </select>
          </label>
          <label className={styles.seek}>
            <input
              type="range"
              min={0}
              max={clip.duration}
              step={0.01}
              value={Math.min(clipT, clip.duration)}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <b>{clipT.toFixed(2)}s</b>
          </label>
        </div>
      )}

      {clipErr && <p className={styles.note}>モーションの読み込みに失敗しました: {clipErr}</p>}
      {faceErr && <p className={styles.note}>顔の読み込みに失敗しました: {faceErr}</p>}

      <p className={styles.note}>
        <b>🎥 動画のモーションで踊る</b> は、動画から復元したモーションを<b>固定長のリグ</b>で再生します
        （YOLOのbboxで1人ずつ切り出し → MediaPipe の world landmarks → 弱透視で2人を空間に配置）。
        関節の位置をそのまま描くのではなく、実データを<b>目標</b>としてリグに渡すので、
        隠れて観測できなかった関節があっても身体が欠けたり伸びたりしません。
        実データから取っているのは観測率の高い量に絞っています —
        <b>動線・体の向き・腰の高さ</b>（腰は常時観測）、<b>脚のステップ</b>（足首をIKで追う）、
        <b>足の向き</b>、<b>頭の向き＝スポッティング</b>（耳はほぼ常時観測）。
        観測率が4割前後しかない<b>腕</b>は実データを使わず、技イベントの「つなぎ手」から
        <b>2人で共有する1点</b>を作って両者の手をそこへ運びます（ペアを1つのリグとして解くので手が離れません）。
        2人の距離も拘束しています — 弱透視の奥行き誤差で腰の間隔が最小5cmまで潰れるため、
        重心を動かさずに0.58〜1.02mへ収めています（振付の床の使い方は保たれます）。
        ステージは<b>ドラッグで回り込め</b>ます — 元の動画に無いアングルから見られるのが3D復元の値打ちです。
        <b>🙂 頭</b> は同梱のサンプルから選べます（既定でリーダー/フォロワーに別々のものが入っています）。
        <b>📷 写真</b> を選ぶと自分の顔にできます — MediaPipe の顔ランドマーク478点をそのまま頂点にし、
        同じ点の画像座標を UV に使うので、写真が顔の形にぴったり貼られます。
        <b>解析も保存もこの端末の中だけで完結し、写真はどこへも送信されません</b>
        （サンプルを選び直せばその枠の写真は消えます）。
        <b>🦴 復元データ</b> は復元結果そのものを見るデバッグ表示で、
        薄いボーンは補間、描かれないボーンは観測なしです。
        ▶ 再生 / 📼 は技イベントだけ動画由来の手続きアニメ（B方式）です。
      </p>
    </div>
  );
}

export default SalsaStage3D;
