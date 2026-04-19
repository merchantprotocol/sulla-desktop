/**
 * @module trayPanel/renderer/model/vad
 *
 * # Voice Activity Detection Orchestrator
 *
 * This is the **core speech detection engine** that powers all mic-based
 * features in Sulla Desktop. Every component that needs to know "is the
 * user speaking?" relies on this module's output — it is the single source
 * of truth for speech/silence classification.
 *
 * ## Why this exists (instead of a simple threshold)
 *
 * A naive RMS threshold triggers on keyboard taps, desk bumps, fan noise,
 * and HVAC hum. This orchestrator uses a **multi-stage pipeline** to
 * distinguish real speech from transient and steady-state noise:
 *
 * ## Pipeline
 *
 * ```
 * Raw audio (Float32 time-domain) from AnalyserNode
 *   → Stage 1: Signal Analyzers (run in parallel)
 *       amplitude   — RMS, adaptive noise floor, dB above floor
 *       zeroCrossing — ZCR (speech is low; taps/noise are high)
 *       temporalVariance — sustained energy = speech; transients = taps
 *       pitch       — autocorrelation pitch detection (80–400 Hz = voice)
 *       spectral    — FFT centroid + rolloff (speech energy is low-frequency)
 *   → Gate: suppress non-speech before decision
 *       RMS > RMS_GATE, variance > VARIANCE_GATE, ZCR < ZCR_MAX, centroid < CENTROID_MAX
 *   → Stage 2: Decision Logic
 *       hysteresis  — dual threshold (on/off) prevents rapid toggling
 *       frameCounter — N consecutive frames required to change state
 *       silenceRatio — long-term speaking/silence ratio
 *       fanNoise    — cross-signal steady-pitch + low-variance = mechanical noise
 *   → Stage 3: Lookback Buffer
 *       circular buffer of recent audio + speaking state for context
 * ```
 *
 * ## Output
 *
 * The `process()` function returns a state object with:
 * - `speaking` (boolean) — the final speech/silence decision
 * - `fanNoise` (boolean) — mechanical noise detected
 * - `noiseFloor` (number) — adaptive noise floor RMS
 * - `noiseLevel` (string) — 'low' | 'moderate' | 'high'
 * - Full sub-state for each analyzer (amplitude, zeroCrossing, pitch, etc.)
 *
 * This state is broadcast to all windows via `audio-driver:mic-vad` IPC
 * by the tray panel controller.
 *
 * ## Integration
 *
 * Do NOT call this module directly from outside the tray panel renderer.
 * Use `AudioDriverClient.on('vad', ...)` or `useAudioDriver().speaking`
 * to consume VAD state from any window.
 *
 * No DOM access, no view logic — pure signal analysis and orchestration.
 */

// ─── Analyzers ──────────────────────────────────────────────────

const amplitude = require('./analyzers/amplitude');
const pitch = require('./analyzers/pitch');
const spectral = require('./analyzers/spectral');
const temporalVariance = require('./analyzers/temporal-variance');
const zeroCrossing = require('./analyzers/zero-crossing');

// ─── Decision modules ───────────────────────────────────────────

const fanNoise = require('./decision/fan-noise');
const frameCounter = require('./decision/frame-counter');
const hysteresis = require('./decision/hysteresis');
const silenceRatio = require('./decision/silence-ratio');

// ─── Buffer ─────────────────────────────────────────────────────

const lookbackBuffer = require('./lookback-buffer');

// ─── State ──────────────────────────────────────────────────────

const log = window.audioDriver.log;

let lastSpeaking = false;
let lastFanNoise = false;
let callback = null;

// Cached sub-states for getState() between process() calls
let cachedState = null;

// ─── Configuration ──────────────────────────────────────────────
// These thresholds gate the decision pipeline. A signal must pass ALL
// gates to be considered speech. Values are tuned for typical desktop
// microphones at arm's length.

/** Minimum RMS to even consider speech. Below this = silence/noise floor. */
const RMS_GATE = 0.005;
/** Minimum temporal variance — speech sustains energy; taps/bumps don't. */
const VARIANCE_GATE = 0.0001;
/** Maximum zero-crossing rate for speech. Taps and noise have higher ZCR. */
const SPEECH_ZCR_MAX = 0.15;
/** Maximum spectral centroid for speech. Voice energy is concentrated low. */
const SPEECH_CENTROID_MAX = 0.20;

// ─── Orchestration ──────────────────────────────────────────────

/**
 * Process one frame of audio data through the full pipeline.
 *
 * @param {number} rms — pre-computed RMS level (0.0–1.0)
 * @param {AnalyserNode} analyser — the mic's AnalyserNode
 * @returns {object} full VAD state
 */
function process(rms, analyser) {
  // Read time-domain data once (shared across analyzers that need it)
  let timeDomainData = null;
  let sampleRate = 48000;

  if (analyser) {
    timeDomainData = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeDomainData);
    sampleRate = analyser.context?.sampleRate || 48000;
  }

  // ── Stage 1: Signal analyzers ──────────────────────────────

  const amp = amplitude.process(rms);
  const zcr = timeDomainData
    ? zeroCrossing.process(timeDomainData)
    : zeroCrossing.getState();
  const tvar = temporalVariance.process(rms);
  const pit = timeDomainData
    ? pitch.process(timeDomainData, sampleRate)
    : pitch.getState();
  const spec = analyser
    ? spectral.process(analyser)
    : spectral.getState();

  // ── Gate: suppress non-speech signals before decision ──────
  // A desk tap or bump is loud but brief with no variance and high ZCR.
  // Real speech has sustained energy (variance) and low ZCR/centroid.

  let gatedOn = amp.isAboveOnThreshold;
  const gatedOff = amp.isAboveOffThreshold;

  if (gatedOn) {
    // Must pass minimum RMS gate
    if (rms < RMS_GATE) gatedOn = false;

    // Must have enough variance (sustained signal, not a transient)
    if (tvar.bufferFull && tvar.variance < VARIANCE_GATE) gatedOn = false;

    // ZCR should be in speech range (not high like noise/taps)
    if (zcr.smoothedZcr > SPEECH_ZCR_MAX) gatedOn = false;
  }

  // ── Stage 2: Decision logic ────────────────────────────────

  const hyst = hysteresis.process(gatedOn, gatedOff);
  const fc = frameCounter.process(hyst.active);
  const sr = silenceRatio.process(fc.speaking);
  const fan = fanNoise.process({
    noiseLevel:  amp.noiseLevel,
    steadyPitch: pit.steadyPitch,
    variance:    tvar.variance,
    smoothedZcr: zcr.smoothedZcr,
  });

  // ── Stage 3: Buffer ────────────────────────────────────────

  if (timeDomainData) {
    lookbackBuffer.write(timeDomainData, rms, fc.speaking);
  }

  // ── Compose state ──────────────────────────────────────────

  cachedState = {
    // Final decisions
    speaking: fc.speaking,
    fanNoise: fan.detected,

    // Backwards-compatible with noise-detection API
    noiseFloor: amp.noiseFloor,
    isSpeaking: fc.speaking,
    noiseLevel: amp.noiseLevel,

    // Sub-states (for debug / analysis)
    amplitude:        amp,
    zeroCrossing:     zcr,
    temporalVariance: tvar,
    pitch:            pit,
    spectral:         spec,
    hysteresis:       hyst,
    frameCounter:     fc,
    silenceRatio:     sr,
    fanNoiseDetail:   fan,
    lookback:         lookbackBuffer.getState(),
  };

  // ── Fire callback on state changes ─────────────────────────

  if (callback) {
    if (fc.speaking !== lastSpeaking || fan.detected !== lastFanNoise) {
      callback(cachedState);
    }
  }

  lastSpeaking = fc.speaking;
  lastFanNoise = fan.detected;

  return cachedState;
}

/**
 * Get current state without processing.
 */
function getState() {
  if (cachedState) return cachedState;

  return {
    speaking:         false,
    fanNoise:         false,
    noiseFloor:       0,
    isSpeaking:       false,
    noiseLevel:       'low',
    amplitude:        amplitude.getState(),
    zeroCrossing:     zeroCrossing.getState(),
    temporalVariance: temporalVariance.getState(),
    pitch:            pitch.getState(),
    spectral:         spectral.getState(),
    hysteresis:       hysteresis.getState(),
    frameCounter:     frameCounter.getState(),
    silenceRatio:     silenceRatio.getState(),
    fanNoiseDetail:   { detected: false, confidence: 0 },
    lookback:         lookbackBuffer.getState(),
  };
}

/**
 * Set callback for speaking/fanNoise state changes.
 * @param {function} cb — called with full state object
 */
function onChange(cb) {
  callback = cb;
}

/**
 * Reset all sub-modules.
 */
function reset() {
  amplitude.reset();
  zeroCrossing.reset();
  temporalVariance.reset();
  pitch.reset();
  spectral.reset();
  hysteresis.reset();
  frameCounter.reset();
  silenceRatio.reset();
  fanNoise.reset();
  lookbackBuffer.reset();

  lastSpeaking = false;
  lastFanNoise = false;
  cachedState = null;
}

module.exports = { process, getState, onChange, reset };
