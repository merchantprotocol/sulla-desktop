/**
 * Analyzer — spectral centroid and rolloff.
 *
 * Computes two spectral features from the AnalyserNode's FFT data:
 *   - Centroid: weighted mean frequency (brightness). Speech is typically
 *     0.05–0.15 of Nyquist; noise is more spread.
 *   - Rolloff: frequency below which 85% of energy is concentrated.
 *
 * Both values are normalized to 0–1 relative to Nyquist frequency.
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Configuration ──────────────────────────────────────────────

const ROLLOFF_THRESHOLD = 0.85;  // 85% of spectral energy
const START_BIN = 3;              // Skip DC and sub-bass

// ─── Analysis ───────────────────────────────────────────────────

/**
 * Process one frame of FFT data.
 *
 * @param {AnalyserNode} analyser — the mic's AnalyserNode
 * @returns {{ centroid: number, rolloff: number }}
 */
function process(analyser) {
  if (!analyser) return { centroid: 0, rolloff: 0 };

  const binCount = analyser.frequencyBinCount;
  const freqData = new Float32Array(binCount);
  analyser.getFloatFrequencyData(freqData);  // dB values

  // Convert dB to linear magnitude for weighting
  // dB values from getFloatFrequencyData are typically -100 to 0
  const magnitudes = new Float32Array(binCount);
  for (let i = START_BIN; i < binCount; i++) {
    const db = freqData[i];
    magnitudes[i] = isFinite(db) ? Math.pow(10, db / 20) : 0;
  }

  // Total energy
  let totalEnergy = 0;
  for (let i = START_BIN; i < binCount; i++) {
    totalEnergy += magnitudes[i];
  }

  if (totalEnergy < 1e-10) return { centroid: 0, rolloff: 0 };

  // Spectral centroid: weighted mean of bin indices by magnitude
  let weightedSum = 0;
  for (let i = START_BIN; i < binCount; i++) {
    weightedSum += i * magnitudes[i];
  }
  const centroidBin = weightedSum / totalEnergy;
  const centroid = centroidBin / binCount;  // Normalize to 0–1

  // Spectral rolloff: bin below which ROLLOFF_THRESHOLD of energy sits
  let cumulativeEnergy = 0;
  let rolloffBin = binCount - 1;
  const energyTarget = totalEnergy * ROLLOFF_THRESHOLD;

  for (let i = START_BIN; i < binCount; i++) {
    cumulativeEnergy += magnitudes[i];
    if (cumulativeEnergy >= energyTarget) {
      rolloffBin = i;
      break;
    }
  }
  const rolloff = rolloffBin / binCount;  // Normalize to 0–1

  return { centroid, rolloff };
}

/**
 * Get default state (no processing needed between frames).
 */
function getState() {
  return { centroid: 0, rolloff: 0 };
}

/**
 * Reset (no persistent state to clear).
 */
function reset() {
  // Stateless per-frame — nothing to reset
}

module.exports = { process, getState, reset };
