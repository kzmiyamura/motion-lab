export type BpmCategory = {
  id: string;
  label: string;
  sublabel: string;     // ジャンル名
  range: [number, number]; // [min, max] — max が Infinity = 超高速
  defaultBpm: number;   // カテゴリ選択時にセットされる代表 BPM
  feel: string;         // ダンサーの感覚
};

export const BPM_CATEGORIES: BpmCategory[] = [
  {
    id: 'slow',
    label: 'スロー',
    sublabel: 'Salsa Romantica',
    range: [140, 165],
    defaultBpm: 150,
    feel: 'ゆったり踊れる。初心者やムーディーな曲に多い。',
  },
  {
    id: 'medium',
    label: 'ミディアム',
    sublabel: '標準的',
    range: [166, 195],
    defaultBpm: 180,
    feel: '最も一般的。心地よい疾走感があり、多くのソーシャルダンスはこの域。',
  },
  {
    id: 'fast',
    label: 'ファスト',
    sublabel: 'Salsa Dura / Timba',
    range: [196, 225],
    defaultBpm: 210,
    feel: 'かなり速い。プロのパフォーマンスや楽器演奏が激しい曲。',
  },
  {
    id: 'ultra',
    label: '超高速',
    sublabel: 'Shine / 競技',
    range: [226, Infinity],
    defaultBpm: 240,
    feel: 'フットワーク（シャイン）の練習用や競技会レベル。',
  },
];

/** 現在の BPM が属するカテゴリ ID を返す。どれにも該当しない場合は null。 */
export function getActiveCategoryId(bpm: number): string | null {
  return BPM_CATEGORIES.find(c => bpm >= c.range[0] && bpm <= c.range[1])?.id ?? null;
}
