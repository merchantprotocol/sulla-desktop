/**
 * Composable — capture system audio from the audio-driver speaker socket.
 *
 * Connects to the speaker Unix socket in the main process, receives
 * length-prefixed PCM frames (16kHz, mono, s16le), and writes them
 * to a .wav file on disk. Computes RMS level for meters.
 *
 * This replaces getDisplayMedia audio for system audio capture.
 */

import { ref, onUnmounted, type Ref } from 'vue';

const net = require('net');
const fs = require('fs');
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

  let socket: any = null;
  let writeStream: any = null;
  let filePath = '';
  let totalDataBytes = 0;
  let pending = Buffer.alloc(0);

  /**
   * Start capturing speaker audio to a WAV file.
   */
  async function start(outputPath: string): Promise<void> {
    if (active.value) stop();

    const socketPath = await ipcRenderer.invoke('audio-driver:get-speaker-socket-path');
    if (!socketPath) {
      console.warn('[useSpeakerCapture] No speaker socket available — is audio driver running?');
      return;
    }

    filePath = outputPath;
    totalDataBytes = 0;
    bytesWritten.value = 0;
    pending = Buffer.alloc(0);

    // Open WAV file
    writeStream = fs.createWriteStream(filePath);
    writeWavHeader(writeStream);

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
        if (frameLen === 0 || frameLen > 1024 * 1024) {
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
      if (active.value) {
        console.warn('[useSpeakerCapture] Socket closed unexpectedly');
      }
    });

    active.value = true;
  }

  /**
   * Stop capturing and finalize the WAV file.
   */
  function stop(): string {
    active.value = false;
    level.value = 0;

    if (socket) {
      socket.destroy();
      socket = null;
    }

    if (writeStream) {
      writeStream.end();
      writeStream = null;
    }

    // Patch WAV header with actual data size
    if (filePath && totalDataBytes > 0) {
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
    return result;
  }

  onUnmounted(() => {
    if (active.value) stop();
  });

  return {
    level,
    active,
    bytesWritten,
    start,
    stop,
  };
}
