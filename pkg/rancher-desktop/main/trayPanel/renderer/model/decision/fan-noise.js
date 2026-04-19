/**
 * Decision — fan/mechanical noise detection.
 *
 * Combines multiple analyzer signals to detect steady mechanical
 * noise (fans, AC, humming electronics). Requires the condition
 * to persist for a minimum number of frames before flagging.
 *
 * Signals checked:
 *   - Noise level is at least moderate (amplitude analyzer)
 *   - Pitch is steady over time (pitch analyzer)
 *   - Temporal variance is low (temporal-variance analyzer)
 *   - Zero-crossing rate is elevated (zero-crossing analyzer)
 *
 * Confidence is 0–1 based on how many signals agree.
 *
 * No DOM access, no view logic — pure decision logic.
 */

// ─── Configuration ──────────────────────────────────────────────

const PERSIST_FRAMES = 30;              // ~500ms at 60fps before flagging
const VARIANCE_LOW_THRESHOLD = 0.0001;  // Below this = "flat" signal
const ZCR_ELEVATED_THRESHOLD = 0.3;     // Above this = elevated ZCR

// ─── State ──────────────────────────────────────────────────────

let detected = false;
let persistCount = 0;
let lastConfidence = 0;

// ─── Decision ───────────────────────────────────────────────────

/**
 * Process cross-signal data from multiple analyzers.
 *
 * @param {{ noiseLevel: string, steadyPitch: boolean, variance: number, smoothedZcr: number }} signals
 * @returns {{ detected: boolean, confidence: number }}
 */
function process(signals) {
  const { noiseLevel, steadyPitch, variance, smoothedZcr } = signals;

  // Score each signal (0 or 1)
  let score = 0;
  let checks = 0;

  // Noise level at least moderate
  checks++;
  if (noiseLevel === 'moderate' || noiseLevel === 'high') score++;

  // Pitch is steady (low stddev across frames)
  checks++;
  if (steadyPitch) score++;

  // Low temporal variance (flat signal)
  checks++;
  if (variance < VARIANCE_LOW_THRESHOLD) score++;

  // Elevated ZCR (noise-like)
  checks++;
  if (smoothedZcr > ZCR_ELEVATED_THRESHOLD) score++;

  lastConfidence = score / checks;

  // Require at least 3 of 4 signals to agree
  const conditionMet = score >= 3;

  if (conditionMet) {
    persistCount++;
  } else {
    persistCount = 0;
  }

  detected = persistCount >= PERSIST_FRAMES;

  return { detected, confidence: lastConfidence };
}

/**
 * Get current state without processing.
 */
function getState() {
  return { detected, confidence: lastConfidence };
}

/**
 * Reset state.
 */
function reset() {
  detected = false;
  persistCount = 0;
  lastConfidence = 0;
}

module.exports = { process, getState, reset };
