/**
 * Analyzer — zero-crossing rate.
 *
 * Counts the number of sign changes in a time-domain audio buffer
 * and normalizes to a 0–1 range. Maintains a short rolling average
 * for frame-to-frame smoothing.
 *
 * Speech typically has ZCR 0.1–0.4; white noise is higher (>0.5);
 * a low hum is very low (<0.05).
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Configuration ──────────────────────────────────────────────

const SMOOTHING_FRAMES = 5;  // Rolling average window size

// ─── State ──────────────────────────────────────────────────────

const history = [];

// ─── Analysis ───────────────────────────────────────────────────

/**
 * Process a time-domain audio buffer.
 *
 * @param {Float32Array} timeDomainData — raw samples from AnalyserNode
 * @returns {{ zcr: number, smoothedZcr: number }}
 */
function process(timeDomainData) {
  if (!timeDomainData || timeDomainData.length < 2) {
    return { zcr: 0, smoothedZcr: 0 };
  }

  let crossings = 0;
  for (let i = 1; i < timeDomainData.length; i++) {
    if ((timeDomainData[i] >= 0) !== (timeDomainData[i - 1] >= 0)) {
      crossings++;
    }
  }

  const zcr = crossings / (timeDomainData.length - 1);

  // Rolling average
  history.push(zcr);
  if (history.length > SMOOTHING_FRAMES) history.shift();

  let sum = 0;
  for (let i = 0; i < history.length; i++) sum += history[i];
  const smoothedZcr = sum / history.length;

  return { zcr, smoothedZcr };
}

/**
 * Get last computed state without processing.
 */
function getState() {
  const last = history.length > 0 ? history[history.length - 1] : 0;
  let sum = 0;
  for (let i = 0; i < history.length; i++) sum += history[i];
  const smoothedZcr = history.length > 0 ? sum / history.length : 0;
  return { zcr: last, smoothedZcr };
}

/**
 * Reset all state.
 */
function reset() {
  history.length = 0;
}

module.exports = { process, getState, reset };
