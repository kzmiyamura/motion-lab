import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { Router } from 'express';

/**
 * 3Dモーションクリップ（prototype_export_clip.py の出力）の配信。
 *
 * クリップは個人の練習動画由来のモーションデータのため、リポジトリの public/ には
 * 置かず、gitignore 済みの storage/lift3d/ からこのルートで配信する。
 * フロントエンドは relay 経由の固定URL（/relay/api/motion/...）で取得する。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LIFT3D_DIR = path.resolve(__dirname, '../../storage/lift3d');

// クリップIDは動画IDの先頭8桁（例: 2fda2815）。ファイル名は <id>_clip.json
const CLIP_ID_RE = /^[0-9a-f]{8}$/;

// manifest.json（任意・手書き）: { "<id>": { "label": "撮影条件などの表示名" } }
async function readManifest(): Promise<Record<string, { label?: string }>> {
  try {
    const raw = await readFile(path.join(LIFT3D_DIR, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as Record<string, { label?: string }>;
  } catch {
    return {};
  }
}

export const motionRouter = Router();

// クリップ一覧。メタ取得のため全読みするが、3本×〜800KB・タブを開いた時しか呼ばれない
motionRouter.get('/', async (_req, res) => {
  try {
    const [names, manifest] = await Promise.all([readdir(LIFT3D_DIR), readManifest()]);
    const clips = [];
    for (const name of names) {
      const m = /^([0-9a-f]{8})_clip\.json$/.exec(name);
      if (!m) continue;
      const id = m[1];
      try {
        const clip = JSON.parse(await readFile(path.join(LIFT3D_DIR, name), 'utf8')) as {
          duration?: number; fps?: number; frames?: unknown[]; events?: unknown[];
        };
        clips.push({
          id,
          label: manifest[id]?.label ?? null,
          duration: clip.duration ?? 0,
          fps: clip.fps ?? 0,
          frameCount: clip.frames?.length ?? 0,
          eventCount: clip.events?.length ?? 0,
        });
      } catch {
        // 壊れたファイルは一覧から黙って除外（配信自体は他のクリップで続行）
      }
    }
    clips.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ clips });
  } catch {
    // ディレクトリ未作成 = クリップ0本として扱う
    res.json({ clips: [] });
  }
});

motionRouter.get('/:id', (req, res) => {
  const id = req.params.id;
  if (!CLIP_ID_RE.test(id)) return res.status(400).json({ error: 'invalid clip id' });
  res.sendFile(path.join(LIFT3D_DIR, `${id}_clip.json`), {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'clip not found' });
  });
});
