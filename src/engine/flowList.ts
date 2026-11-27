import type { MoveFrameSet } from './choreoSheet';

/**
 * 「流れ」の一覧に出す、技の代表コマ 1 枚の url。
 * v2 のコマ（見どころの瞬間を 5〜6 枚）なら真ん中、無ければ null（v1 の帯だけのジョブは写真なし）
 */
export function flowThumbUrl(set: MoveFrameSet | undefined): string | null {
  const f = set?.frames;
  if (!f || f.length === 0) return null;
  return f[Math.floor((f.length - 1) / 2)].url;
}

/**
 * PC 幅の一覧カードに並べるコマ。flip[]（1/4 拍ごとの密なコマ）があれば、そこから max 枚を等間隔に選び直す
 * （見どころ key=true は残す）。無ければ元のコマのまま。携帯では呼ばない（今のコマ数のまま）
 */
export type DenseShot = { t: number | null; url: string; count?: number; label?: string; key?: boolean };

export function pickDenseShots(flip: DenseShot[], max: number): DenseShot[] {
  const n = flip.length;
  if (n <= max) return flip.slice();
  const chosen = new Set<number>();
  for (let i = 0; i < max; i++) chosen.add(Math.round((i * (n - 1)) / (max - 1)));
  return [...chosen].sort((a, b) => a - b).map(i => flip[i]);
}
