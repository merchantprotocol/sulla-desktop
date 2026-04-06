/**
 * Model — microphone capture via Web Audio API.
 *
 * Captures mic audio via getUserMedia + AnalyserNode.
 * Speaker capture is handled by the main process (CoreAudio daemon).
 *
 * No DOM access, no view logic — pure audio data.
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
 * List all available audio devices.
 */
async function listDevices() {
  let tempStream = null;
  try {
    tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    log.warn("AudioCapture", "Cannot enumerate devices without mic permission", { error: e.message });
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  if (tempStream && !micStream) {
    tempStream.getTracks().forEach((t) => t.stop());
  }

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
 * Start mic capture.
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

function computeRms(analyserNode) {
  if (!analyserNode) return 0;
  const data = new Float32Array(analyserNode.fftSize);
  analyserNode.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.min(1, Math.sqrt(sum / data.length) * 3);
}

function poll() {
  if (!micAnalyser) return;
  const micLevel = computeRms(micAnalyser);
  if (levelCallback) levelCallback(micLevel);
  animFrameId = requestAnimationFrame(poll);
}

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

function setMicGain(value) {
  micGain = value;
  if (micGainNode && !micMuted) micGainNode.gain.value = value;
}

function setMicMuted(muted) {
  micMuted = muted;
  if (micGainNode) micGainNode.gain.value = muted ? 0 : micGain;
  log.info("AudioCapture", muted ? "Mic muted" : "Mic unmuted");
}

function getActiveDeviceId() {
  if (!micStream) return null;
  return micStream.getAudioTracks()[0]?.getSettings().deviceId || null;
}

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

function isRecording() {
  return mediaRecorder !== null && mediaRecorder.state === "recording";
}

module.exports = { start, stop, listDevices, getActiveDeviceId, setMicGain, setMicMuted, getAnalyser, startRecording, stopRecording, isRecording };
