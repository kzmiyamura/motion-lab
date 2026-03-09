/**
 * Salsa Clave パターン定義
 *
 * beatPositions は 1〜8 の小数表記:
 *   x.0  → ちょうどビート x に着地 (ON)
 *   x.5  → ビート x の "and"（裏拍）(AND)
 *   x.3  → ビート x から少し遅れた着地 ルンバ特有 (LATE)
 */

export type HitType = 'on' | 'and' | 'late';

export type ClavePattern = {
  id: string;
  name: string;
  tag: string;       // ラベル (e.g. "On2推奨")
  description: string;
  beatPositions: number[];
};

/** 小数ビート位置 → タイル番号 + HitType に変換 */
export function computeHits(positions: number[]): Map<number, HitType> {
  const map = new Map<number, HitType>();
  for (const pos of positions) {
    const tile = Math.floor(pos);
    const frac = +(pos - tile).toFixed(2);
    if (frac <= 0.1)       map.set(tile, 'on');
    else if (frac >= 0.4)  map.set(tile, 'and');
    else                   map.set(tile, 'late');
  }
  return map;
}

export const CLAVE_PATTERNS: ClavePattern[] = [
  {
    id: 'son-2-3',
    name: 'Son Clave 2-3',
    tag: 'On2推奨',
    description: '最も一般的なパターン。基本のサルサリズム。On2スタイルのダンサー必携。',
    beatPositions: [2, 3, 5, 6.5, 8.0],
  },
  {
    id: 'son-3-2',
    name: 'Son Clave 3-2',
    tag: 'イントロ向き',
    description: '華やかな曲の始まりや特定のイントロに合う。On1スタイルとの親和性が高い。',
    beatPositions: [1, 2.5, 4, 6, 7],
  },
  {
    id: 'rumba-2-3',
    name: 'Rumba Clave 2-3',
    tag: 'ストリート感',
    description: 'ストリート感のある重厚なノリ。最後の一打が少し遅れるのがルンバの特徴。',
    beatPositions: [2, 3, 5, 6.5, 8.3],
  },
  {
    id: 'rumba-3-2',
    name: 'Rumba Clave 3-2',
    tag: 'コンテンポラリー',
    description: 'コンテンポラリーや複雑な構成の曲に。4打目の微妙な遅れがグルーヴを生む。',
    beatPositions: [1, 2.5, 4.3, 6, 7],
  },
];
