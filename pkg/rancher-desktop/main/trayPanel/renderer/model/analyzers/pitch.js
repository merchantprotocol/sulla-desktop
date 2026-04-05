/**
 * Analyzer — pitch detection via AMDF.
 *
 * Uses the Average Magnitude Difference Function (AMDF) to estimate
 * fundamental frequency from a time-domain audio buffer. AMDF works
 * better than autocorrelation with short buffers (512 samples).
 *
 * Tracks pitch stability over time: if pitch standard deviation is
 * very low across recent frames, flags as steadyPitch (likely
 * mechanical/fan noise rather than speech).
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Configuration ──────────────────────────────────────────────

const MIN_PITCH_HZ = 80;             // Lowest human pitch to detect
const MAX_PITCH_HZ = 400;            // Highest human pitch to detect
const PITCH_HISTORY_SIZE = 10;        // Frames to track for stability
const STEADY_PITCH_THRESHOLD = 5;    // Hz stddev below this = steady (fan noise)
const AMDF_CLARITY_THRESHOLD = 0.3;  // Minimum dip depth relative to RMS to accept

// ─── State ──────────────────────────────────────────────────────

const pitchHistory = [];

// ─── Analysis ───────────────────────────────────────────────────

/**
 * Process a time-domain audio buffer.
 *
 * @param {Float32Array} timeDomainData — raw samples from AnalyserNode
 * @param {number} sampleRate — audio context sample rate (e.g. 48000)
 * @returns {{ pitch: number|null, steadyPitch: boolean, pitchStdDev: number }}
 */
function process(timeDomainData, sampleRate) {
  if (!timeDomainData || timeDomainData.length < 2 || !sampleRate) {
    return { pitch: null, steadyPitch: false, pitchStdDev: 0 };
  }

  const pitch = detectPitch(timeDomainData, sampleRate);

  // Update pitch history (only store valid detections)
  if (pitch !== null) {
    pitchHistory.push(pitch);
    if (pitchHistory.length > PITCH_HISTORY_SIZE) pitchHistory.shift();
  }

  // Compute pitch stability
  const pitchStdDev = computeStdDev(pitchHistory);
  const steadyPitch = pitchHistory.length >= PITCH_HISTORY_SIZE && pitchStdDev < STEADY_PITCH_THRESHOLD;

  return { pitch, steadyPitch, pitchStdDev };
}

/**
 * AMDF-based pitch detection.
 * Finds the lag with the minimum average magnitude difference
 * within the human voice frequency range.
 */
function detectPitch(data, sampleRate) {
  const len = data.length;

  // Lag range corresponding to pitch range
  const minLag = Math.floor(sampleRate / MAX_PITCH_HZ);
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_PITCH_HZ), len - 1);

  if (maxLag <= minLag || maxLag >= len) return null;

  // Compute RMS for clarity threshold
  let rmsSum = 0;
  for (let i = 0; i < len; i++) rmsSum += data[i] * data[i];
  const rms = Math.sqrt(rmsSum / len);
  if (rms < 0.01) return null;  // Too quiet to detect pitch

  // Compute AMDF for each lag
  let bestLag = -1;
  let bestVal = Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const count = len - lag;
    for (let i = 0; i < count; i++) {
      sum += Math.abs(data[i] - data[i + lag]);
    }
    const avg = sum / count;

    if (avg < bestVal) {
      bestVal = avg;
      bestLag = lag;
    }
  }

  // Reject if the dip isn't clear enough relative to signal level
  if (bestLag < 0 || bestVal > rms * AMDF_CLARITY_THRESHOLD) return null;

  return Math.round(sampleRate / bestLag);
}

function computeStdDev(arr) {
  if (arr.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  const mean = sum / arr.length;
  let varSum = 0;
  for (let i = 0; i < arr.length; i++) {
    const diff = arr[i] - mean;
    varSum += diff * diff;
  }
  return Math.sqrt(varSum / arr.length);
}

/**
 * Get last computed state without processing.
 */
function getState() {
  const pitch = pitchHistory.length > 0 ? pitchHistory[pitchHistory.length - 1] : null;
  const pitchStdDev = computeStdDev(pitchHistory);
  const steadyPitch = pitchHistory.length >= PITCH_HISTORY_SIZE && pitchStdDev < STEADY_PITCH_THRESHOLD;
  return { pitch, steadyPitch, pitchStdDev };
}

/**
 * Reset all state.
 */
function reset() {
  pitchHistory.length = 0;
}

module.exports = { process, getState, reset };
