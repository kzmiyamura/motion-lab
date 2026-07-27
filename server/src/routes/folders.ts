import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { createFolder, deleteFolder, listFolders, type FolderRow } from '../db.js';

function toPublicFolder(row: FolderRow) {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export const foldersRouter = Router();

foldersRouter.get('/', (_req, res) => {
  res.json({ folders: listFolders().map(toPublicFolder) });
});

foldersRouter.post('/', (req, res) => {
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

foldersRouter.delete('/:id', (req, res) => {
  deleteFolder(req.params.id);
  res.json({ status: 'ok' });
});
