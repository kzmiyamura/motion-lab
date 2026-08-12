import * as THREE from 'three';

/**
 * 写真から「顔つきアバター」を作る。
 *
 * MediaPipe FaceLandmarker が返す 478 点をそのまま頂点にして、**同じ点の画像座標を UV に使う**。
 * つまり写真が顔の形にぴったり貼られる — 正準モデルの UV テーブルも外部サービスも要らない。
 * 三角形は 2D 投影上の Delaunay 分割で自前生成する（tasks-vision が公開しているのは
 * 三角形リストではなく辺の接続リストなので、そこから起こすより素直で結果も安定する）。
 *
 * 写真はブラウザ内で処理して localStorage に持つだけで、どこへも送信しない。
 */

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** 検出結果。これだけあれば顔メッシュを再構成できる（localStorage に入る大きさ） */
export type FaceAvatar = {
  image: string;   // 縮小した写真の data URL（テクスチャ）
  w: number;       // その写真のピクセル幅（landmark の正規化を戻すのに要る）
  h: number;
  lm: number[];    // x,y,z の平坦配列。x,y は 0..1、z は x と同スケールの相対深度
};

const MAX_SIDE = 512;  // 検出にも見た目にも十分で、localStorage に収まる大きさ

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let landmarkerPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getLandmarker(): Promise<any> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      // tasks-vision は exports 形式が非標準なので usePoseEstimation と同じ書き方で読む
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { FilesetResolver, FaceLandmarker } =
        await import('@mediapipe/tasks-vision' as any) as any;
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
      });
    })().catch((e) => { landmarkerPromise = null; throw e; });
  }
  return landmarkerPromise;
}

/** 写真ファイル → FaceAvatar。顔が写っていなければ例外 */
export async function detectFace(file: File): Promise<FaceAvatar> {
  // EXIF の回転を反映させる（スマホ写真は横倒しで入ってくることがある）
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('canvas を作れませんでした');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const lmk = await getLandmarker();
  const res = lmk.detect(cv);
  const face = res?.faceLandmarks?.[0] as { x: number; y: number; z: number }[] | undefined;
  if (!face?.length) {
    throw new Error('顔が見つかりませんでした（正面に近い、顔が大きく写った写真を選んでください）');
  }
  const lm: number[] = [];
  for (const p of face) lm.push(p.x, p.y, p.z);
  return { image: cv.toDataURL('image/jpeg', 0.85), w, h, lm };
}

// ── Delaunay 三角形分割（Bowyer-Watson）─────────────────────────────────
// 顔は正面投影すればほぼ凸なので、素直な実装で破綻しない。478点なので一度きりの O(n²) で足りる

type Tri = { a: number; b: number; c: number; cx: number; cy: number; r2: number };

function circumTri(
  a: number, b: number, c: number, px: Float64Array, py: Float64Array,
): Tri | null {
  const ax = px[a], ay = py[a], bx = px[b], by = py[b], cx0 = px[c], cy0 = py[c];
  const d = 2 * (ax * (by - cy0) + bx * (cy0 - ay) + cx0 * (ay - by));
  if (Math.abs(d) < 1e-12) return null; // 一直線上
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx0 * cx0 + cy0 * cy0;
  const ux = (a2 * (by - cy0) + b2 * (cy0 - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx0 - bx) + b2 * (ax - cx0) + c2 * (bx - ax)) / d;
  return { a, b, c, cx: ux, cy: uy, r2: (ux - ax) ** 2 + (uy - ay) ** 2 };
}

/** 2D 点群 → 三角形の頂点インデックス列 */
export function delaunay(px: Float64Array, py: Float64Array): number[] {
  const n = px.length;
  if (n < 3) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (px[i] < minX) minX = px[i];
    if (px[i] > maxX) maxX = px[i];
    if (py[i] < minY) minY = py[i];
    if (py[i] > maxY) maxY = py[i];
  }
  const dmax = Math.max(maxX - minX, maxY - minY) || 1;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;

  // 全点を含む巨大三角形を n, n+1, n+2 番として足す
  const ex = new Float64Array(n + 3), ey = new Float64Array(n + 3);
  ex.set(px); ey.set(py);
  ex[n] = mx - 20 * dmax; ey[n] = my - dmax;
  ex[n + 1] = mx; ey[n + 1] = my + 20 * dmax;
  ex[n + 2] = mx + 20 * dmax; ey[n + 2] = my - dmax;

  const first = circumTri(n, n + 1, n + 2, ex, ey);
  if (!first) return [];
  let tris: Tri[] = [first];

  for (let i = 0; i < n; i++) {
    const keep: Tri[] = [];
    const edges: number[] = []; // [a,b, a,b, ...]
    for (const t of tris) {
      const dx = ex[i] - t.cx, dy = ey[i] - t.cy;
      if (dx * dx + dy * dy <= t.r2) {
        edges.push(t.a, t.b, t.b, t.c, t.c, t.a); // 外接円に入る = この点で作り直す
      } else {
        keep.push(t);
      }
    }
    // 2回出てくる辺は内部の辺。境界（1回だけの辺）だけ残して新しい三角形を張る
    const m = edges.length / 2;
    const dup = new Uint8Array(m);
    for (let p = 0; p < m; p++) {
      if (dup[p]) continue;
      for (let q = p + 1; q < m; q++) {
        if (dup[q]) continue;
        if ((edges[p * 2] === edges[q * 2 + 1] && edges[p * 2 + 1] === edges[q * 2])
          || (edges[p * 2] === edges[q * 2] && edges[p * 2 + 1] === edges[q * 2 + 1])) {
          dup[p] = 1; dup[q] = 1; break;
        }
      }
    }
    for (let p = 0; p < m; p++) {
      if (dup[p]) continue;
      const t = circumTri(edges[p * 2], edges[p * 2 + 1], i, ex, ey);
      if (t) keep.push(t);
    }
    tris = keep;
  }

  const out: number[] = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue; // 巨大三角形由来を捨てる
    out.push(t.a, t.b, t.c);
  }
  return out;
}

/**
 * FaceAvatar → three のジオメトリ。顔幅が `faceWidth`[m] になるよう正規化し、
 * 顔が +Z（体の前方）を向く座標に置く。
 */
export function buildFaceGeometry(a: FaceAvatar, faceWidth = 0.175): THREE.BufferGeometry {
  const n = a.lm.length / 3;
  // 正規化座標のままだと縦横比が崩れるのでピクセル空間へ戻す
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let i = 0; i < n; i++) { px[i] = a.lm[i * 3] * a.w; py[i] = a.lm[i * 3 + 1] * a.h; }
  const index = delaunay(px, py);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (px[i] < minX) minX = px[i];
    if (px[i] > maxX) maxX = px[i];
    if (py[i] < minY) minY = py[i];
    if (py[i] > maxY) maxY = py[i];
  }
  const s = faceWidth / Math.max(1e-6, maxX - minX);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    // カメラに向いた人を撮ると、本人の左が画像の右に写る。three では +X が本人の左
    pos[i * 3] = (px[i] - cx) * s;
    pos[i * 3 + 1] = -(py[i] - cy) * s;          // 画像の y は下向き
    pos[i * 3 + 2] = -a.lm[i * 3 + 2] * a.w * s; // z は手前ほど小さい → 前方 +Z へ反転
    uv[i * 2] = a.lm[i * 3];
    uv[i * 2 + 1] = 1 - a.lm[i * 3 + 1];         // three のテクスチャ原点は左下
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// ── 保存（写真は端末から出さない）────────────────────────────────────────
const KEY = 'motionlab.faceAvatar.v1';
export type FaceSlots = { leader: FaceAvatar | null; follower: FaceAvatar | null };
export const EMPTY_FACES: FaceSlots = { leader: null, follower: null };

export function loadFaces(): FaceSlots {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_FACES;
    const v = JSON.parse(raw) as Partial<FaceSlots>;
    return { leader: v.leader ?? null, follower: v.follower ?? null };
  } catch {
    return EMPTY_FACES;
  }
}

export function saveFaces(f: FaceSlots) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    // 容量超過などは黙って諦める（この場のセッションでは使えている）
  }
}
