/**
 * Detects BPM from an AudioBuffer using onset-strength autocorrelation.
 * Suitable for rhythmic music (salsa/bachata) in the 60–220 BPM range.
 */
export function detectBpm(audioBuffer: AudioBuffer): number {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  // Mix to mono
  const mono = new Float32Array(length);
  for (let c = 0; c < numChannels; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += ch[i] / numChannels;
  }

  // RMS energy in 10 ms frames
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.01));
  const numFrames = Math.floor(length / frameSize);
  const energy = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const base = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const s = mono[base + i] ?? 0;
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / frameSize);
  }

  // Half-wave rectified first-order difference (onset strength)
  const onset = new Float32Array(numFrames);
  for (let f = 1; f < numFrames; f++) {
    onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  }

  // Autocorrelation over the BPM range [60, 220]
  const fps = sampleRate / frameSize; // frames per second
  const minLag = Math.max(1, Math.round(fps * 60 / 220));
  const maxLag = Math.round(fps * 60 / 60);

  let bestLag = minLag;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = numFrames - lag;
    for (let f = 0; f < limit; f++) corr += onset[f] * onset[f + lag];
    corr /= limit; // normalise by overlap
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const bpm = 60 / (bestLag / fps);
  return Math.round(Math.max(60, Math.min(220, bpm)));
}
