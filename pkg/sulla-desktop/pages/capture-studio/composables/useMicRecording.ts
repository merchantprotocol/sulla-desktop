// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Composable — record mic audio from the MicrophoneDriverController
 * PCM socket to a WAV file on disk.
 *
 * Same pattern as useSpeakerCapture.ts — connects to a Unix domain
 * socket, receives length-prefixed PCM frames, writes WAV.
 *
 * Quality modes (PCM):
 *   'raw'             — all audio, no processing (ASMR, music)
 *   'noise-reduction' — VAD-gated + noise-processed (voice)
 *
 * Compressed modes use the WebM/Opus mic-socket instead:
 *   'streaming'       — compressed WebM/Opus
 *   'streaming-voice' — compressed WebM/Opus + voice processing
 */

import { ref, type Ref } from 'vue';
import { PcmPauseTimeline } from '../services/PcmPauseTimeline';

const fs = require('fs');
const net = require('net');

const { ipcRenderer } = require('electron');

// Default to 48kHz — updated from controller state on start
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

function writeWavHeader(ws: any, sampleRate: number): void {
  const header = Buffer.alloc(44);
  const maxDataSize = 0xFFFFFFFF - 36;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + maxDataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * CHANNELS * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(maxDataSize, 40);

  ws.write(header);
}

function finalizeWav(filePath: string, dataBytes: number): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r+');
    const buf = Buffer.alloc(4);

    buf.writeUInt32LE(36 + dataBytes, 0);
    fs.writeSync(fd, buf, 0, 4, 4);

    buf.writeUInt32LE(dataBytes, 0);
    fs.writeSync(fd, buf, 0, 4, 40);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

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

export type MicQualityMode = 'raw' | 'noise-reduction' | 'voice-compressed' | 'streaming' | 'streaming-voice';

export function useMicRecording() {
  const level: Ref<number> = ref(0);
  const active = ref(false);
  const bytesWritten = ref(0);

  let socket: any = null;
  let writeStream: any = null;
  let filePath = '';
  let totalDataBytes = 0;
  let pending = Buffer.alloc(0);
  let currentMode: MicQualityMode = 'raw';
  let paused = false;
  let sampleRate = 48000;
  const pauseTimeline = new PcmPauseTimeline();

  /**
   * Start recording mic audio to a file.
   *
   * For PCM modes (raw, noise-reduction, voice-compressed):
   *   Connects to mic-pcm-socket, writes WAV at 48kHz.
   *
   * For compressed modes (streaming, streaming-voice):
   *   Connects to mic-socket, writes raw WebM/Opus chunks.
   */
  async function start(outputPath: string, mode: MicQualityMode = 'raw'): Promise<boolean> {
    if (active.value) await stop();

    currentMode = mode;
    paused = false;
    filePath = outputPath;
    totalDataBytes = 0;
    bytesWritten.value = 0;
    pending = Buffer.alloc(0);

    const isCompressed = mode === 'streaming' || mode === 'streaming-voice';

    // Set the PCM mode on the controller (raw vs noise-reduction)
    if (!isCompressed) {
      const pcmMode = mode === 'raw' ? 'raw' : 'noise-reduction';
      await ipcRenderer.invoke('audio-driver:set-mic-pcm-mode', pcmMode);
    }

    // Get the appropriate socket path
    const socketPath = isCompressed
      ? await ipcRenderer.invoke('audio-driver:get-mic-socket-path')
      : await ipcRenderer.invoke('audio-driver:get-mic-pcm-socket-path');

    if (!socketPath) {
      console.warn('[useMicRecording] No socket path available — is audio driver running?');
      return false;
    }

    // Open output file
    try {
      writeStream = fs.createWriteStream(filePath);
      if (!isCompressed) {
        // Get the actual sample rate from the controller
        const state = await ipcRenderer.invoke('audio-driver:get-state');
        sampleRate = state?.micSampleRate || 48000;
        writeWavHeader(writeStream, sampleRate);
      }
    } catch (err: any) {
      console.error('[useMicRecording] Failed to create write stream:', err.message);
      return false;
    }

    writeStream.on('error', (err: any) => {
      console.error('[useMicRecording] Write error:', err.message);
    });

    // Connect to socket
    socket = net.createConnection(socketPath);

    socket.on('data', (data: Buffer) => {
      if (isCompressed) {
        // WebM/Opus — write chunks directly (already length-prefixed on socket)
        // Parse length-prefixed frames and write just the payload
        pending = pending.length > 0 ? Buffer.concat([pending, data]) : data;
        while (pending.length >= 4) {
          const frameLen = pending.readUInt32BE(0);
          if (!Number.isFinite(frameLen) || frameLen <= 0 || frameLen > 1024 * 1024) {
            pending = Buffer.alloc(0);
            break;
          }
          if (pending.length < 4 + frameLen) break;
          const chunk = pending.subarray(4, 4 + frameLen);
          pending = pending.subarray(4 + frameLen);

          if (writeStream && !writeStream.destroyed && !paused) {
            writeStream.write(chunk);
            totalDataBytes += chunk.length;
            bytesWritten.value = totalDataBytes;
          }
        }
      } else {
        // PCM — parse length-prefixed frames, write raw PCM, compute level
        pending = pending.length > 0 ? Buffer.concat([pending, data]) : data;
        while (pending.length >= 4) {
          const frameLen = pending.readUInt32BE(0);
          if (!Number.isFinite(frameLen) || frameLen <= 0 || frameLen > 1024 * 1024) {
            pending = Buffer.alloc(0);
            break;
          }
          if (pending.length < 4 + frameLen) break;
          const chunk = pending.subarray(4, 4 + frameLen);
          pending = pending.subarray(4 + frameLen);

          if (writeStream && !writeStream.destroyed && !paused) {
            writeStream.write(chunk);
            totalDataBytes += chunk.length;
            bytesWritten.value = totalDataBytes;
          }

          level.value = computePcmRms(chunk);
        }
      }
    });

    socket.on('error', (err: any) => {
      console.error('[useMicRecording] Socket error:', err.message);
    });

    socket.on('close', () => {
      if (writeStream) {
        console.warn('[useMicRecording] Socket closed unexpectedly — finalizing');
        stop().catch((err: any) => console.error('[useMicRecording] Failed to finalize after socket close:', err.message));
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }).catch((err: any) => {
      console.error('[useMicRecording] Failed to connect to mic socket:', err.message);
    });
    if (!socket || socket.destroyed) {
      await stop();
      return false;
    }

    active.value = true;
    console.log('[useMicRecording] Started', { mode, path: socketPath, file: filePath });
    return true;
  }

  /**
   * Stop recording and finalize the output file.
   * Returns the file path.
   */
  function setPaused(value: boolean): void {
    if (paused === value || !active.value) return;
    if (value) { paused = true; pauseTimeline.pause(); level.value = 0; return; }
    if (currentMode !== 'streaming' && currentMode !== 'streaming-voice' && writeStream && !writeStream.destroyed) {
      let silenceBytes = pauseTimeline.resume(sampleRate, BYTES_PER_SAMPLE);
      while (silenceBytes > 0) {
        const chunkBytes = Math.min(silenceBytes, 16 * 1024 * 1024);
        writeStream.write(Buffer.alloc(chunkBytes));
        totalDataBytes += chunkBytes;
        silenceBytes -= chunkBytes;
      }
      bytesWritten.value = totalDataBytes;
    }
    paused = false;
  }

  async function stop(): Promise<string> {
    if (paused) setPaused(false);
    paused = false;
    pauseTimeline.reset();
    active.value = false;
    level.value = 0;

    if (socket) {
      socket.destroy();
      socket = null;
    }

    const ws = writeStream;
    if (ws?.errored) throw ws.errored;
    if (ws && !ws.writableFinished) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          ws.removeListener('finish', onFinish);
          ws.removeListener('error', onError);
          if (error) reject(error);
          else resolve();
        };
        const onFinish = () => finish();
        const onError = (error: Error) => finish(error);
        if (ws.errored) { finish(ws.errored); return; }
        ws.once('finish', onFinish);
        ws.once('error', onError);
        timeout = setTimeout(() => finish(new Error('Timed out finalizing microphone recording.')), 5000);
        ws.end();
      });
    }

    // Finalize WAV header for PCM modes
    const isCompressed = currentMode === 'streaming' || currentMode === 'streaming-voice';
    if (!isCompressed && filePath) {
      finalizeWav(filePath, totalDataBytes);
    }

    const result = filePath;
    writeStream = null;
    console.log('[useMicRecording] Stopped', { file: result, bytes: totalDataBytes });
    filePath = '';
    totalDataBytes = 0;
    pending = Buffer.alloc(0);
    return result;
  }

  return {
    level,
    active,
    bytesWritten,
    start,
    stop,
    setPaused,
  };
}
