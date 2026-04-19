/**
 * Model — audio feedback detection.
 *
 * Detects feedback loops by finding sustained tonal peaks in the
 * mic's FFT spectrum. Feedback produces a strong, narrow peak at
 * a specific frequency that persists for hundreds of milliseconds.
 *
 * Requires an AnalyserNode — call process() with it each frame.
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Configuration ──────────────────────────────────────────────

const PEAK_THRESHOLD_DB = 15;        // dB above average to qualify as a peak
const SUSTAIN_FRAMES = 20;           // Frames (~330ms at 60fps) a peak must persist
const FREQUENCY_TOLERANCE_BINS = 2;  // Bins of drift allowed for "same" peak
const MAX_TRACKED_PEAKS = 8;         // Max simultaneous peaks to track
const COOLDOWN_FRAMES = 60;          // After feedback clears, wait before re-triggering

// ─── State ──────────────────────────────────────────────────────

let trackedPeaks = [];  // [{ bin, count, frequency }]
let feedbackDetected = false;
let feedbackFrequency = null;
let cooldownRemaining = 0;
let callback = null;
let sampleRate = 48000;

// ─── Analysis ───────────────────────────────────────────────────

/**
 * Process one frame of FFT data from the mic analyser.
 * Call this every frame from the poll loop.
 *
 * @param {AnalyserNode} analyser — the mic's AnalyserNode
 * @returns {{ feedbackDetected: boolean, feedbackFrequency: number|null }}
 */
function process(analyser) {
  if (!analyser) return getState();

  sampleRate = analyser.context?.sampleRate || 48000;
  const binCount = analyser.frequencyBinCount;
  const freqData = new Float32Array(binCount);
  analyser.getFloatFrequencyData(freqData);  // dB values

  // Compute average energy (ignoring very low bins which are often DC/rumble)
  const startBin = 3;  // Skip DC and sub-bass
  let sum = 0;
  let count = 0;
  for (let i = startBin; i < binCount; i++) {
    if (isFinite(freqData[i])) {
      sum += freqData[i];
      count++;
    }
  }
  const avgDB = count > 0 ? sum / count : -100;

  // Find peaks: bins significantly above the average
  const currentPeaks = [];
  for (let i = startBin; i < binCount - 1; i++) {
    const db = freqData[i];
    if (!isFinite(db)) continue;

    // Must be above threshold AND a local maximum
    if (db - avgDB > PEAK_THRESHOLD_DB &&
        db >= freqData[i - 1] &&
        db >= freqData[i + 1]) {
      currentPeaks.push({
        bin:       i,
        db,
        frequency: binToFrequency(i, binCount),
      });
    }
  }

  // Sort by energy (strongest first), limit tracked count
  currentPeaks.sort((a, b) => b.db - a.db);
  const topPeaks = currentPeaks.slice(0, MAX_TRACKED_PEAKS);

  // Match current peaks to tracked peaks (within tolerance)
  const newTracked = [];

  for (const peak of topPeaks) {
    const match = trackedPeaks.find(
      (t) => Math.abs(t.bin - peak.bin) <= FREQUENCY_TOLERANCE_BINS,
    );

    if (match) {
      // Existing peak — increment sustain count
      newTracked.push({
        bin:       peak.bin,
        count:     match.count + 1,
        frequency: peak.frequency,
      });
    } else {
      // New peak — start tracking
      newTracked.push({
        bin:       peak.bin,
        count:     1,
        frequency: peak.frequency,
      });
    }
  }

  trackedPeaks = newTracked;

  // Check for feedback: any peak sustained long enough?
  const prevDetected = feedbackDetected;

  if (cooldownRemaining > 0) {
    cooldownRemaining--;
    feedbackDetected = false;
    feedbackFrequency = null;
  } else {
    const sustained = trackedPeaks.find((p) => p.count >= SUSTAIN_FRAMES);
    if (sustained) {
      feedbackDetected = true;
      feedbackFrequency = sustained.frequency;
    } else {
      if (feedbackDetected) {
        // Feedback just cleared — start cooldown
        cooldownRemaining = COOLDOWN_FRAMES;
      }
      feedbackDetected = false;
      feedbackFrequency = null;
    }
  }

  const result = getState();

  // Only fire callback on state change
  if (callback && feedbackDetected !== prevDetected) {
    callback(result);
  }

  return result;
}

function binToFrequency(bin, binCount) {
  return Math.round((bin * sampleRate) / (binCount * 2));
}

/**
 * Set a callback for feedback state changes.
 * @param {function} cb — called with { feedbackDetected, feedbackFrequency }
 */
function onChange(cb) {
  callback = cb;
}

/**
 * Reset all state (call when mic stops).
 */
function reset() {
  trackedPeaks = [];
  feedbackDetected = false;
  feedbackFrequency = null;
  cooldownRemaining = 0;
}

/**
 * Get current state without processing a new frame.
 */
function getState() {
  return { feedbackDetected, feedbackFrequency };
}

module.exports = { process, onChange, reset, getState };
