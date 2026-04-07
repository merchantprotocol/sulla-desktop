/**
 * @file audio-capture.js — Microphone Capture Module (Tray Panel Renderer)
 *
 * # Microphone Capture via Web Audio API
 *
 * This is the renderer-side component of the audio driver's mic pipeline.
 * It runs inside the tray panel's BrowserWindow (which has `nodeIntegration: true`)
 * and provides:
 *
 * - **getUserMedia** acquisition with configurable device selection
 * - **GainNode** for software volume control and mute
 * - **AnalyserNode** (FFT size 512) for real-time level metering and VAD input
 * - **MediaRecorder** producing 250 ms WebM/Opus chunks for gateway streaming
 *
 * ## Audio graph
 *
 * ```
 * getUserMedia (raw mic)
 *   → MediaStreamSource
 *   → GainNode (gain control + mute)
 *   → AnalyserNode (level metering + VAD feature extraction)
 *
 * getUserMedia (raw mic, same stream)
 *   → MediaRecorder (250 ms WebM/Opus chunks)
 *   → onChunk callback → mic Unix socket → main process → gateway
 * ```
 *
 * Note: the MediaRecorder records from the raw `micStream` (before the
 * GainNode), so muting via gain only affects the AnalyserNode levels and
 * VAD — the recorded audio is always full-volume. This is intentional:
 * the gateway receives unprocessed audio for best transcription quality.
 *
 * ## Browser audio constraints
 *
 * All automatic processing is disabled (`autoGainControl: false`,
 * `noiseSuppression: false`, `echoCancellation: false`) because the audio
 * driver's own VAD pipeline handles these concerns. Enabling browser-level
 * processing would interfere with the noise floor and VAD thresholds.
 *
 * ## Important: do not duplicate this module
 *
 * This module is the ONLY place in sulla-desktop that should call
 * `getUserMedia({ audio: ... })` for ongoing capture. Other windows
 * (chat, secretary, etc.) receive mic data through IPC events broadcast
 * by the main process. Creating additional `getUserMedia` streams would
 * conflict with this one and produce duplicate audio on the gateway.
 *
 * No DOM access, no view logic — pure audio data model.
 */

const log = window.audioDriver.log;

let audioCtx = null;
let micAnalyser = null;
let micGainNode = null;
let micStream = null;
let animFrameId = null;
let levelCallback = null;
let micMuted = false;
let micGain = 1.0;

// MediaRecorder for gateway streaming (250ms WebM/Opus chunks)
let mediaRecorder = null;
let recordingCallback = null;
const CHUNK_INTERVAL_MS = 250;

/**
 * List all available audio input and output devices.
 *
 * Device labels are only available after `getUserMedia` has been granted,
 * so labels will be empty until capture is first started. Fallback names
 * are used in the meantime. Internal loopback/mirror devices (BlackHole,
 * Audio Driver Mirror) are filtered out so they never appear in dropdowns.
 *
 * @returns {{ inputs: Array<{deviceId: string, label: string}>, outputs: Array<{deviceId: string, label: string}> }}
 */
async function listDevices() {
  // Skip getUserMedia when no capture is active. Opening a temporary mic
  // stream just to get device labels triggers the macOS mic indicator on
  // every boot. Without an active stream enumerateDevices() returns empty
  // labels, but the fallback names below handle that gracefully. Once the
  // user starts capture, refreshDevices() is called again with an active
  // micStream so labels populate correctly.
  const devices = await navigator.mediaDevices.enumerateDevices();

  // Hide internal loopback/mirror devices from the dropdowns
  const isInternal = (label) =>
    /blackhole|loopback|audio driver mirror/i.test(label);

  const inputs = devices
    .filter((d) => d.kind === "audioinput" && d.deviceId && !isInternal(d.label))
    .map((d) => ({ deviceId: d.deviceId, label: d.label || `Input (${d.deviceId.slice(0, 8)})` }));

  const outputs = devices
    .filter((d) => d.kind === "audiooutput" && d.deviceId && !isInternal(d.label))
    .map((d) => ({ deviceId: d.deviceId, label: d.label || `Output (${d.deviceId.slice(0, 8)})` }));

  log.debug("AudioCapture", "Devices listed", { inputs: inputs.length, outputs: outputs.length });

  return { inputs, outputs };
}

/**
 * Start microphone capture and build the Web Audio graph.
 *
 * Opens a `getUserMedia` stream with the specified device (or default),
 * creates the AudioContext → Source → GainNode → AnalyserNode chain,
 * and begins polling levels via `requestAnimationFrame`.
 *
 * After the stream is open, auto-detects the active mic and default
 * speaker names and pushes them to the main process via
 * `window.audioDriver.setDeviceNames()`.
 *
 * @param {function} onLevel    - Called every animation frame with the current
 *                                mic RMS level (0.0 - 1.0). Used to drive the
 *                                mic meter UI and feed the VAD pipeline.
 * @param {string}   micDeviceId - Optional `deviceId` to select a specific mic.
 *                                 Pass `undefined` to use the system default.
 * @returns {{ micName: string, speakerName: string, micDeviceId: string }}
 */
async function start(onLevel, micDeviceId) {
  levelCallback = onLevel;

  audioCtx = new AudioContext();

  const constraints = {
    audio: micDeviceId
      ? { deviceId: { exact: micDeviceId }, autoGainControl: false, noiseSuppression: false, echoCancellation: false }
      : { autoGainControl: false, noiseSuppression: false, echoCancellation: false },
  };

  log.info("AudioCapture", "Opening mic...", { deviceId: micDeviceId || "default" });
  micStream = await navigator.mediaDevices.getUserMedia(constraints);

  const source = audioCtx.createMediaStreamSource(micStream);
  micGainNode = audioCtx.createGain();
  micGainNode.gain.value = micMuted ? 0 : micGain;
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 512;

  source.connect(micGainNode);
  micGainNode.connect(micAnalyser);

  log.info("AudioCapture", "Mic stream active", {
    sampleRate: audioCtx.sampleRate,
    gain: micGainNode.gain.value,
  });

  const deviceInfo = await detectDevices();
  window.audioDriver.setDeviceNames(deviceInfo.micName, deviceInfo.speakerName);

  poll();
  return deviceInfo;
}

/**
 * Compute the RMS (root mean square) level from an AnalyserNode's time-domain data.
 * The result is scaled by 3x and clamped to 0.0-1.0 for UI display sensitivity.
 *
 * @param {AnalyserNode} analyserNode
 * @returns {number} RMS level between 0.0 and 1.0
 */
function computeRms(analyserNode) {
  if (!analyserNode) return 0;
  const data = new Float32Array(analyserNode.fftSize);
  analyserNode.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.min(1, Math.sqrt(sum / data.length) * 3);
}

/**
 * Animation-frame polling loop. Computes mic RMS each frame and delivers it
 * to the level callback (which typically feeds both the meter UI and the VAD).
 */
function poll() {
  if (!micAnalyser) return;
  const micLevel = computeRms(micAnalyser);
  if (levelCallback) levelCallback(micLevel);
  animFrameId = requestAnimationFrame(poll);
}

/**
 * Stop mic capture, tear down the Web Audio graph, and release the mic stream.
 * Cancels the animation-frame polling loop and closes the AudioContext.
 */
function stop() {
  log.info("AudioCapture", "Stopping mic capture");
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  micAnalyser = null;
  micGainNode = null;
  micStream = null;
  levelCallback = null;
}

/**
 * Set the software gain multiplier for the mic.
 * Only affects the AnalyserNode (and therefore VAD levels); the MediaRecorder
 * records from the raw stream at full volume.
 *
 * @param {number} value - Gain multiplier (0.0 = silence, 1.0 = unity, >1.0 = boost)
 */
function setMicGain(value) {
  micGain = value;
  if (micGainNode && !micMuted) micGainNode.gain.value = value;
}

/**
 * Mute or unmute the mic without stopping the stream.
 * Sets the GainNode to 0 (mute) or restores the current gain value (unmute).
 * @param {boolean} muted
 */
function setMicMuted(muted) {
  micMuted = muted;
  if (micGainNode) micGainNode.gain.value = muted ? 0 : micGain;
  log.info("AudioCapture", muted ? "Mic muted" : "Mic unmuted");
}

/** Return the deviceId of the currently active mic track, or null if stopped. */
function getActiveDeviceId() {
  if (!micStream) return null;
  return micStream.getAudioTracks()[0]?.getSettings().deviceId || null;
}

/**
 * Detect the names of the currently active mic and default speaker devices.
 * Called after getUserMedia resolves to report device names to the main process.
 * @returns {{ micName: string, speakerName: string, micDeviceId: string }}
 */
async function detectDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const track = micStream.getAudioTracks()[0];
  const settings = track.getSettings();

  const inputDevice = devices.find((d) => d.kind === "audioinput" && d.deviceId === settings.deviceId);
  const outputDevice = devices.find((d) => d.kind === "audiooutput" && d.deviceId === "default");

  const micName = inputDevice?.label || "Microphone";
  const speakerName = outputDevice?.label || "Default Output";

  log.info("AudioCapture", "Devices detected", { mic: micName, speaker: speakerName });

  return { micName, speakerName, micDeviceId: settings.deviceId };
}

/** Return the mic AnalyserNode (for VAD and feedback detection), or null if stopped. */
function getAnalyser() {
  return micAnalyser;
}

/**
 * Start recording mic audio as 250ms WebM/Opus chunks for gateway streaming.
 * Must be called after start(). Chunks are delivered as ArrayBuffer via callback.
 *
 * @param {function} onChunk — called with ArrayBuffer for each chunk
 */
function startRecording(onChunk) {
  if (!micStream) {
    log.warn("AudioCapture", "Cannot record — no mic stream active");
    return;
  }
  if (mediaRecorder) stopRecording();

  recordingCallback = onChunk;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  mediaRecorder = new MediaRecorder(micStream, { mimeType });

  mediaRecorder.ondataavailable = async (e) => {
    log.debug("AudioCapture", "ondataavailable", { size: e.data.size, hasCallback: !!recordingCallback });
    if (e.data.size > 0 && recordingCallback) {
      try {
        const buffer = await e.data.arrayBuffer();
        log.debug("AudioCapture", "Sending chunk", { bytes: buffer.byteLength });
        recordingCallback(buffer);
      } catch (err) {
        log.error("AudioCapture", "Chunk send failed", { error: err.message });
      }
    }
  };

  mediaRecorder.start(CHUNK_INTERVAL_MS);
  log.info("AudioCapture", "Recording started", { mimeType, interval: CHUNK_INTERVAL_MS });
}

/**
 * Stop recording.
 */
function stopRecording() {
  if (mediaRecorder) {
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    mediaRecorder = null;
    recordingCallback = null;
    log.info("AudioCapture", "Recording stopped");
  }
}

/** Whether the MediaRecorder is currently capturing chunks. */
function isRecording() {
  return mediaRecorder !== null && mediaRecorder.state === "recording";
}

module.exports = { start, stop, listDevices, getActiveDeviceId, setMicGain, setMicMuted, getAnalyser, startRecording, stopRecording, isRecording };
