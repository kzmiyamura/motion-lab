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

/**
 * 小数ビート位置 (1〜8) → 16ステップグリッドの 0-indexed インデックスに変換
 *
 * 16ステップ = 各ビートを「表拍」と「裏拍(and)」に分割
 *   index = (beat - 1) * 2         → 表拍
 *   index = (beat - 1) * 2 + 1    → 裏拍 (frac ≈ 0.5)
 *   frac ≈ 0.3 (Rumba late) は表拍ステップに割り当て（視覚は ClaveBeatGrid で表現）
 *
 * 例: 6.5 → (6-1)*2 + 1 = 11  (6の裏拍)
 *     8.0 → (8-1)*2     = 14  (8の表拍)
 *     8.3 → (8-1)*2     = 14  (Rumba: 8の表拍として扱う)
 */
export function toEngineSteps(positions: number[]): Set<number> {
  return new Set(positions.map(pos => {
    const beat = Math.floor(pos);
    const frac = +(pos - beat).toFixed(2);
    const baseIndex = (beat - 1) * 2;
    return frac >= 0.4 ? baseIndex + 1 : baseIndex;
  }));
}

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
