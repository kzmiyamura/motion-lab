import ffmpeg from 'fluent-ffmpeg';
import ffmpegPathImport from 'ffmpeg-static';
import ffprobeStaticImport from 'ffprobe-static';
import { existsSync, mkdirSync } from 'node:fs';

// ffmpeg-static/ffprobe-static は CJS モジュールで default export が string 型。
// NodeNext moduleResolution 下では default import の型解決が正しく効かないためキャストする。
const ffmpegPath = ffmpegPathImport as unknown as string | null;
const ffprobePath = (ffprobeStaticImport as unknown as { path: string }).path;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

export interface ConvertResult {
  durationSec: number;
  hlsPlaylistPath: string;
  thumbnailPath: string;
}

function probeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

function toHls(inputPath: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-hls_time 6',
        '-hls_playlist_type vod',
        `-hls_segment_filename ${outDir}/segment_%03d.ts`,
      ])
      .output(`${outDir}/playlist.m3u8`)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

function extractThumbnail(inputPath: string, durationSec: number, outDir: string, filename: string): Promise<void> {
  const seekSec = Math.min(Math.max(durationSec * 0.1, 1), Math.max(durationSec - 0.5, 1));
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(seekSec)
      .frames(1)
      .output(`${outDir}/${filename}`)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

/** 元動画を HLS + サムネイルに変換する。出力先ディレクトリは呼び出し元で作成済みの想定。 */
export async function convertVideo(
  inputPath: string,
  hlsOutDir: string,
  thumbnailOutDir: string,
  id: string,
): Promise<ConvertResult> {
  if (!existsSync(hlsOutDir)) mkdirSync(hlsOutDir, { recursive: true });
  if (!existsSync(thumbnailOutDir)) mkdirSync(thumbnailOutDir, { recursive: true });

  const durationSec = await probeDuration(inputPath);
  await toHls(inputPath, hlsOutDir);
  const thumbnailFilename = `${id}.jpg`;
  await extractThumbnail(inputPath, durationSec, thumbnailOutDir, thumbnailFilename);

  return {
    durationSec,
    hlsPlaylistPath: `${hlsOutDir}/playlist.m3u8`,
    thumbnailPath: `${thumbnailOutDir}/${thumbnailFilename}`,
  };
}
