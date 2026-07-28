import 'dotenv/config';
import { spawn } from 'node:child_process';
import cors from 'cors';
import express from 'express';
import { HLS_DIR, ORIGINALS_DIR, THUMBNAILS_DIR, videosRouter } from './routes/videos.js';
import { foldersRouter } from './routes/folders.js';
import { jobsRouter } from './routes/jobs.js';
import { startJobWorker } from './jobWorker.js';

const PORT = Number(process.env.PORT ?? 4000);
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map(s => s.trim());
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

const app = express();

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// claude CLI の疎通は起動時に一度だけ確認してキャッシュする（health用）
let claudeStatus: 'ok' | 'unavailable' | 'unchecked' = 'unchecked';
function checkClaudeAvailability(): void {
  try {
    const proc = spawn(CLAUDE_BIN, ['--version']);
    proc.on('error', () => { claudeStatus = 'unavailable'; });
    proc.on('exit', code => { claudeStatus = code === 0 ? 'ok' : 'unavailable'; });
  } catch {
    claudeStatus = 'unavailable';
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', claude: claudeStatus });
});

app.use('/api/videos', videosRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/jobs', jobsRouter);
app.use('/hls', express.static(HLS_DIR));
app.use('/thumbnails', express.static(THUMBNAILS_DIR));

app.listen(PORT, () => {
  console.log(`[motion-lab-home-server] listening on :${PORT}`);
  console.log(`  originals: ${ORIGINALS_DIR}`);
  console.log(`  hls:       ${HLS_DIR}`);
  console.log(`  thumbnails:${THUMBNAILS_DIR}`);
  checkClaudeAvailability();
  startJobWorker();
});
