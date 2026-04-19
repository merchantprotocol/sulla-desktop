/**
 * Decision — speech density over a sliding window.
 *
 * Tracks the ratio of speaking frames to total frames over a
 * recent window. Classifies the current state as:
 *   - "active-speech" — mostly talking (ratio > 0.6)
 *   - "intermittent"  — some talking, some pauses (0.2–0.6)
 *   - "mostly-silent"  — quiet or background only (< 0.2)
 *
 * No DOM access, no view logic — pure decision logic.
 */

// ─── Configuration ──────────────────────────────────────────────

const WINDOW_SIZE = 60;             // ~1 second at 60fps
const ACTIVE_THRESHOLD = 0.6;
const INTERMITTENT_THRESHOLD = 0.2;

// ─── State ──────────────────────────────────────────────────────

const buffer = [];

// ─── Decision ───────────────────────────────────────────────────

/**
 * Process a frame's speaking state.
 *
 * @param {boolean} isSpeaking — true if frame-counter says speaking
 * @returns {{ ratio: number, classification: string }}
 */
function process(isSpeaking) {
  buffer.push(isSpeaking ? 1 : 0);
  if (buffer.length > WINDOW_SIZE) buffer.shift();

  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i];
  const ratio = sum / buffer.length;

  let classification;
  if (ratio > ACTIVE_THRESHOLD) {
    classification = 'active-speech';
  } else if (ratio > INTERMITTENT_THRESHOLD) {
    classification = 'intermittent';
  } else {
    classification = 'mostly-silent';
  }

  return { ratio, classification };
}

/**
 * Get current state without processing.
 */
function getState() {
  if (buffer.length === 0) return { ratio: 0, classification: 'mostly-silent' };

  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i];
  const ratio = sum / buffer.length;

  let classification;
  if (ratio > ACTIVE_THRESHOLD) {
    classification = 'active-speech';
  } else if (ratio > INTERMITTENT_THRESHOLD) {
    classification = 'intermittent';
  } else {
    classification = 'mostly-silent';
  }

  return { ratio, classification };
}

/**
 * Reset state.
 */
function reset() {
  buffer.length = 0;
}

module.exports = { process, getState, reset };
