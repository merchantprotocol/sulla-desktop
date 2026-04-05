/**
 * View — meter bar rendering.
 *
 * Pure DOM manipulation. Receives level data, updates elements.
 * No business logic, no audio code, no IPC.
 */

const PEAK_DECAY = 0.02;

function levelToPercent(level) {
  return Math.min(100, Math.pow(level, 0.5) * 100);
}

function levelToDb(level) {
  if (level <= 0.0001) return "-\u221E";
  return (20 * Math.log10(level)).toFixed(0) + " dB";
}

function createMeter(barId, peakId, dbId) {
  const bar = document.getElementById(barId);
  const peak = document.getElementById(peakId);
  const dbLabel = document.getElementById(dbId);
  const peakState = { val: 0 };

  return {
    update(level) {
      const pct = levelToPercent(level);
      bar.style.width = pct + "%";
      dbLabel.textContent = levelToDb(level);

      if (pct > peakState.val) {
        peakState.val = pct;
      } else {
        peakState.val = Math.max(0, peakState.val - PEAK_DECAY * 100);
      }
      peak.style.left = peakState.val + "%";
      peak.style.opacity = peakState.val > 1 ? "0.8" : "0";
    },
  };
}

module.exports = { createMeter };
