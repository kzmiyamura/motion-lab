/**
 * bachataPatterns.ts — 10-level Bachata rhythm library
 *
 * Grid: 16 steps = 2 bars of 4/4 at 8th-note subdivision
 *   0=beat1  1=and1  2=beat2  3=and2  4=beat3  5=and3
 *   6=beat4(TAP)  7=and4  8=beat5  9=and5  10=beat6  11=and6
 *   12=beat7  13=and7  14=beat8(TAP)  15=and8
 *
 * Articulation:
 *   open    — full resonant hit (low Q, longer decay)
 *   muffled — palm-dampened hit (higher Q, shorter decay, tighter pitch)
 */

export type Articulation = 'open' | 'muffled';

export type BachataSection = 'derecho' | 'majao' | 'mambo';

export type BachataPattern = {
  id: string;
  name: string;
  nameJa: string;
  complexity: number; // 1-10 for display
  bongoLow: number[];
  bongoLowArticulation: Partial<Record<number, Articulation>>;
  bongoHigh: number[];
  bongoHighArticulation: Partial<Record<number, Articulation>>;
  guira: number[];
  bass: number[];
};

export const BACHATA_PATTERNS: readonly BachataPattern[] = [
  // ── 1. Derecho — pure quarter-note pulse, zero syncopation ────────────────
  {
    id: 'derecho',
    name: 'Derecho',
    nameJa: 'ストレート',
    complexity: 1,
    bongoLow:  [0, 2, 4, 6, 8, 10, 12, 14],
    bongoLowArticulation: {},
    bongoHigh: [],
    bongoHighArticulation: {},
    guira: [0, 2, 4, 6, 8, 10, 12, 14],
    bass:  [6, 14],
  },

  // ── 2. Contratiempo — add a single upbeat accent per bar ──────────────────
  {
    id: 'contratiempo',
    name: 'Contratiempo',
    nameJa: '裏拍入り',
    complexity: 2,
    bongoLow:  [0, 2, 4, 6, 8, 10, 12, 14],
    bongoLowArticulation: {},
    bongoHigh: [1, 9],
    bongoHighArticulation: {},
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [6, 14],
  },

  // ── 3. Doble — classic two upbeats per bar (and-of-2, and-of-6) ──────────
  {
    id: 'doble',
    name: 'Doble',
    nameJa: 'ダブル',
    complexity: 3,
    bongoLow:  [0, 2, 4, 6, 8, 10, 12, 14],
    bongoLowArticulation: {},
    bongoHigh: [1, 3, 9, 11],
    bongoHighArticulation: {},
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [6, 14],
  },

  // ── 4. Anticipado — muffled ghost note anticipates beat 4 / 8 ────────────
  {
    id: 'anticipado',
    name: 'Anticipado',
    nameJa: 'アンティシペーション',
    complexity: 4,
    bongoLow:  [0, 2, 5, 6, 8, 10, 13, 14],
    bongoLowArticulation: { 5: 'muffled', 13: 'muffled' },
    bongoHigh: [1, 3, 9, 11],
    bongoHighArticulation: {},
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [6, 14],
  },

  // ── 5. Sincopado — low crosses the beat; high fills off-beats ─────────────
  {
    id: 'sincopado',
    name: 'Sincopado',
    nameJa: 'シンコペーション',
    complexity: 5,
    bongoLow:  [0, 3, 4, 6, 8, 11, 12, 14],
    bongoLowArticulation: { 3: 'muffled', 11: 'muffled' },
    bongoHigh: [1, 5, 9, 13],
    bongoHighArticulation: {},
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [6, 14],
  },

  // ── 6. Media Martillo — half-Martillo; muffled pickups before accents ─────
  {
    id: 'media-martillo',
    name: 'Media Martillo',
    nameJa: 'ハーフ・マルティジョ',
    complexity: 6,
    bongoLow:  [0, 2, 4, 5, 6, 8, 10, 12, 13, 14],
    bongoLowArticulation: { 5: 'muffled', 13: 'muffled' },
    bongoHigh: [1, 3, 7, 9, 11, 15],
    bongoHighArticulation: { 7: 'muffled', 15: 'muffled' },
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [5, 6, 13, 14],
  },

  // ── 7. Martillo Básico — high covers every upbeat; post-tap muffled ───────
  {
    id: 'martillo-basico',
    name: 'Martillo Básico',
    nameJa: 'マルティジョ（基本）',
    complexity: 7,
    bongoLow:  [0, 2, 4, 6, 8, 10, 12, 14],
    bongoLowArticulation: {},
    bongoHigh: [1, 3, 5, 7, 9, 11, 13, 15],
    bongoHighArticulation: { 7: 'muffled', 15: 'muffled' },
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [5, 6, 13, 14],
  },

  // ── 8. Martillo Variación — ghost notes woven into full Martillo ──────────
  {
    id: 'martillo-variacion',
    name: 'Martillo Variación',
    nameJa: 'マルティジョ（バリエーション）',
    complexity: 8,
    bongoLow:  [0, 2, 4, 5, 6, 8, 10, 12, 13, 14],
    bongoLowArticulation: { 5: 'muffled', 13: 'muffled' },
    bongoHigh: [1, 3, 5, 7, 9, 11, 13, 15],
    bongoHighArticulation: { 5: 'muffled', 7: 'muffled', 13: 'muffled', 15: 'muffled' },
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [5, 6, 13, 14],
  },

  // ── 9. Martillo Completo — dense low + full high Martillo ─────────────────
  {
    id: 'martillo-completo',
    name: 'Martillo Completo',
    nameJa: 'マルティジョ（フル）',
    complexity: 9,
    bongoLow:  [0, 2, 3, 4, 6, 8, 10, 11, 12, 14],
    bongoLowArticulation: { 3: 'muffled', 11: 'muffled' },
    bongoHigh: [1, 3, 5, 7, 9, 11, 13, 15],
    bongoHighArticulation: { 7: 'muffled', 15: 'muffled' },
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [5, 6, 13, 14],
  },

  // ── 10. Virtuoso — maximum density; fills every gap with ghost notes ──────
  {
    id: 'virtuoso',
    name: 'Virtuoso',
    nameJa: 'ビルトゥオーゾ',
    complexity: 10,
    bongoLow:  [0, 2, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14],
    bongoLowArticulation: { 3: 'muffled', 5: 'muffled', 11: 'muffled', 13: 'muffled' },
    bongoHigh: [1, 3, 5, 7, 9, 11, 13, 15],
    bongoHighArticulation: { 5: 'muffled', 7: 'muffled', 13: 'muffled', 15: 'muffled' },
    guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    bass:  [5, 6, 13, 14],
  },
];

// ── Section-mode patterns ─────────────────────────────────────────────────────
//
// These are used when the user selects a named section (Derecho / Majao / Mambo)
// rather than the complexity slider.

/**
 * Mambo section: highly syncopated — anticipations on and-of-3 (step 5/13),
 * full Martillo high bongo, dense bass.
 */
export const MAMBO_SECTION_PATTERN = {
  bongoLow:  [0, 3, 5, 6, 8, 11, 13, 14],
  bongoLowArticulation: { 3: 'muffled' as Articulation, 11: 'muffled' as Articulation },
  bongoHigh: [1, 3, 5, 7, 9, 11, 13, 15],
  bongoHighArticulation: { 7: 'muffled' as Articulation, 15: 'muffled' as Articulation },
  guira: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  bass: [5, 6, 13, 14],
} as const;

/** All 16 steps — forced Güira pattern for Majao section */
export const MAJAO_GUIRA_PATTERN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
