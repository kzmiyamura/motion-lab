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

  // Autocorrelation over the target BPM range [80, 220]
  // (covers both bachata 80–150 and salsa 140–220; excludes sub-harmonic artifacts)
  const fps = sampleRate / frameSize; // frames per second
  const minLag = Math.max(1, Math.round(fps * 60 / 220));
  const maxLag = Math.round(fps * 60 / 80);

  // Build correlation scores for all lags in range
  const corrScores = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = numFrames - lag;
    for (let f = 0; f < limit; f++) corr += onset[f] * onset[f + lag];
    corrScores[lag] = corr / limit;
  }

  // Find best lag, with harmonic weighting:
  // boost each candidate by the strength of its 2x and 3x sub-harmonics
  // (higher-BPM candidates gain extra score if their multiples are also strong)
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = corrScores[lag];
    // Add fraction of sub-harmonic strengths to prefer the "true" beat over a slow multiple
    for (const divisor of [2, 3]) {
      const subLag = Math.round(lag / divisor);
      if (subLag >= minLag && subLag <= maxLag) {
        score += corrScores[subLag] * (0.4 / divisor);
      }
    }
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }

  const bpm = 60 / (bestLag / fps);
  return Math.round(Math.max(80, Math.min(220, bpm)));
}
