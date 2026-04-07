/**
 * Service — local whisper.cpp transcription.
 *
 * Sits on top of the audio driver. Consumes PCM audio from the existing
 * capture pipeline and produces transcript events in the same format as
 * the gateway (transcript_turn / transcript_partial), so existing UI
 * code (SecretaryModeController, ChatInterface) works unchanged.
 *
 * Two modes:
 *   - conversation: mic channel only → transcript sent to Sulla chat
 *   - secretary:    mic + speaker channels → transcripts shown in secretary screen
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../model/logger';
import * as whisperModel from '../model/whisper';

// ─── Types ──────────────────────────────────────────────────

export type TranscribeMode = 'conversation' | 'secretary';

export interface TranscriptEvent {
  event_type: 'transcript_turn' | 'transcript_partial';
  text: string;
  speaker?: string;
  channel?: number;
}

type TranscriptCallback = (event: TranscriptEvent) => void;

// ─── Configuration ──────────────────────────────────────────

const SEGMENT_MS          = 5000;   // flush and transcribe every 5 seconds
const SAMPLE_RATE         = 16000;  // whisper expects 16kHz
const BYTES_PER_SAMPLE    = 2;      // 16-bit signed LE
const CHANNELS            = 1;      // mono
const SILENCE_THRESHOLD   = 50;     // RMS below this is silence — skip transcription
const MAX_BUFFER_BYTES    = SAMPLE_RATE * BYTES_PER_SAMPLE * 30; // 30s max before forced flush

// ─── State ──────────────────────────────────────────────────

let mode: TranscribeMode | null = null;
let onTranscript: TranscriptCallback | null = null;
let language = 'en';
let modelName = 'base.en';

// Per-channel PCM accumulators (raw s16le, 16kHz, mono)
const micBuffer: Buffer[] = [];
const speakerBuffer: Buffer[] = [];
let micBytes = 0;
let speakerBytes = 0;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let transcribing = false;
const tmpDir = path.join(os.tmpdir(), 'sulla-whisper');

// ─── Public API ─────────────────────────────────────────────

export function start(opts: {
  mode: TranscribeMode;
  onTranscript: TranscriptCallback;
  language?: string;
  model?: string;
}): boolean {
  if (!whisperModel.isAvailable()) {
    log.error('WhisperTranscribe', 'Cannot start — whisper.cpp not installed');
    return false;
  }

  const status = whisperModel.getStatus();
  const models = status?.models ?? [];
  const requestedModel = opts.model || modelName;

  if (models.length === 0) {
    log.error('WhisperTranscribe', 'Cannot start — no whisper models downloaded');
    return false;
  }

  // Use requested model if available, otherwise first available model
  modelName = models.includes(requestedModel) ? requestedModel : models[0];
  mode = opts.mode;
  onTranscript = opts.onTranscript;
  language = opts.language || 'en';

  // Ensure tmp directory
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Clear buffers
  resetBuffers();

  // Start periodic flush
  flushTimer = setInterval(() => flush(), SEGMENT_MS);

  log.info('WhisperTranscribe', 'Started', { mode, language, model: modelName });
  return true;
}

export function stop(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Final flush
  flush();

  mode = null;
  onTranscript = null;
  resetBuffers();
  log.info('WhisperTranscribe', 'Stopped');
}

export function isActive(): boolean {
  return mode !== null;
}

export function getMode(): TranscribeMode | null {
  return mode;
}

/** Stats for UI display — shows whether data is flowing and processing. */
export function getStats(): { active: boolean; mode: TranscribeMode | null; transcribing: boolean; micBytesReceived: number; micChunksReceived: number } {
  return {
    active:            mode !== null,
    mode,
    transcribing,
    micBytesReceived:  micBytes,
    micChunksReceived: micBuffer.length,
  };
}

/**
 * Feed microphone PCM data (s16le, 16kHz, mono).
 * Called from MicrophoneDriverController.onPcmData() — only when
 * VAD detects speech. Chunks are accumulated and flushed to
 * whisper.cpp periodically.
 */
export function feedMic(chunk: Buffer): void {
  if (!mode) return;
  micBuffer.push(chunk);
  micBytes += chunk.length;

  if (micBytes >= MAX_BUFFER_BYTES) flush();
}

/**
 * Feed speaker PCM data (s16le, 16kHz, mono).
 * Called from the speaker capture onAudio callback.
 * Only consumed in secretary mode.
 */
export function feedSpeaker(pcm: Buffer): void {
  if (mode !== 'secretary') return;
  speakerBuffer.push(pcm);
  speakerBytes += pcm.length;

  if (speakerBytes >= MAX_BUFFER_BYTES) flush();
}

// ─── Internal ───────────────────────────────────────────────

function resetBuffers(): void {
  micBuffer.length = 0;
  speakerBuffer.length = 0;
  micBytes = 0;
  speakerBytes = 0;
}

function flush(): void {
  if (transcribing) return;

  // Grab and clear mic buffer
  if (micBytes > 0) {
    const pcm = Buffer.concat(micBuffer);

    micBuffer.length = 0;
    micBytes = 0;
    transcribeChunk(pcm, 0, mode === 'conversation' ? 'You' : 'Mic');
  }

  // Grab and clear speaker buffer (secretary mode only)
  if (mode === 'secretary' && speakerBytes > 0) {
    const pcm = Buffer.concat(speakerBuffer);

    speakerBuffer.length = 0;
    speakerBytes = 0;
    transcribeChunk(pcm, 1, 'Speaker');
  }
}

/**
 * Checks if audio is silent by computing RMS of a PCM buffer.
 */
function isSilent(pcm: Buffer): boolean {
  const samples = pcm.length / BYTES_PER_SAMPLE;

  if (samples === 0) return true;

  let sumSq = 0;
  for (let i = 0; i < pcm.length; i += BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(i);

    sumSq += sample * sample;
  }

  const rms = Math.sqrt(sumSq / samples);

  return rms < SILENCE_THRESHOLD;
}

/**
 * Write PCM to a temp WAV file and run whisper-cpp on it.
 */
function transcribeChunk(pcm: Buffer, channel: number, speakerLabel: string): void {
  if (isSilent(pcm)) {
    log.debug('WhisperTranscribe', 'Skipping silent chunk', { channel, bytes: pcm.length });
    return;
  }

  const wavPath = path.join(tmpDir, `ch${ channel }-${ Date.now() }.wav`);

  writeWav(wavPath, pcm);

  const status = whisperModel.getStatus();

  if (!status?.binaryPath || !status?.modelsPath) {
    log.error('WhisperTranscribe', 'Missing binary or models path');
    cleanupFile(wavPath);
    return;
  }

  const modelPath = path.join(status.modelsPath, `ggml-${ modelName }.bin`);

  if (!fs.existsSync(modelPath)) {
    log.error('WhisperTranscribe', 'Model file not found', { modelPath });
    cleanupFile(wavPath);
    return;
  }

  transcribing = true;

  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', language,
    '--no-timestamps',
    '-nt',             // no-timestamps shorthand
    '--print-special', 'false',
    '-t', String(Math.min(os.cpus().length, 4)), // thread count capped at 4
  ];

  log.debug('WhisperTranscribe', 'Running whisper', { channel, wavPath, model: modelName });

  execFile(status.binaryPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
    transcribing = false;
    cleanupFile(wavPath);

    if (err) {
      log.error('WhisperTranscribe', 'whisper-cpp failed', { error: err.message, stderr });
      return;
    }

    const text = stdout
      .replace(/\[.*?\]/g, '')  // strip any timestamp artifacts
      .trim();

    if (!text || text === '[BLANK_AUDIO]' || text.length < 2) {
      return;
    }

    log.info('WhisperTranscribe', 'Transcript', { channel, speaker: speakerLabel, text: text.substring(0, 80) });

    if (onTranscript) {
      onTranscript({
        event_type: 'transcript_turn',
        text,
        speaker:    speakerLabel,
        channel,
      });
    }
  });
}

/**
 * Write raw PCM data as a valid WAV file (RIFF header + data).
 */
function writeWav(filePath: string, pcm: Buffer): void {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);              // chunk size
  header.writeUInt16LE(1, 20);               // PCM format
  header.writeUInt16LE(CHANNELS, 22);        // channels
  header.writeUInt32LE(SAMPLE_RATE, 24);     // sample rate
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);               // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);                      // bits per sample

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

function cleanupFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch { /* best effort */ }
}
