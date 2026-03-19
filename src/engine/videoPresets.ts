// ダンス練習用おすすめ動画プリセット
// ※ 動画IDは変わることがあります。変更したい場合はこのファイルを編集してください。

export type PresetGenre = 'salsa' | 'bachata';

export interface PresetVideo {
  id: string;      // YouTube 動画ID（11文字）
  title: string;
  artist: string;
  genre: PresetGenre;
  bpm?: number;    // 不明な場合は省略可
}

export const PRESET_VIDEOS: PresetVideo[] = [
  // ── Salsa ──────────────────────────────────────────────────────────────
  {
    id: 'YnwfTHpnGLY',
    title: 'Vivir Mi Vida',
    artist: 'Marc Anthony',
    genre: 'salsa',
    bpm: 188,
  },
  {
    id: 'A2Jp7uzAEWY',
    title: 'Via',
    artist: 'Donna De Lory',
    genre: 'salsa',
  },
];
