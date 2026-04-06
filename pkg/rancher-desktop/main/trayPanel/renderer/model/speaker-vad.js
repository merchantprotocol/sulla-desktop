/**
 * Model — full VAD for the speaker channel.
 *
 * The Swift capture helper now computes all analysis natively in the
 * CoreAudio render callback and sends: rms, peak, zcr, variance,
 * pitch, steadyPitch, pitchStdDev, centroid, rolloff.
 *
 * This gives the speaker channel feature parity with the mic VAD:
 *   - Amplitude hysteresis (dual threshold)
 *   - Zero-crossing rate validation
 *   - Temporal variance (speech varies, noise is flat)
 *   - Peak/crest factor (speech has transients)
 *   - Pitch detection (human voice 80–400Hz)
 *   - Steady pitch = fan/mechanical noise
 *   - Spectral centroid + rolloff (speech energy profile)
 *   - Frame counting (debounce transitions)
 *   - Fan noise detection (cross-signal)
 *
 * No DOM access, no view logic — pure signal analysis.
 */

// ─── Amplitude config ───────────────────────────────────────

const FLOOR_DECAY = 0.995;
const FLOOR_ATTACK = 0.3;
const FLOOR_MIN = 0.0001;
const SPEECH_ON_DB = 8;             // Lower than mic — loopback is cleaner
const SPEECH_OFF_DB = 4;

// ─── Frame counter config ───────────────────────────────────

const VOICE_FRAMES_REQUIRED = 3;
const SILENCE_FRAMES_REQUIRED = 20; // Longer hold — call audio has natural pauses

// ─── Cross-signal thresholds ────────────────────────────────

const ZCR_SPEECH_LOW = 0.05;        // Below this = likely DC/hum
const ZCR_SPEECH_HIGH = 0.6;        // Above this = likely noise
const VARIANCE_MIN = 0.00005;       // Below this = too steady for speech
const CREST_FACTOR_MIN = 1.2;       // Peak/RMS — speech has transients
const CENTROID_SPEECH_LOW = 0.03;    // Speech centroid range (normalized)
const CENTROID_SPEECH_HIGH = 0.25;
const ROLLOFF_SPEECH_MAX = 0.4;      // Speech energy concentrated in low freqs

// ─── Fan noise config ───────────────────────────────────────

const FAN_PERSIST_FRAMES = 30;       // ~500ms before flagging
const FAN_VARIANCE_THRESHOLD = 0.0001;

// ─── Debug ──────────────────────────────────────────────────

const log = window.audioDriver.log;
const DEBUG_LOG_INTERVAL = 30;  // ~1s at 30fps (speaker level comes at 30fps)
let frameCount = 0;

// ─── State ──────────────────────────────────────────────────

let noiseFloor = 0;
let ampInitialized = false;
let hystActive = false;
let speaking = false;
let voiceFrames = 0;
let silenceFrames = 0;
let fanNoiseDetected = false;
let fanPersistCount = 0;
let callback = null;
let lastSpeaking = false;

// ─── Analysis ───────────────────────────────────────────────

/**
 * Process a speaker audio frame.
 *
 * @param {number} rms — speaker RMS level (0.0–1.0)
 * @param {object} [data] — full data from Swift helper
 * @returns {{ speaking: boolean, fanNoise: boolean, noiseFloor: number }}
 */
function process(rms, data) {
  // Amplitude + noise floor
  if (!ampInitialized) {
    noiseFloor = rms;
    ampInitialized = true;
  }

  if (rms < noiseFloor) {
    noiseFloor = noiseFloor * (1 - FLOOR_ATTACK) + rms * FLOOR_ATTACK;
  } else {
    noiseFloor = noiseFloor * FLOOR_DECAY + rms * (1 - FLOOR_DECAY);
  }
  if (noiseFloor < FLOOR_MIN) noiseFloor = FLOOR_MIN;

  const floorDB = 20 * Math.log10(noiseFloor + 1e-10);
  const currentDB = 20 * Math.log10(rms + 1e-10);
  const aboveFloorDB = currentDB - floorDB;

  let isAboveOn = aboveFloorDB > SPEECH_ON_DB;
  let isAboveOff = aboveFloorDB > SPEECH_OFF_DB;

  // Cross-validate with signals from Swift helper
  const hasData = data && typeof data === "object" && typeof data.zcr === "number";

  if (hasData && isAboveOn) {
    const zcr = data.zcr;
    const variance = data.variance || 0;
    const peak = data.peak || 0;
    const crestFactor = rms > 0.001 ? peak / rms : 0;
    const centroid = data.centroid || 0;
    const rolloff = data.rolloff || 0;
    const hasPitch = typeof data.pitch === "number" && data.pitch > 0;

    // Score how many signals agree this is speech
    let speechScore = 0;
    let checks = 0;

    // ZCR in speech range
    checks++;
    if (zcr >= ZCR_SPEECH_LOW && zcr <= ZCR_SPEECH_HIGH) speechScore++;

    // Variance above minimum (not flat)
    checks++;
    if (variance >= VARIANCE_MIN) speechScore++;

    // Crest factor (transients)
    checks++;
    if (crestFactor >= CREST_FACTOR_MIN) speechScore++;

    // Pitch detected in human range
    checks++;
    if (hasPitch && !data.steadyPitch) speechScore++;

    // Spectral centroid in speech range
    if (centroid > 0) {
      checks++;
      if (centroid >= CENTROID_SPEECH_LOW && centroid <= CENTROID_SPEECH_HIGH) speechScore++;
    }

    // Need at least 2 cross-signals to confirm
    if (speechScore < 2) {
      isAboveOn = false;
    }
  }

  // Hysteresis
  if (!hystActive) {
    if (isAboveOn) hystActive = true;
  } else {
    if (!isAboveOff) hystActive = false;
  }

  // Frame counter
  if (hystActive) {
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

  // Fan noise detection (cross-signal)
  if (hasData) {
    const isSteadyPitch = data.steadyPitch === true;
    const isLowVariance = (data.variance || 0) < FAN_VARIANCE_THRESHOLD;
    const isLoud = noiseFloor > 0.015;
    const isHighZcr = (data.zcr || 0) > 0.3;

    let fanScore = 0;
    if (isSteadyPitch) fanScore++;
    if (isLowVariance) fanScore++;
    if (isLoud) fanScore++;
    if (isHighZcr) fanScore++;

    if (fanScore >= 3) {
      fanPersistCount++;
    } else {
      fanPersistCount = 0;
    }
    fanNoiseDetected = fanPersistCount >= FAN_PERSIST_FRAMES;
  }

  // Debug logging (~1/second)
  frameCount++;
  if (frameCount % DEBUG_LOG_INTERVAL === 0) {
    log.debug("SpeakerVAD", "State", {
      speaking,
      rms: rms.toFixed(4),
      noiseFloor: noiseFloor.toFixed(4),
      aboveFloorDB: aboveFloorDB.toFixed(1),
      hystActive,
      voiceFrames,
      silenceFrames,
      hasData: hasData,
      zcr: hasData ? (data.zcr || 0).toFixed(3) : "n/a",
      variance: hasData ? (data.variance || 0).toFixed(6) : "n/a",
      pitch: hasData ? (data.pitch || null) : "n/a",
      centroid: hasData ? (data.centroid || 0).toFixed(4) : "n/a",
      fanNoise: fanNoiseDetected,
    });
  }

  // Fire callback on state change
  if (callback && speaking !== lastSpeaking) {
    callback({ speaking, fanNoise: fanNoiseDetected, noiseFloor });
  }
  lastSpeaking = speaking;

  return { speaking, fanNoise: fanNoiseDetected, noiseFloor };
}

function onChange(cb) {
  callback = cb;
}

function getState() {
  return { speaking, fanNoise: fanNoiseDetected, noiseFloor };
}

function reset() {
  noiseFloor = 0;
  ampInitialized = false;
  hystActive = false;
  speaking = false;
  voiceFrames = 0;
  silenceFrames = 0;
  fanNoiseDetected = false;
  fanPersistCount = 0;
  lastSpeaking = false;
  frameCount = 0;
}

module.exports = { process, onChange, getState, reset };
