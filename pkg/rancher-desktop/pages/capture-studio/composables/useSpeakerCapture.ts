/**
 * Composable — capture system audio with Electron loopback first and the
 * audio-driver speaker socket as a BlackHole fallback.
 *
 * Connects to the speaker Unix socket in the main process, receives
 * length-prefixed PCM frames (16kHz, mono, s16le), and writes them
 * to a .wav file on disk. Computes RMS level for meters.
 *
 * On macOS 13+ Electron's getDisplayMedia loopback is backed by
 * ScreenCaptureKit and does not require a virtual audio device.
 */

import { ref, onUnmounted, type Ref } from 'vue';

const fs = require('fs');
const net = require('net');
const path = require('path');

const { ipcRenderer } = require('electron');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

/**
 * Write a WAV file header. Data length is set to 0xFFFFFFFF initially;
 * call finalizeWav() to patch it with the real size.
 */
function writeWavHeader(ws: any): void {
  const header = Buffer.alloc(44);
  const maxDataSize = 0xFFFFFFFF - 36; // placeholder

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + maxDataSize, 4); // file size - 8
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(maxDataSize, 40); // data chunk size (placeholder)

  ws.write(header);
}

/**
 * Patch the WAV header with the actual data size.
 */
function finalizeWav(filePath: string, dataBytes: number): void {
  const fd = fs.openSync(filePath, 'r+');
  const buf = Buffer.alloc(4);

  // File size - 8
  buf.writeUInt32LE(36 + dataBytes, 0);
  fs.writeSync(fd, buf, 0, 4, 4);

  // Data chunk size
  buf.writeUInt32LE(dataBytes, 0);
  fs.writeSync(fd, buf, 0, 4, 40);

  fs.closeSync(fd);
}

/**
 * Compute RMS level from s16le PCM buffer.
 */
function computePcmRms(pcm: Buffer): number {
  const samples = pcm.length / BYTES_PER_SAMPLE;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(i) / 32768;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples) * 3);
}

export function useSpeakerCapture() {
  const level: Ref<number> = ref(0);
  const active = ref(false);
  const bytesWritten = ref(0);
  const nativeStream: Ref<MediaStream | null> = ref(null);
  const mode: Ref<'none' | 'native' | 'blackhole'> = ref('none');

  let socket: any = null;
  let writeStream: any = null;
  let filePath = '';
  let totalDataBytes = 0;
  let pending = Buffer.alloc(0);
  let analyserContext: AudioContext | null = null;
  let analyserFrame: number | null = null;

  function stopNativeMeter(): void {
    if (analyserFrame !== null) cancelAnimationFrame(analyserFrame);
    analyserFrame = null;
    analyserContext?.close().catch(() => {});
    analyserContext = null;
    level.value = 0;
  }

  function startNativeMeter(stream: MediaStream): void {
    stopNativeMeter();
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;

    analyserContext = new AudioContextCtor();
    const source = analyserContext.createMediaStreamSource(stream);
    const analyser = analyserContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const update = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      level.value = Math.min(1, Math.sqrt(sum / samples.length) * 3);
      analyserFrame = requestAnimationFrame(update);
    };
    analyserFrame = requestAnimationFrame(update);
  }

  /** Acquire Electron/ScreenCaptureKit system audio without BlackHole. */
  async function acquireNative(): Promise<MediaStream | null> {
    releaseNative();
    try {
      // Electron's main-process display-media handler supplies the display and
      // `audio: 'loopback'`. Chromium still requires video in this request;
      // discard it immediately and retain only the loopback audio track.
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      const audioTracks = displayStream.getAudioTracks();
      displayStream.getVideoTracks().forEach(track => track.stop());
      if (audioTracks.length === 0) {
        displayStream.getTracks().forEach(track => track.stop());
        console.warn('[useSpeakerCapture] Native loopback returned no audio track');
        return null;
      }

      const stream = new MediaStream(audioTracks);
      nativeStream.value = stream;
      mode.value = 'native';
      active.value = true;
      audioTracks.forEach(track => track.addEventListener('ended', () => {
        if (nativeStream.value === stream) releaseNative();
      }, { once: true }));
      startNativeMeter(stream);
      console.log('[useSpeakerCapture] Native Electron loopback acquired');
      return stream;
    } catch (err: any) {
      console.warn('[useSpeakerCapture] Native loopback unavailable; falling back to BlackHole:', err?.message || err);
      return null;
    }
  }

  function releaseNative(): void {
    const stream = nativeStream.value;
    nativeStream.value = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stopNativeMeter();
    if (mode.value === 'native') mode.value = 'none';
    if (!writeStream) active.value = false;
  }

  /**
   * Start capturing speaker audio to a WAV file.
   */
  async function start(outputPath: string): Promise<boolean> {
    if (writeStream) await stop();

    const socketPath = await ipcRenderer.invoke('audio-driver:get-speaker-socket-path');
    if (!socketPath) {
      console.warn('[useSpeakerCapture] No speaker socket available — is audio driver running?');
      return false;
    }

    filePath = outputPath;
    totalDataBytes = 0;
    bytesWritten.value = 0;
    pending = Buffer.alloc(0);

    // Open WAV file
    try {
      writeStream = fs.createWriteStream(filePath);
      writeWavHeader(writeStream);
    } catch (err: any) {
      console.error('[useSpeakerCapture] Failed to create write stream:', err.message);
      return false;
    }

    writeStream.on('error', (err: any) => {
      console.error('[useSpeakerCapture] Write error:', err.message);
    });

    // Connect to speaker socket
    socket = net.createConnection(socketPath);

    socket.on('data', (data: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, data]) : data;

      // Parse length-prefixed frames
      while (pending.length >= 4) {
        const frameLen = pending.readUInt32BE(0);
        if (!Number.isFinite(frameLen) || frameLen <= 0 || frameLen > 1024 * 1024) {
          pending = Buffer.alloc(0);
          break;
        }
        if (pending.length < 4 + frameLen) break;

        const chunk = pending.subarray(4, 4 + frameLen);
        pending = pending.subarray(4 + frameLen);

        // Write raw PCM to WAV file
        if (writeStream && !writeStream.destroyed) {
          writeStream.write(chunk);
          totalDataBytes += chunk.length;
          bytesWritten.value = totalDataBytes;
        }

        // Compute level for meters
        level.value = computePcmRms(chunk);
      }
    });

    socket.on('error', (err: any) => {
      console.error('[useSpeakerCapture] Socket error:', err.message);
    });

    socket.on('close', () => {
      if (writeStream) {
        console.warn('[useSpeakerCapture] Socket closed unexpectedly — finalizing WAV');
        stop().catch((err: any) => console.error('[useSpeakerCapture] Failed to finalize after socket close:', err.message));
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }).catch((err: any) => {
      console.error('[useSpeakerCapture] Failed to connect to speaker socket:', err.message);
    });
    if (!socket || socket.destroyed) {
      await stop();
      return false;
    }

    active.value = true;
    mode.value = 'blackhole';
    return true;
  }

  /**
   * Stop capturing and finalize the WAV file.
   */
  async function stop(): Promise<string> {
    if (nativeStream.value) releaseNative();
    level.value = 0;

    if (socket) {
      socket.destroy();
      socket = null;
    }

    const ws = writeStream;
    writeStream = null;
    if (ws) {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        ws.once('finish', done);
        ws.once('close', done);
        ws.once('error', done);
        ws.end();
        setTimeout(done, 5000);
      });
    }

    // Patch WAV header with actual data size
    if (filePath) {
      try {
        finalizeWav(filePath, totalDataBytes);
      } catch (e: any) {
        console.error('[useSpeakerCapture] Failed to finalize WAV:', e.message);
      }
    }

    const result = filePath;
    filePath = '';
    totalDataBytes = 0;
    pending = Buffer.alloc(0);
    active.value = false;
    mode.value = 'none';
    return result;
  }

  onUnmounted(() => {
    if (active.value) stop().catch(() => {});
  });

  return {
    level,
    active,
    bytesWritten,
    nativeStream,
    mode,
    acquireNative,
    releaseNative,
    start,
    stop,
  };
}
