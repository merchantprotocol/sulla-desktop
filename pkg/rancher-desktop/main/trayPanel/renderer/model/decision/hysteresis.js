/**
 * Decision — hysteresis gate for speech state.
 *
 * Prevents rapid flickering between speaking/silence by using
 * separate on/off thresholds. When inactive, requires the higher
 * "on" threshold to activate. When active, stays active until
 * the signal drops below the lower "off" threshold.
 *
 * Consumes isAboveOnThreshold / isAboveOffThreshold from the
 * amplitude analyzer.
 *
 * No DOM access, no view logic — pure decision logic.
 */

// ─── State ──────────────────────────────────────────────────────

let active = false;

// ─── Decision ───────────────────────────────────────────────────

/**
 * Process amplitude threshold flags.
 *
 * @param {boolean} isAboveOn — true if signal exceeds the onset threshold
 * @param {boolean} isAboveOff — true if signal exceeds the offset threshold
 * @returns {{ active: boolean }}
 */
function process(isAboveOn, isAboveOff) {
  if (!active) {
    // Only activate when exceeding the higher threshold
    if (isAboveOn) active = true;
  } else {
    // Only deactivate when dropping below the lower threshold
    if (!isAboveOff) active = false;
  }

  return { active };
}

/**
 * Get current state without processing.
 */
function getState() {
  return { active };
}

/**
 * Reset state.
 */
function reset() {
  active = false;
}

module.exports = { process, getState, reset };
