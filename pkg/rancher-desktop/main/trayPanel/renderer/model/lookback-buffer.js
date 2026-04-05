/**
 * Lookback buffer — ring buffer of recent audio frames.
 *
 * Stores the last N time-domain frames so that when speech onset
 * is detected, the audio leading up to it is not lost. Essential
 * for future STT streaming where you need the start of an utterance.
 *
 * Important: all Float32Arrays are copied on write since the
 * AnalyserNode reuses its internal buffer.
 *
 * No DOM access, no view logic — pure data structure.
 */

// ─── Configuration ──────────────────────────────────────────────

const BUFFER_FRAMES = 30;  // ~500ms at 60fps

// ─── State ──────────────────────────────────────────────────────

const frames = [];  // [{ timeDomainData, rms, speaking, timestamp }]
let writeIndex = 0;
let count = 0;

// ─── API ────────────────────────────────────────────────────────

/**
 * Write a frame to the buffer.
 *
 * @param {Float32Array} timeDomainData — raw audio samples (will be copied)
 * @param {number} rms — RMS level for this frame
 * @param {boolean} speaking — whether VAD considers this frame speech
 */
function write(timeDomainData, rms, speaking) {
  const entry = {
    timeDomainData: new Float32Array(timeDomainData),
    rms,
    speaking,
    timestamp: Date.now(),
  };

  if (frames.length < BUFFER_FRAMES) {
    frames.push(entry);
  } else {
    frames[writeIndex] = entry;
  }

  writeIndex = (writeIndex + 1) % BUFFER_FRAMES;
  if (count < BUFFER_FRAMES) count++;
}

/**
 * Read all buffered frames in chronological order.
 *
 * @returns {Array<{ timeDomainData: Float32Array, rms: number, speaking: boolean, timestamp: number }>}
 */
function read() {
  if (count < BUFFER_FRAMES) {
    return frames.slice(0);
  }

  // Ring buffer: oldest frame is at writeIndex, wrap around
  const result = [];
  for (let i = 0; i < BUFFER_FRAMES; i++) {
    result.push(frames[(writeIndex + i) % BUFFER_FRAMES]);
  }
  return result;
}

/**
 * Get frames from just before speech started.
 * Scans backward from the most recent frame to find the transition
 * from non-speaking to speaking, and returns everything from there.
 *
 * @returns {Array} frames from speech onset, or empty if no speech found
 */
function getSpeechOnset() {
  const ordered = read();
  if (ordered.length === 0) return [];

  // Find the last transition from non-speaking to speaking
  let onsetIndex = -1;
  for (let i = ordered.length - 1; i > 0; i--) {
    if (ordered[i].speaking && !ordered[i - 1].speaking) {
      onsetIndex = i - 1;  // Include the frame just before speech
      break;
    }
  }

  if (onsetIndex < 0) {
    // No transition found — if the last frame is speaking, return all
    return ordered[ordered.length - 1].speaking ? ordered : [];
  }

  return ordered.slice(onsetIndex);
}

/**
 * Get buffer status.
 */
function getState() {
  const ordered = count > 0 ? read() : [];
  return {
    frameCount: count,
    oldestTimestamp: ordered.length > 0 ? ordered[0].timestamp : null,
    newestTimestamp: ordered.length > 0 ? ordered[ordered.length - 1].timestamp : null,
  };
}

/**
 * Reset the buffer.
 */
function reset() {
  frames.length = 0;
  writeIndex = 0;
  count = 0;
}

module.exports = { write, read, getSpeechOnset, getState, reset };
