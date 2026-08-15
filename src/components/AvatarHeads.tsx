import { useEffect, useMemo, useState } from 'react';
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

/**
 * 画像の矩形領域の平均色。外れ値（ハイライト・影）に引っ張られないよう、
 * 明るさで中央 60% に入る画素だけを平均する。
 */
export function regionAverage(
  data: Uint8ClampedArray, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
): string {
  const px: { r: number; g: number; b: number; l: number }[] = [];
  for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1 | 0); y++) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(w, x1 | 0); x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      px.push({ r, g, b, l: 0.299 * r + 0.587 * g + 0.114 * b });
    }
  }
  if (!px.length) return DEFAULT_SKIN;
  px.sort((a, b) => a.l - b.l);
  const lo = Math.floor(px.length * 0.2), hi = Math.max(lo + 1, Math.ceil(px.length * 0.8));
  let r = 0, g = 0, b = 0;
  for (let i = lo; i < hi; i++) { r += px[i].r; g += px[i].g; b += px[i].b; }
  const n = hi - lo;
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * 顔写真から「頭全体」の色を拾う。
 * 髪 = 上端の帯（切り出しは頭のまわりなので、ここはほぼ髪か帽子）、
 * 肌 = 両頬のあたり。これで後頭部と髪を顔と地続きの色にできる。
 */
function useHeadColors(src: string, fallback: string) {
  const [c, setC] = useState<{ skin: string; hair: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!alive || !w || !h) return;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, w, h).data;
      const hair = regionAverage(d, w, h, w * 0.25, 0, w * 0.75, h * 0.12);
      // 頬は鼻の左右。中央（鼻筋のハイライト）と輪郭の外は避ける
      const cheekL = regionAverage(d, w, h, w * 0.18, h * 0.5, w * 0.34, h * 0.66);
      const cheekR = regionAverage(d, w, h, w * 0.66, h * 0.5, w * 0.82, h * 0.66);
      const mix = (a: string, b: string) => {
        const p = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
        const v = [0, 1, 2].map((i) => Math.round((p(a, i) + p(b, i)) / 2));
        return `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
      };
      setC({ skin: mix(cheekL, cheekR), hair });
    };
    img.src = src;
    return () => { alive = false; };
  }, [src]);
  return c ?? { skin: fallback, hair: fallback };
}

/** 写真から作った顔。後頭部と髪は写真から拾った色で作り、顔と地続きの頭にする */
export function PhotoHead({ avatar, color }: { avatar: FaceAvatar; color: string }) {
  const { skin, hair } = useHeadColors(avatar.image, color);
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
      {/* 頭蓋。写真の頬から拾った肌色なので、顔の縁で色が途切れない */}
      <mesh position={[0, 0, -0.05]}>
        <sphereGeometry args={[0.105, 20, 16]} />
        <meshStandardMaterial color={skin} roughness={0.7} metalness={0} />
      </mesh>
      {/* 髪。頭蓋と同じ中心・少し大きい球のキャップを後ろへ倒し、
          前は顔メッシュ（z=+0.075）より手前に出ないところで止める */}
      <mesh position={[0, 0, -0.05]} rotation={[-0.5, 0, 0]}>
        <sphereGeometry args={[0.112, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
        <meshStandardMaterial color={hair} roughness={0.9} metalness={0} side={THREE.DoubleSide} />
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
