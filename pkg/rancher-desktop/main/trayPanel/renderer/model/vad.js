/**
 * Model — Voice Activity Detection orchestrator.
 *
 * Thin coordinator that feeds raw audio data through the analyzer
 * pipeline, collects features, runs decision logic, and exposes
 * a unified state. Replaces the standalone noise-detection model.
 *
 * Pipeline:
 *   Raw audio → [Analyzers] → features → [Decision] → speaking/silence
 *                                                    → [Lookback Buffer]
 *
 * Backwards-compatible: exposes noiseFloor, isSpeaking, noiseLevel
 * so the existing detection UI in the audio tab works unchanged.
 *
 * No DOM access, no view logic — pure orchestration.
 */

// ─── Analyzers ──────────────────────────────────────────────────

const amplitude = require("./analyzers/amplitude");
const zeroCrossing = require("./analyzers/zero-crossing");
const temporalVariance = require("./analyzers/temporal-variance");
const pitch = require("./analyzers/pitch");
const spectral = require("./analyzers/spectral");

// ─── Decision modules ───────────────────────────────────────────

const hysteresis = require("./decision/hysteresis");
const frameCounter = require("./decision/frame-counter");
const silenceRatio = require("./decision/silence-ratio");
const fanNoise = require("./decision/fan-noise");

// ─── Buffer ─────────────────────────────────────────────────────

const lookbackBuffer = require("./lookback-buffer");

// ─── State ──────────────────────────────────────────────────────

const log = window.audioDriver.log;

let frameCount = 0;
let lastSpeaking = false;
let lastFanNoise = false;
let callback = null;

// Cached sub-states for getState() between process() calls
let cachedState = null;

// ─── Configuration ──────────────────────────────────────────────

const RMS_GATE = 0.005;              // Minimum RMS to even consider speech
const VARIANCE_GATE = 0.0001;        // Minimum variance — speech sustains, taps don't
const SPEECH_ZCR_MAX = 0.15;         // Speech ZCR is low; taps/noise are higher
const SPEECH_CENTROID_MAX = 0.20;    // Speech centroid is concentrated low

const DEBUG_LOG_INTERVAL = 60;  // Log analyzer states every 60 frames (~1s)

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
  let gatedOff = amp.isAboveOffThreshold;

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
    noiseLevel: amp.noiseLevel,
    steadyPitch: pit.steadyPitch,
    variance: tvar.variance,
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
    amplitude: amp,
    zeroCrossing: zcr,
    temporalVariance: tvar,
    pitch: pit,
    spectral: spec,
    hysteresis: hyst,
    frameCounter: fc,
    silenceRatio: sr,
    fanNoiseDetail: fan,
    lookback: lookbackBuffer.getState(),
  };

  // ── Debug logging (~1/second) ──────────────────────────────

  frameCount++;
  if (frameCount % DEBUG_LOG_INTERVAL === 0) {
    log.debug("VAD", "Analyzer state", {
      speaking: fc.speaking,
      fanNoise: fan.detected,
      noiseFloor: amp.noiseFloor.toFixed(4),
      noiseLevel: amp.noiseLevel,
      aboveFloorDB: amp.aboveFloorDB.toFixed(1),
      zcr: zcr.smoothedZcr.toFixed(3),
      variance: tvar.variance.toFixed(6),
      pitch: pit.pitch,
      pitchStdDev: pit.pitchStdDev.toFixed(1),
      centroid: spec.centroid.toFixed(3),
      rolloff: spec.rolloff.toFixed(3),
      silenceRatio: sr.ratio.toFixed(2),
      silenceClass: sr.classification,
      fanConfidence: fan.confidence.toFixed(2),
    });
  }

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
    speaking: false,
    fanNoise: false,
    noiseFloor: 0,
    isSpeaking: false,
    noiseLevel: "low",
    amplitude: amplitude.getState(),
    zeroCrossing: zeroCrossing.getState(),
    temporalVariance: temporalVariance.getState(),
    pitch: pitch.getState(),
    spectral: spectral.getState(),
    hysteresis: hysteresis.getState(),
    frameCounter: frameCounter.getState(),
    silenceRatio: silenceRatio.getState(),
    fanNoiseDetail: { detected: false, confidence: 0 },
    lookback: lookbackBuffer.getState(),
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

  frameCount = 0;
  lastSpeaking = false;
  lastFanNoise = false;
  cachedState = null;
}

module.exports = { process, getState, onChange, reset };
