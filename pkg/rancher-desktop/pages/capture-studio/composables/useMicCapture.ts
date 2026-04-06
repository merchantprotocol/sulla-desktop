/**
 * Composable — microphone capture via Web Audio API.
 *
 * Supports multiple simultaneous mic streams. Each instance gets its own
 * AudioContext, AnalyserNode, and RMS level polling.
 *
 * Reference: main/trayPanel/renderer/model/audio-capture.js
 */

import { ref, type Ref } from 'vue';

export interface MicInstance {
  /** Start capturing from this mic. */
  start: (deviceId?: string) => Promise<void>;
  /** Stop capturing. */
  stop: () => void;
  /** Current RMS level (0-1), updated at ~60fps via requestAnimationFrame. */
  level: Ref<number>;
  /** The raw AnalyserNode for waveform drawing. null when not capturing. */
  analyser: Ref<AnalyserNode | null>;
  /** The raw MediaStream for MediaRecorder. null when not capturing. */
  stream: Ref<MediaStream | null>;
  /** Whether this mic is currently capturing. */
  active: Ref<boolean>;
  /** Mute/unmute without stopping the stream. */
  setMuted: (muted: boolean) => void;
  /** Set gain (0-1). */
  setGain: (value: number) => void;
}

function computeRms(analyserNode: AnalyserNode): number {
  const data = new Float32Array(analyserNode.fftSize);
  analyserNode.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.min(1, Math.sqrt(sum / data.length) * 3);
}

/**
 * Create a single mic capture instance.
 */
export function createMicInstance(): MicInstance {
  const level = ref(0);
  const analyser = ref<AnalyserNode | null>(null);
  const stream = ref<MediaStream | null>(null);
  const active = ref(false);

  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let animFrameId: number | null = null;
  let currentGain = 1.0;
  let muted = false;

  function poll() {
    if (!analyser.value) return;
    level.value = computeRms(analyser.value);
    animFrameId = requestAnimationFrame(poll);
  }

  async function start(deviceId?: string) {
    if (active.value) stop();

    audioCtx = new AudioContext();

    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, autoGainControl: false, noiseSuppression: false, echoCancellation: false }
        : { autoGainControl: false, noiseSuppression: false, echoCancellation: false },
    };

    const micStream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.value = micStream;

    const source = audioCtx.createMediaStreamSource(micStream);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = muted ? 0 : currentGain;

    const node = audioCtx.createAnalyser();
    node.fftSize = 512;
    analyser.value = node;

    source.connect(gainNode);
    gainNode.connect(node);

    active.value = true;
    poll();
  }

  function stop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = null;
    if (stream.value) stream.value.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    audioCtx = null;
    gainNode = null;
    analyser.value = null;
    stream.value = null;
    active.value = false;
    level.value = 0;
  }

  function setMuted(m: boolean) {
    muted = m;
    if (gainNode) gainNode.gain.value = m ? 0 : currentGain;
  }

  function setGain(value: number) {
    currentGain = value;
    if (gainNode && !muted) gainNode.gain.value = value;
  }

  return { start, stop, level, analyser, stream, active, setMuted, setGain };
}

/**
 * List available audio input/output devices.
 * Filters out internal loopback/mirror devices.
 */
export async function listAudioDevices(): Promise<{
  inputs: Array<{ deviceId: string; label: string }>;
  outputs: Array<{ deviceId: string; label: string }>;
}> {
  // Trigger permission prompt so labels are populated
  let tempStream: MediaStream | null = null;
  try {
    tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // Permission denied — labels will be empty
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  if (tempStream) {
    tempStream.getTracks().forEach(t => t.stop());
  }

  const isInternal = (label: string) => /blackhole|loopback|audio driver mirror/i.test(label);

  const inputs = devices
    .filter(d => d.kind === 'audioinput' && d.deviceId && !isInternal(d.label))
    .map(d => ({ deviceId: d.deviceId, label: d.label || `Input (${d.deviceId.slice(0, 8)})` }));

  const outputs = devices
    .filter(d => d.kind === 'audiooutput' && d.deviceId && !isInternal(d.label))
    .map(d => ({ deviceId: d.deviceId, label: d.label || `Output (${d.deviceId.slice(0, 8)})` }));

  return { inputs, outputs };
}
