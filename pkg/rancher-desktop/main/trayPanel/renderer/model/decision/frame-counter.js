/**
 * Decision — consecutive frame counter for state transitions.
 *
 * Requires a minimum number of consecutive "active" frames before
 * transitioning to speaking, and a minimum number of consecutive
 * "inactive" frames before transitioning to silence. This prevents
 * single-frame glitches from causing state changes.
 *
 * No DOM access, no view logic — pure decision logic.
 */

// ─── Configuration ──────────────────────────────────────────────

const VOICE_FRAMES_REQUIRED = 6;     // ~100ms at 60fps — filters out transient taps
const SILENCE_FRAMES_REQUIRED = 15;  // Consecutive inactive frames to trigger silence

// ─── State ──────────────────────────────────────────────────────

let speaking = false;
let voiceFrames = 0;
let silenceFrames = 0;

// ─── Decision ───────────────────────────────────────────────────

/**
 * Process hysteresis gate output.
 *
 * @param {boolean} hysteresisActive — true if hysteresis gate is active
 * @returns {{ speaking: boolean, voiceFrames: number, silenceFrames: number }}
 */
function process(hysteresisActive) {
  if (hysteresisActive) {
    voiceFrames++;
    silenceFrames = 0;
  } else {
    silenceFrames++;
    voiceFrames = 0;
  }

  if (!speaking && voiceFrames >= VOICE_FRAMES_REQUIRED) {
    speaking = true;
  } else if (speaking && silenceFrames >= SILENCE_FRAMES_REQUIRED) {
    speaking = false;
  }

  return { speaking, voiceFrames, silenceFrames };
}

/**
 * Get current state without processing.
 */
function getState() {
  return { speaking, voiceFrames, silenceFrames };
}

/**
 * Reset state.
 */
function reset() {
  speaking = false;
  voiceFrames = 0;
  silenceFrames = 0;
}

module.exports = { process, getState, reset };
