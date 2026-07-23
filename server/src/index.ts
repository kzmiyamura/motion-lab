import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { HLS_DIR, ORIGINALS_DIR, THUMBNAILS_DIR, videosRouter } from './routes/videos.js';

const PORT = Number(process.env.PORT ?? 4000);
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map(s => s.trim());

const app = express();

app.use(cors({ origin: CORS_ORIGIN }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/videos', videosRouter);
app.use('/hls', express.static(HLS_DIR));
app.use('/thumbnails', express.static(THUMBNAILS_DIR));

app.listen(PORT, () => {
  console.log(`[motion-lab-home-server] listening on :${PORT}`);
  console.log(`  originals: ${ORIGINALS_DIR}`);
  console.log(`  hls:       ${HLS_DIR}`);
  console.log(`  thumbnails:${THUMBNAILS_DIR}`);
});
