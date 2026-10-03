import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MotionClip } from './MocapFigure';
import type { FaceAvatar } from '../engine/faceAvatar';
import { PhotoHead, SampleHead, SAMPLE_BY_ID, DEFAULT_SKIN } from './AvatarHeads';
import { SAMPLE_FACE_BY_ID } from '../engine/sampleFaces';
import { CoupleSolver, buildRigObjects, type Rig } from '../engine/coupleSolver';
import { parseDumpWindow } from '../engine/rigDebug';
import {
  L_THIGH, L_SHIN, L_UPARM, L_FOREARM,
  TORSO_Y, TORSO_R, TORSO_LEN, PELVIS_R, PELVIS_LEN, NECK_Y, NECK_R, NECK_LEN, HEAD_R,
  SKIRT_Y, SKIRT_R_TOP, SKIRT_R_BOT, SKIRT_H, UPARM_R, FOREARM_R, HAND_R, THIGH_R, SHIN_R,
} from '../engine/rigDims';

/**
 * カップルダンスの3D表示。**姿勢の計算は engine/coupleSolver.ts**（node のテストから
 * そのまま回せるように切り出した）。ここは関節（rig のオブジェクト）にメッシュを付けて、
 * 毎フレーム solver.step() を呼ぶだけの薄い殻。
 *
 * 寸法は engine/rigDims.ts の1か所にある。見た目の半径を変えたら当たり判定も一緒に変わる。
 */

/** 服の配色。役割の色は服の色として残すので、青＝リーダー/ピンク＝フォロワーは変わらない */
type Palette = { cloth: string; pants: string; skin: string; shoe: string; dress: boolean };

function buildPalette(color: string, skin: string, dress: boolean, shoe?: string): Palette {
  const c = new THREE.Color(color);
  return {
    cloth: color,
    pants: `#${c.clone().multiplyScalar(0.45).getHexString()}`,
    skin,
    // サルサシューズ: リーダーは黒のラテン（低いキューバンヒール）、
    // フォロワーはタンのストラップ付きヒール（この配色が実物でいちばん多い）
    shoe: shoe ?? (dress ? '#b5834f' : '#17181f'),
    dress,
  };
}

/**
 * サルサシューズ。**足首より下**へ伸ばす — クリップの足首は接地時で床から約5cm
 * （実測 p05: 0.04〜0.07m）なので、そこから下に靴底が来るように置く。
 */
function Shoe({ pal }: { pal: Palette }) {
  const mat = (
    <meshStandardMaterial color={pal.shoe} roughness={0.34} metalness={0.16} />
  );
  if (!pal.dress) {
    // ラテンシューズ: つま先の細い甲 + 後ろに低いキューバンヒール
    return (
      <group>
        <mesh position={[0, -0.025, 0.045]} castShadow>
          <boxGeometry args={[0.090, 0.048, 0.205]} />
          {mat}
        </mesh>
        <mesh position={[0, -0.020, 0.150]} castShadow>
          <boxGeometry args={[0.058, 0.036, 0.055]} />
          {mat}
        </mesh>
        <mesh position={[0, -0.056, -0.042]} castShadow>
          <boxGeometry args={[0.055, 0.026, 0.062]} />
          {mat}
        </mesh>
      </group>
    );
  }
  // ヒール: つま先を下げた甲 + 細いヒール + アンクルストラップ
  return (
    <group>
      <mesh position={[0, -0.030, 0.050]} rotation={[0.22, 0, 0]} castShadow>
        <boxGeometry args={[0.070, 0.040, 0.190]} />
        {mat}
      </mesh>
      <mesh position={[0, -0.062, -0.048]} castShadow>
        <cylinderGeometry args={[0.010, 0.013, 0.078, 10]} />
        {mat}
      </mesh>
      <mesh position={[0, 0.002, -0.008]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.043, 0.0055, 8, 20]} />
        {mat}
      </mesh>
    </group>
  );
}

/**
 * 1人ぶんの見た目。関節は rig のオブジェクト（buildRigObjects が作る階層）そのもので、
 * ここは各関節にメッシュを付けるだけ。姿勢は CoupleSolver がまとめて書き込む。
 * primitive の入れ子は rig の親子関係と同じ形にしておく（StrictMode の付け外しで
 * 外れた子も、この入れ子が付け直す）
 */
function Body({
  rig, pal, face, sample,
}: {
  rig: Rig; pal: Palette; face?: FaceAvatar | null; sample?: string | null;
}) {
  const preset = sample ? SAMPLE_BY_ID(sample) : null;
  // 同梱の写真サンプル（解析済み動画から取った顔）。写真枠と同じ描き方をする
  const sampleFace = sample ? SAMPLE_FACE_BY_ID(sample) : null;
  // 服＝役割色、素肌＝サンプルの肌色。上腕だけ服＝半袖に見える
  const clothMat = <meshStandardMaterial color={pal.cloth} roughness={0.62} metalness={0.02} />;
  const pantsMat = <meshStandardMaterial color={pal.pants} roughness={0.66} metalness={0.02} />;
  const skinMat = <meshStandardMaterial color={pal.skin} roughness={0.72} metalness={0} />;
  const shoeMat = <meshStandardMaterial color={pal.shoe} roughness={0.5} metalness={0.05} />;
  // ワンピースの人は脚が素肌、そうでない人はスラックス
  const legMat = pal.dress ? skinMat : pantsMat;

  return (
    <primitive object={rig.root}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <circleGeometry args={[0.34, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} />
      </mesh>

      <primitive object={rig.hips}>
        <mesh>
          <capsuleGeometry args={[PELVIS_R, PELVIS_LEN, 6, 14]} />
          {pal.dress ? clothMat : pantsMat}
        </mesh>
        {/* ワンピースのスカート。腰の子なので体の向きにだけ付いて回り、脚の動きでは歪まない */}
        {pal.dress && (
          <mesh position={[0, SKIRT_Y, 0]}>
            <cylinderGeometry args={[SKIRT_R_TOP, SKIRT_R_BOT, SKIRT_H, 24, 1, true]} />
            <meshStandardMaterial
              color={pal.cloth} roughness={0.65} metalness={0.02} side={THREE.DoubleSide}
            />
          </mesh>
        )}

        {/* 脚（太もも → すね → 足）。IK が太ももの姿勢と膝角を書き込む */}
        {[0, 1].map((s) => (
          <primitive key={s} object={rig.thigh[s]}>
            <mesh position={[0, -L_THIGH / 2, 0]} castShadow>
              <capsuleGeometry args={[THIGH_R, L_THIGH - 0.1, 6, 12]} />
              {legMat}
            </mesh>
            <primitive object={rig.knee[s]}>
              <mesh position={[0, -L_SHIN / 2, 0]} castShadow>
                <capsuleGeometry args={[SHIN_R, L_SHIN - 0.1, 6, 12]} />
                {legMat}
              </mesh>
              {/* 足: つま先が +Z（体の前方）を向く向きで作る */}
              <primitive object={rig.foot[s]}>
                <Shoe pal={pal} />
              </primitive>
            </primitive>
          </primitive>
        ))}

        {/* 胴 + 頭 + 腕 */}
        <primitive object={rig.spine}>
          <mesh position={[0, TORSO_Y, 0]}>
            <capsuleGeometry args={[TORSO_R, TORSO_LEN, 6, 14]} />
            {clothMat}
          </mesh>
          <mesh position={[0, NECK_Y, 0]}>
            <capsuleGeometry args={[NECK_R, NECK_LEN, 4, 8]} />
            {skinMat}
          </mesh>

          {/* 頭（耳から取れる相対ヨーで回る = スポッティング） */}
          <primitive object={rig.head}>
            {face ? <PhotoHead avatar={face} color={pal.cloth} />
              : sampleFace ? <PhotoHead avatar={sampleFace.avatar} color={pal.cloth} />
                : preset ? <SampleHead preset={preset} /> : (
                <>
                  <mesh>
                    <sphereGeometry args={[HEAD_R, 20, 16]} />
                    {skinMat}
                  </mesh>
                  {/* 顔の向きが読めるように鼻先を出す */}
                  <mesh position={[0, -0.01, 0.105]}>
                    <sphereGeometry args={[0.032, 12, 10]} />
                    {shoeMat}
                  </mesh>
                </>
              )}
          </primitive>

          {/* 腕（肩 → 肘 → 手）。つないでいる側は IK が姿勢を書き込む */}
          {[0, 1].map((s) => (
            <primitive key={s} object={rig.shldr[s]}>
              {/* 上腕は服（＝袖）、前腕から先は素肌にして半袖に見せる */}
              <mesh position={[0, -L_UPARM / 2, 0]}>
                <capsuleGeometry args={[UPARM_R, L_UPARM - 0.1, 6, 10]} />
                {clothMat}
              </mesh>
              <primitive object={rig.elbow[s]}>
                <mesh position={[0, -L_FOREARM / 2, 0]}>
                  <capsuleGeometry args={[FOREARM_R, L_FOREARM - 0.1, 6, 10]} />
                  {skinMat}
                </mesh>
                <mesh position={[0, -L_FOREARM, 0]}>
                  <sphereGeometry args={[HAND_R, 12, 10]} />
                  {skinMat}
                </mesh>
              </primitive>
            </primitive>
          ))}
        </primitive>
      </primitive>
    </primitive>
  );
}

export function CoupleFigure({
  clip, timeRef, leaderColor, followerColor,
  leaderFace, followerFace, leaderSample, followerSample,
  leaderShoe, followerShoe,
}: {
  clip: MotionClip;
  timeRef: { current: number };
  leaderColor: string;
  followerColor: string;
  leaderFace?: FaceAvatar | null;
  followerFace?: FaceAvatar | null;
  leaderSample?: string | null;
  followerSample?: string | null;
  /** 靴の色。背景と同化して見えないときのために外から差し替えられる */
  leaderShoe?: string;
  followerShoe?: string;
}) {
  // 関節の階層は1回だけ作り、クリップが替わっても使い回す（姿勢の続きから動く）
  const rigs = useMemo<[Rig, Rig]>(() => [buildRigObjects(), buildRigObjects()], []);
  // URL クエリはここで読んでソルバーへ渡す:
  //   ?armTimeline=0 … armTimeline を無視して旧経路（holds/events 走査）へ
  //   ?keyPose=0     … キーポーズ方式を切って観測追従へ（見比べ用）
  //   ?armDump=a,b   … 窓内の腕の座標と貫通深さを console.table へ
  const opts = useMemo(() => {
    const search = globalThis.location?.search ?? '';
    const q = new URLSearchParams(search);
    return {
      noArmTimeline: q.get('armTimeline') === '0',
      keyPose: q.get('keyPose') !== '0',
      dumpWindow: parseDumpWindow(search),
    };
  }, []);
  // クリップが替わったら作り直す。共有ホールド点の鈍りなどは前のソルバーから引き継ぐ
  // （クローズド ⇄ 片手の切り替えで手が飛ばないように — 旧実装は ref で持ち越していた）
  const prevSolver = useRef<CoupleSolver | null>(null);
  const solver = useMemo(() => {
    const s = new CoupleSolver(clip, opts);
    if (prevSolver.current) s.inherit(prevSolver.current);
    prevSolver.current = s;
    return s;
  }, [clip, opts]);
  // 肌の色は選んだサンプルに合わせる（写真の頭でも体はこの色で通す）
  const pals = useMemo<[Palette, Palette]>(() => [
    buildPalette(leaderColor, SAMPLE_BY_ID(leaderSample ?? '')?.skin ?? DEFAULT_SKIN, false, leaderShoe),
    buildPalette(followerColor, SAMPLE_BY_ID(followerSample ?? '')?.skin ?? DEFAULT_SKIN, true, followerShoe),
  ], [leaderColor, followerColor, leaderSample, followerSample, leaderShoe, followerShoe]);

  useFrame((_st, dt) => {
    solver.step(rigs, timeRef.current, dt);
  });

  return (
    <>
      <Body rig={rigs[0]} pal={pals[0]} face={leaderFace} sample={leaderSample} />
      <Body rig={rigs[1]} pal={pals[1]} face={followerFace} sample={followerSample} />
    </>
  );
}

export default CoupleFigure;
