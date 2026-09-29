/**
 * Model — full VAD for the speaker (system audio) channel.
 *
 * Main-process port of the standalone audio-driver's speaker VAD. The
 * CoreAudio capture helper computes the analysis natively in the render
 * callback and emits, per callback: rms, peak, zcr, variance, pitch,
 * steadyPitch, pitchStdDev, centroid, rolloff.
 *
 * This gives the speaker channel feature parity with the mic VAD:
 *   - Amplitude hysteresis (dual threshold) over an adaptive noise floor
 *   - Zero-crossing rate validation
 *   - Temporal variance (speech varies, noise is flat)
 *   - Peak/crest factor (speech has transients)
 *   - Pitch detection (human voice 80–400Hz); steady pitch = mechanical/tone
 *   - Spectral centroid (speech energy profile)
 *   - Frame counting (debounce transitions)
 *   - Fan noise detection (cross-signal)
 *
 * Pure signal analysis — no Electron, no I/O — so it can be unit tested.
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
const CENTROID_SPEECH_LOW = 0.03;   // Speech centroid range (normalized)
const CENTROID_SPEECH_HIGH = 0.25;

// ─── Fan noise config ───────────────────────────────────────

const FAN_PERSIST_FRAMES = 30;
const FAN_VARIANCE_THRESHOLD = 0.0001;

const DEBUG_LOG_INTERVAL = 100;     // ~1s at the helper's ~94 callbacks/s

// ─── Types ──────────────────────────────────────────────────

/** One analysis frame from the capture helper's stdout JSON. */
export interface SpeakerLevel {
  rms:          number;
  peak?:        number;
  zcr?:         number;
  variance?:    number;
  pitch?:       number | null;
  steadyPitch?: boolean;
  centroid?:    number;
  rolloff?:     number;
}

export interface SpeakerVadState {
  speaking:   boolean;
  fanNoise:   boolean;
  noiseFloor: number;
}

export interface SpeakerVad {
  process(level: SpeakerLevel): SpeakerVadState;
  getState(): SpeakerVadState;
  reset(): void;
}

// ─── Factory ────────────────────────────────────────────────

export function createSpeakerVad(opts: { debug?: (msg: string, data: Record<string, unknown>) => void } = {}): SpeakerVad {
  let noiseFloor = 0;
  let ampInitialized = false;
  let hystActive = false;
  let speaking = false;
  let voiceFrames = 0;
  let silenceFrames = 0;
  let fanNoiseDetected = false;
  let fanPersistCount = 0;
  let frameCount = 0;

  const getState = (): SpeakerVadState => ({ speaking, fanNoise: fanNoiseDetected, noiseFloor });

  function process(level: SpeakerLevel): SpeakerVadState {
    const rms = Number.isFinite(level.rms) ? level.rms : 0;

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
    const isAboveOff = aboveFloorDB > SPEECH_OFF_DB;

    // Cross-validate with the helper's spectral/temporal signals
    const hasData = typeof level.zcr === 'number';

    if (hasData && isAboveOn) {
      const zcr = level.zcr as number;
      const variance = level.variance || 0;
      const peak = level.peak || 0;
      const crestFactor = rms > 0.001 ? peak / rms : 0;
      const centroid = level.centroid || 0;
      const hasPitch = typeof level.pitch === 'number' && level.pitch > 0;

      // Score how many signals agree this is speech
      let speechScore = 0;

      if (zcr >= ZCR_SPEECH_LOW && zcr <= ZCR_SPEECH_HIGH) speechScore++;
      if (variance >= VARIANCE_MIN) speechScore++;
      if (crestFactor >= CREST_FACTOR_MIN) speechScore++;
      if (hasPitch && !level.steadyPitch) speechScore++;
      if (centroid > 0 && centroid >= CENTROID_SPEECH_LOW && centroid <= CENTROID_SPEECH_HIGH) speechScore++;

      // Need at least 2 cross-signals to confirm
      if (speechScore < 2) isAboveOn = false;
    }

    // Hysteresis
    if (!hystActive) {
      if (isAboveOn) hystActive = true;
    } else if (!isAboveOff) {
      hystActive = false;
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
      let fanScore = 0;

      if (level.steadyPitch === true) fanScore++;
      if ((level.variance || 0) < FAN_VARIANCE_THRESHOLD) fanScore++;
      if (noiseFloor > 0.015) fanScore++;
      if ((level.zcr || 0) > 0.3) fanScore++;

      fanPersistCount = fanScore >= 3 ? fanPersistCount + 1 : 0;
      fanNoiseDetected = fanPersistCount >= FAN_PERSIST_FRAMES;
    }

    frameCount++;
    if (opts.debug && frameCount % DEBUG_LOG_INTERVAL === 0) {
      opts.debug('SpeakerVAD state', {
        speaking,
        rms:          rms.toFixed(4),
        noiseFloor:   noiseFloor.toFixed(4),
        aboveFloorDB: aboveFloorDB.toFixed(1),
        hystActive,
        hasData,
        fanNoise:     fanNoiseDetected,
      });
    }

    return getState();
  }

  function reset(): void {
    noiseFloor = 0;
    ampInitialized = false;
    hystActive = false;
    speaking = false;
    voiceFrames = 0;
    silenceFrames = 0;
    fanNoiseDetected = false;
    fanPersistCount = 0;
    frameCount = 0;
  }

  return { process, getState, reset };
}
