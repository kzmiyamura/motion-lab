import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  createFolder, deleteFolder, enqueueAnalysisJob, listFolders, listVideos, type FolderRow,
} from '../db.js';
import { requireWriteToken } from '../auth.js';
import { deleteSpec, readSpec, writeSpec, SpecValidationError } from '../specStore.js';

function toPublicFolder(row: FolderRow) {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export const foldersRouter = Router();

foldersRouter.get('/', (_req, res) => {
  res.json({ folders: listFolders().map(toPublicFolder) });
});

foldersRouter.post('/', requireWriteToken, (req, res) => {
  const name = (req.body?.name as string | undefined)?.trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = randomUUID();
  try {
    createFolder(id, name);
  } catch {
    return res.status(409).json({ error: 'folder name already exists' });
  }
  res.status(201).json({ id, name });
});

foldersRouter.delete('/:id', requireWriteToken, (req, res) => {
  deleteFolder(req.params.id);
  deleteSpec(req.params.id); // 指示書も削除（ジョブ・レポートは動画に紐づくため残す）
  res.json({ status: 'ok' });
});

// --- 解析指示書（spec） ---

foldersRouter.get('/:id/spec', (req, res) => {
  const exists = listFolders().some(f => f.id === req.params.id);
  if (!exists) return res.status(404).json({ error: 'folder not found' });
  try {
    const spec = readSpec(req.params.id);
    if (!spec) return res.status(404).json({ error: 'spec not found' });
    res.json({ markdown: spec.markdown, preset: spec.preset, version: spec.version });
  } catch (e) {
    // 保存後に手動で壊された等。読み出し時は500ではなく内容を返しつつ警告でもよいが、明示エラーにする
    res.status(500).json({ error: e instanceof Error ? e.message : 'spec parse error' });
  }
});

foldersRouter.put('/:id/spec', requireWriteToken, (req, res) => {
  const exists = listFolders().some(f => f.id === req.params.id);
  if (!exists) return res.status(404).json({ error: 'folder not found' });

  const markdown = req.body?.markdown as string | undefined;
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ error: 'markdown is required' });
  }
  try {
    const spec = writeSpec(req.params.id, markdown);
    res.json({ markdown: spec.markdown, preset: spec.preset, version: spec.version });
  } catch (e) {
    if (e instanceof SpecValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

/** フォルダ内の ready 動画すべてを一括再解析（MD更新後に既存動画へ適用する主経路） */
foldersRouter.post('/:id/reanalyze', requireWriteToken, (req, res) => {
  const folderId = req.params.id;
  const exists = listFolders().some(f => f.id === folderId);
  if (!exists) return res.status(404).json({ error: 'folder not found' });

  const spec = readSpec(folderId);
  if (!spec) return res.status(409).json({ error: 'このフォルダに解析指示書がありません' });

  const jobIds = listVideos()
    .filter(v => v.folder_id === folderId && v.status === 'ready')
    .map(v => enqueueAnalysisJob(v.id, folderId, spec.preset, spec.markdown));
  res.status(202).json({ jobIds });
});
