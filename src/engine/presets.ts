export type PresetName = 'Standard' | 'Salsa 2-3 Clave' | 'Salsa 3-2 Clave';
export type TotalSteps = 4 | 8 | 16;

export type Preset = {
  totalSteps: TotalSteps;
  /** 音を鳴らす 0-indexed ステップ番号の配列 */
  pattern: number[];
};

/**
 * Salsa クラーベパターン (8ステップ = 1フレーズ、各ステップ = 8分音符)
 *
 * 2-3 Clave: 1,3,5,6,8 拍に hit (0-indexed: 0,2,4,5,7)
 * 3-2 Clave: 2,4,5,7,8 拍に hit (0-indexed: 1,3,4,6,7)
 */
export const PRESETS: Record<PresetName, Preset> = {
  Standard: {
    totalSteps: 4,
    pattern: [0, 1, 2, 3],
  },
  'Salsa 2-3 Clave': {
    totalSteps: 8,
    pattern: [0, 2, 4, 5, 7],
  },
  'Salsa 3-2 Clave': {
    totalSteps: 8,
    pattern: [1, 3, 4, 6, 7],
  },
};
