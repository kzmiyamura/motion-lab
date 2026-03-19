// ダンス練習用おすすめ動画プリセット
// ※ 動画IDは変わることがあります。変更したい場合はこのファイルを編集してください。

export type PresetGenre = 'salsa' | 'bachata';

export interface PresetVideo {
  id: string;      // YouTube 動画ID（11文字）
  title: string;
  artist: string;
  genre: PresetGenre;
  bpm: number;
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
    id: 'hNVG22UJoiA',
    title: 'La Vida Es Un Carnaval',
    artist: 'Celia Cruz',
    genre: 'salsa',
    bpm: 174,
  },
  {
    id: 'Xoz_J1GUcI8',
    title: 'Pedro Navaja',
    artist: 'Rubén Blades',
    genre: 'salsa',
    bpm: 162,
  },
  {
    id: '5NV6Rdv1h3Q',
    title: 'Llorarás',
    artist: "Oscar D'León",
    genre: 'salsa',
    bpm: 156,
  },
  // ── Bachata ────────────────────────────────────────────────────────────
  {
    id: 'xMCPoFEfzwI',
    title: 'Propuesta Indecente',
    artist: 'Romeo Santos',
    genre: 'bachata',
    bpm: 128,
  },
  {
    id: 'YxO1pQGlTR4',
    title: 'Obsesión',
    artist: 'Aventura',
    genre: 'bachata',
    bpm: 124,
  },
  {
    id: 'f4V1QPfXFug',
    title: 'Darte un Beso',
    artist: 'Prince Royce',
    genre: 'bachata',
    bpm: 130,
  },
  {
    id: 'C7dSwSGI0_4',
    title: 'Eres Mía',
    artist: 'Romeo Santos',
    genre: 'bachata',
    bpm: 120,
  },
];
