import { describe, it, expect } from 'vitest';
import { delaunay, buildFaceGeometry, type FaceAvatar } from '../engine/faceAvatar';

/** 三角形の符号なし面積 */
function area(px: Float64Array, py: Float64Array, a: number, b: number, c: number) {
  return Math.abs((px[b] - px[a]) * (py[c] - py[a]) - (px[c] - px[a]) * (py[b] - py[a])) / 2;
}

describe('delaunay', () => {
  it('正方形の4点を2枚の三角形に分ける', () => {
    const px = new Float64Array([0, 1, 1, 0]);
    const py = new Float64Array([0, 0, 1, 1]);
    const tri = delaunay(px, py);
    expect(tri.length).toBe(6);
    let s = 0;
    for (let i = 0; i < tri.length; i += 3) s += area(px, py, tri[i], tri[i + 1], tri[i + 2]);
    expect(s).toBeCloseTo(1, 6);
  });

  it('格子点を隙間なく・重なりなく覆う（面積の合計が凸包に一致）', () => {
    const N = 7;
    const px = new Float64Array(N * N), py = new Float64Array(N * N);
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < N; k++) {
        // 完全な格子は共円になって縮退しやすいので、決定的に少しずらす
        px[i * N + k] = k + ((i * 7 + k * 3) % 5) * 0.01;
        py[i * N + k] = i + ((i * 3 + k * 11) % 5) * 0.01;
      }
    }
    const tri = delaunay(px, py);
    expect(tri.length).toBeGreaterThan(0);
    expect(tri.length % 3).toBe(0);
    for (const idx of tri) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(N * N);
    }
    let s = 0;
    for (let i = 0; i < tri.length; i += 3) s += area(px, py, tri[i], tri[i + 1], tri[i + 2]);
    // 端の点を少しずらしているので厳密な (N-1)^2 にはならない。1% 以内で一致すれば覆えている
    expect(s).toBeGreaterThan((N - 1) * (N - 1) * 0.99);
    expect(s).toBeLessThan((N - 1) * (N - 1) * 1.02);
  });

  it('3点未満は三角形なし', () => {
    expect(delaunay(new Float64Array([0, 1]), new Float64Array([0, 1]))).toEqual([]);
  });
});

describe('buildFaceGeometry', () => {
  // 顔の代わりに格子状のランドマークを置いた合成データ
  const N = 9;
  const lm: number[] = [];
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      lm.push(0.25 + (k / (N - 1)) * 0.5, 0.15 + (i / (N - 1)) * 0.7, -0.02 * Math.sin(k));
    }
  }
  const avatar: FaceAvatar = { image: '', w: 400, h: 600, lm };

  it('顔幅が指定どおりに正規化され、原点まわりに中心が来る', () => {
    const g = buildFaceGeometry(avatar, 0.2);
    const pos = g.getAttribute('position');
    expect(pos.count).toBe(N * N);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i));
      minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i));
    }
    expect(maxX - minX).toBeCloseTo(0.2, 6);
    expect((minX + maxX) / 2).toBeCloseTo(0, 6);
    expect((minY + maxY) / 2).toBeCloseTo(0, 6);
    g.dispose();
  });

  it('UV は 0..1 に収まり、画像の上下が反転している', () => {
    const g = buildFaceGeometry(avatar);
    const uv = g.getAttribute('uv');
    expect(uv.count).toBe(N * N);
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
    }
    // ランドマーク0は画像の上寄り(y=0.15) → three の uv.y は下から測るので大きい側
    expect(uv.getY(0)).toBeCloseTo(1 - 0.15, 6);
    g.dispose();
  });

  it('三角形が張られ、インデックスが頂点数に収まる', () => {
    const g = buildFaceGeometry(avatar);
    const idx = g.getIndex();
    expect(idx).not.toBeNull();
    expect(idx!.count).toBeGreaterThan(0);
    expect(idx!.count % 3).toBe(0);
    for (let i = 0; i < idx!.count; i++) {
      expect(idx!.getX(i)).toBeLessThan(N * N);
    }
    g.dispose();
  });
});
