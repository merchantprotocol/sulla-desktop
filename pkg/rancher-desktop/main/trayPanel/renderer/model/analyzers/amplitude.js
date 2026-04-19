/**
 * Analyzer — amplitude tracking with hysteresis.
 *
 * Tracks RMS level, estimates ambient noise floor, classifies noise level,
 * and provides dual thresholds for speech onset/offset (hysteresis).
 *
 * Replaces the standalone noise-detection model with richer output
 * suitable for the VAD decision pipeline.
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Configuration ──────────────────────────────────────────────

const FLOOR_DECAY = 0.995;          // Slow rise of noise floor (adapts to sustained noise)
const FLOOR_ATTACK = 0.3;           // Fast drop when environment gets quieter
const FLOOR_MIN = 0.0001;           // Minimum noise floor to avoid stuck-at-zero

const SPEECH_ON_DB = 10;            // dB above floor to trigger speech (onset)
const SPEECH_OFF_DB = 6;            // dB above floor to release speech (offset)

const NOISE_MODERATE_RMS = 0.015;   // Noise floor RMS above this = "moderate"
const NOISE_HIGH_RMS = 0.05;        // Noise floor RMS above this = "high"

// ─── State ──────────────────────────────────────────────────────

let noiseFloor = 0;
let initialized = false;

// ─── Analysis ───────────────────────────────────────────────────

/**
 * Process a new RMS sample.
 *
 * @param {number} rms — current RMS level (0.0–1.0, pre-scaled)
 * @returns {{ rms: number, noiseFloor: number, aboveFloorDB: number, noiseLevel: string, isAboveOnThreshold: boolean, isAboveOffThreshold: boolean }}
 */
function process(rms) {
  // Initialise noise floor to first reading
  if (!initialized) {
    noiseFloor = rms;
    initialized = true;
  }

  // Update noise floor estimate
  if (rms < noiseFloor) {
    noiseFloor = noiseFloor * (1 - FLOOR_ATTACK) + rms * FLOOR_ATTACK;
  } else {
    noiseFloor = noiseFloor * FLOOR_DECAY + rms * (1 - FLOOR_DECAY);
  }

  if (noiseFloor < FLOOR_MIN) noiseFloor = FLOOR_MIN;

  // Compute dB above noise floor
  const floorDB = 20 * Math.log10(noiseFloor + 1e-10);
  const currentDB = 20 * Math.log10(rms + 1e-10);
  const aboveFloorDB = currentDB - floorDB;

  // Dual thresholds for hysteresis (decision module consumes these)
  const isAboveOnThreshold = aboveFloorDB > SPEECH_ON_DB;
  const isAboveOffThreshold = aboveFloorDB > SPEECH_OFF_DB;

  // Classify noise level
  let noiseLevel;
  if (noiseFloor > NOISE_HIGH_RMS) {
    noiseLevel = 'high';
  } else if (noiseFloor > NOISE_MODERATE_RMS) {
    noiseLevel = 'moderate';
  } else {
    noiseLevel = 'low';
  }

  return { rms, noiseFloor, aboveFloorDB, noiseLevel, isAboveOnThreshold, isAboveOffThreshold };
}

/**
 * Get last computed state without processing.
 */
function getState() {
  return { rms: 0, noiseFloor, aboveFloorDB: 0, noiseLevel: 'low', isAboveOnThreshold: false, isAboveOffThreshold: false };
}

/**
 * Reset all state (call when capture stops).
 */
function reset() {
  noiseFloor = 0;
  initialized = false;
}

module.exports = { process, getState, reset };
