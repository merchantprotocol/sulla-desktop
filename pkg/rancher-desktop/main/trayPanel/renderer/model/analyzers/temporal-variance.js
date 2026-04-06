/**
 * Analyzer — temporal variance of signal level.
 *
 * Maintains a sliding window of recent RMS values and computes
 * the variance. Speech has high variance (words, pauses, emphasis);
 * steady noise (fan, AC) has near-zero variance.
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Configuration ──────────────────────────────────────────────

const WINDOW_SIZE = 30;  // ~500ms at 60fps

// ─── State ──────────────────────────────────────────────────────

const buffer = [];

// ─── Analysis ───────────────────────────────────────────────────

/**
 * Process a new RMS sample.
 *
 * @param {number} rms — current RMS level (0.0–1.0)
 * @returns {{ variance: number, bufferFull: boolean }}
 */
function process(rms) {
  buffer.push(rms);
  if (buffer.length > WINDOW_SIZE) buffer.shift();

  const bufferFull = buffer.length >= WINDOW_SIZE;

  // Compute mean
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i];
  const mean = sum / buffer.length;

  // Compute variance
  let varSum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const diff = buffer[i] - mean;
    varSum += diff * diff;
  }
  const variance = varSum / buffer.length;

  return { variance, bufferFull };
}

/**
 * Get last computed state without processing.
 */
function getState() {
  if (buffer.length === 0) return { variance: 0, bufferFull: false };

  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i];
  const mean = sum / buffer.length;

  let varSum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const diff = buffer[i] - mean;
    varSum += diff * diff;
  }

  return { variance: varSum / buffer.length, bufferFull: buffer.length >= WINDOW_SIZE };
}

/**
 * Reset all state.
 */
function reset() {
  buffer.length = 0;
}

module.exports = { process, getState, reset };
