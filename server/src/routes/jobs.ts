import { Router } from 'express';
import { getJob, type AnalysisJobRow } from '../db.js';

export function toPublicJob(row: AnalysisJobRow) {
  return {
    id: row.id,
    videoId: row.video_id,
    status: row.status,
    preset: row.preset,
    retryCount: row.retry_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export const jobsRouter = Router();

jobsRouter.get('/:id', (req, res) => {
  const row = getJob(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    ...toPublicJob(row),
    reportMd: row.report_md,
    resultJson: row.result_json,
    specSnapshot: row.spec_snapshot,
  });
});
