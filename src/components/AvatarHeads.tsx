import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { buildFaceGeometry, type FaceAvatar } from '../engine/faceAvatar';

/**
 * アバターの頭の見た目。3種類あり、リグ側（CoupleFigure）はどれを出すかだけを決める。
 *
 *   PhotoHead  … 写真から作った顔（faceAvatar.ts）
 *   SampleHead … 同梱のサンプル。写真を入れなくても人形が「人の顔」になる
 *   （どちらも無ければ CoupleFigure 側の素の球）
 *
 * サンプルは外部アセットを持たず three のプリミティブで組む。リグ本体が
 * カプセルと球でできているので、写実に寄せるより同じ抽象度で揃えたほうが馴染む。
 * 頭は rig.head の子なので、耳から取ったスポッティングの回転がそのまま効く。
 */

export type SampleAvatar = {
  id: string;
  label: string;
  skin: string;
  hair: string;
  style: 'short' | 'long' | 'bun';
};

export const SAMPLE_AVATARS: SampleAvatar[] = [
  { id: 'a', label: 'ショート・黒', skin: '#e8b98f', hair: '#241c19', style: 'short' },
  { id: 'b', label: 'ロング・黒', skin: '#f0c9a4', hair: '#2b1d18', style: 'long' },
  { id: 'c', label: 'ポニーテール・茶', skin: '#cf9163', hair: '#4a2c1a', style: 'bun' },
  { id: 'd', label: 'ショート・茶', skin: '#f3d3b3', hair: '#7a4a24', style: 'short' },
  { id: 'e', label: 'ロング・栗', skin: '#a86b45', hair: '#5c3317', style: 'long' },
];

export const SAMPLE_BY_ID = (id: string): SampleAvatar | null =>
  SAMPLE_AVATARS.find((a) => a.id === id) ?? null;

/** 写真の頭やサンプル未選択のときに体へ使う肌色 */
export const DEFAULT_SKIN = '#e8b98f';

const R = 0.115;  // 頭の半径。CoupleFigure の素の球と揃える

/** 写真から作った顔。後頭部は色つきの球のまま残して「頭」として成立させる */
export function PhotoHead({ avatar, color }: { avatar: FaceAvatar; color: string }) {
  const geo = useMemo(() => buildFaceGeometry(avatar), [avatar]);
  const tex = useMemo(() => {
    const t = new THREE.TextureLoader().load(avatar.image);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [avatar.image]);
  useEffect(() => () => { geo.dispose(); tex.dispose(); }, [geo, tex]);

  return (
    <>
      {/* 顔メッシュは landmark 由来の奥行きが ±1.5cm 程度しかない。後頭部の球
          （半径 0.105・中心 z=-0.05）は前面が z=+0.055 まで来るので、顔を z=+0.03 に
          置くと球の中に埋まって見えなくなる。顔を球の前面より前へ出す */}
      <mesh geometry={geo} position={[0, 0, 0.075]}>
        {/* 三角形の向きは分割の都合で揃わないので両面で描く */}
        <meshStandardMaterial map={tex} roughness={0.85} metalness={0} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0, -0.05]}>
        <sphereGeometry args={[0.105, 20, 16]} />
        <meshStandardMaterial color={color} roughness={0.6} metalness={0.05} />
      </mesh>
    </>
  );
}

/** 同梱のサンプルアバター。顔が +Z（体の前方）を向く */
export function SampleHead({ preset }: { preset: SampleAvatar }) {
  return (
    <group>
      <mesh castShadow>
        <sphereGeometry args={[R, 24, 18]} />
        <meshStandardMaterial color={preset.skin} roughness={0.75} metalness={0} />
      </mesh>

      {/* 髪: 上半球のキャップを後ろへ倒し、前は眉の上で切る・後ろは赤道より下まで覆う。
          倒し角 0.45rad と 0.46π の組み合わせで前の生え際が y≈0.063（眉 0.049 の上）に来る */}
      <mesh rotation={[-0.45, 0, 0]}>
        <sphereGeometry args={[R + 0.007, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.46]} />
        <meshStandardMaterial color={preset.hair} roughness={0.9} metalness={0} side={THREE.DoubleSide} />
      </mesh>
      {preset.style === 'long' && (
        // 後ろへ落ちる髪
        <mesh position={[0, -0.07, -0.035]} scale={[1, 1.5, 0.85]}>
          <sphereGeometry args={[0.098, 20, 16]} />
          <meshStandardMaterial color={preset.hair} roughness={0.9} metalness={0} />
        </mesh>
      )}
      {preset.style === 'bun' && (
        <mesh position={[0, 0.045, -0.12]}>
          <sphereGeometry args={[0.052, 16, 12]} />
          <meshStandardMaterial color={preset.hair} roughness={0.9} metalness={0} />
        </mesh>
      )}

      {/* 目と眉。球の表面すれすれに置いて、少しだけ浮かせる */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 0.042, 0.018, 0.100]} scale={[1, 0.65, 0.5]}>
            <sphereGeometry args={[0.017, 12, 10]} />
            <meshStandardMaterial color="#1a1f2e" roughness={0.35} metalness={0} />
          </mesh>
          <mesh position={[s * 0.043, 0.049, 0.096]} rotation={[0, 0, -s * 0.14]}>
            <boxGeometry args={[0.033, 0.007, 0.010]} />
            <meshStandardMaterial color={preset.hair} roughness={0.8} metalness={0} />
          </mesh>
        </group>
      ))}

      {/* 鼻と口 */}
      <mesh position={[0, -0.012, 0.108]}>
        <sphereGeometry args={[0.020, 12, 10]} />
        <meshStandardMaterial color={preset.skin} roughness={0.75} metalness={0} />
      </mesh>
      <mesh position={[0, -0.052, 0.100]}>
        <boxGeometry args={[0.040, 0.010, 0.010]} />
        <meshStandardMaterial color="#8c3a4a" roughness={0.6} metalness={0} />
      </mesh>
    </group>
  );
}
