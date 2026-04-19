/**
 * Model — background noise detection.
 *
 * Estimates the ambient noise floor from an AnalyserNode and provides:
 *   - noiseFloor: rolling minimum RMS (background noise level)
 *   - isSpeaking: true when current level is significantly above noise floor
 *   - noiseLevel: "low" | "moderate" | "high" classification
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Configuration ──────────────────────────────────────────────

const FLOOR_WINDOW_MS = 3000;       // Sliding window for noise floor estimation
const FLOOR_DECAY = 0.995;          // Slow rise of noise floor (adapts to sustained noise)
const FLOOR_ATTACK = 0.3;           // Fast drop when environment gets quieter
const SPEECH_THRESHOLD_DB = 10;     // dB above noise floor to count as speech
const SPEECH_HOLD_FRAMES = 8;       // Frames to hold "speaking" state after signal drops
const NOISE_MODERATE_RMS = 0.015;   // Noise floor RMS above this = "moderate"
const NOISE_HIGH_RMS = 0.05;        // Noise floor RMS above this = "high"

// ─── State ──────────────────────────────────────────────────────

let noiseFloor = 0;
let isSpeaking = false;
let speechHoldCount = 0;
let noiseLevel = 'low';
let initialized = false;
let callback = null;

// ─── Analysis ───────────────────────────────────────────────────

/**
 * Process a new RMS sample from the mic analyser.
 * Call this every frame from the poll loop.
 *
 * @param {number} rms — current RMS level (0.0–1.0, pre-scaled)
 * @returns {{ noiseFloor: number, isSpeaking: boolean, noiseLevel: string }}
 */
function process(rms) {
  // Initialise noise floor to first reading
  if (!initialized) {
    noiseFloor = rms;
    initialized = true;
  }

  // Update noise floor estimate:
  // - If current level is below floor, drop quickly (environment got quieter)
  // - If current level is above floor, rise slowly (adapts to sustained noise)
  if (rms < noiseFloor) {
    noiseFloor = noiseFloor * (1 - FLOOR_ATTACK) + rms * FLOOR_ATTACK;
  } else {
    noiseFloor = noiseFloor * FLOOR_DECAY + rms * (1 - FLOOR_DECAY);
  }

  // Clamp floor to a minimum so we don't get stuck at zero
  if (noiseFloor < 0.0001) noiseFloor = 0.0001;

  // Speech detection: is current RMS significantly above noise floor?
  const floorDB = 20 * Math.log10(noiseFloor + 1e-10);
  const currentDB = 20 * Math.log10(rms + 1e-10);
  const aboveFloor = currentDB - floorDB;

  if (aboveFloor > SPEECH_THRESHOLD_DB) {
    isSpeaking = true;
    speechHoldCount = SPEECH_HOLD_FRAMES;
  } else if (speechHoldCount > 0) {
    speechHoldCount--;
  } else {
    isSpeaking = false;
  }

  // Classify noise level
  if (noiseFloor > NOISE_HIGH_RMS) {
    noiseLevel = 'high';
  } else if (noiseFloor > NOISE_MODERATE_RMS) {
    noiseLevel = 'moderate';
  } else {
    noiseLevel = 'low';
  }

  const result = { noiseFloor, isSpeaking, noiseLevel };

  if (callback) callback(result);
  return result;
}

/**
 * Set a callback for state changes.
 * @param {function} cb — called with { noiseFloor, isSpeaking, noiseLevel }
 */
function onChange(cb) {
  callback = cb;
}

/**
 * Reset all state (call when mic stops).
 */
function reset() {
  noiseFloor = 0;
  isSpeaking = false;
  speechHoldCount = 0;
  noiseLevel = 'low';
  initialized = false;
}

/**
 * Get current state without processing a new sample.
 */
function getState() {
  return { noiseFloor, isSpeaking, noiseLevel };
}

module.exports = { process, onChange, reset, getState };
