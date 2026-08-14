import { describe, it, expect } from 'vitest';
import { SAMPLE_FACES, SAMPLE_FACE_BY_ID } from '../engine/sampleFaces';

describe('同梱サンプルの顔（動画から取ったアバター）', () => {
  it('解析済みの3本ぶんが入っている', () => {
    expect(SAMPLE_FACES).toHaveLength(3);
    expect(new Set(SAMPLE_FACES.map((f) => f.id)).size).toBe(3);
    for (const f of SAMPLE_FACES) expect(f.label.length).toBeGreaterThan(0);
  });

  it('FaceLandmarker の 478 点と JPEG テクスチャを持つ', () => {
    for (const f of SAMPLE_FACES) {
      expect(f.avatar.lm.length).toBe(478 * 3);
      expect(f.avatar.w).toBe(f.avatar.h);
      expect(f.avatar.image.startsWith('data:image/jpeg;base64,')).toBe(true);
      // 正規化座標。x,y は 0..1 に収まっている（z は相対深度なので範囲外を許す）
      for (let i = 0; i < f.avatar.lm.length; i += 3) {
        expect(f.avatar.lm[i]).toBeGreaterThanOrEqual(-0.2);
        expect(f.avatar.lm[i]).toBeLessThanOrEqual(1.2);
        expect(f.avatar.lm[i + 1]).toBeGreaterThanOrEqual(-0.2);
        expect(f.avatar.lm[i + 1]).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('id で引ける（無い id は null）', () => {
    for (const f of SAMPLE_FACES) expect(SAMPLE_FACE_BY_ID(f.id)?.label).toBe(f.label);
    expect(SAMPLE_FACE_BY_ID('存在しない')).toBeNull();
  });
});
