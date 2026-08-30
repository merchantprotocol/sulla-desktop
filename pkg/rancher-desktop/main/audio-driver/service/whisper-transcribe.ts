/**
 * Service — speech-to-text transcription.
 *
 * Sits on top of the audio driver. Consumes PCM audio from the existing
 * capture pipeline and produces transcript events in the same format as
 * the gateway (transcript_turn / transcript_partial), so existing UI
 * code (SecretaryModeController, ChatInterface) works unchanged.
 *
 * The buffering / VAD-gated segmentation / 2s flush cadence is provider-
 * agnostic; only the per-segment engine differs:
 *   - `whisper` (default) — local whisper.cpp, fully offline.
 *   - `grok`             — xAI Grok STT (`POST https://api.x.ai/v1/stt`).
 * The provider (and Grok api key) are chosen per-session in start().
 *
 * Two modes:
 *   - conversation: mic channel only → transcript sent to Sulla chat
 *   - secretary:    mic + speaker channels → transcripts shown in secretary screen
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../model/logger';
import * as whisperModel from '../model/whisper';
import { MeterableUsageModel } from '../../../agent/database/models/MeterableUsageModel';

// ─── Types ──────────────────────────────────────────────────

export type TranscribeMode = 'conversation' | 'secretary';

/** STT engine. `whisper` = local whisper.cpp; `grok` = xAI Grok STT. */
export type SttProvider = 'whisper' | 'grok';

const GROK_STT_URL = 'https://api.x.ai/v1/stt';

export interface TranscriptEvent {
  // `utterance_end` is an additive end-of-turn signal (conversation mode only):
  // the user has stopped speaking (VAD silent) AND the transcription pipeline has
  // drained, so the renderer can commit the accumulated turn as ONE message.
  event_type: 'transcript_turn' | 'transcript_partial' | 'utterance_end';
  text:       string;
  speaker?:   string;
  channel?:   number;
}

type TranscriptCallback = (event: TranscriptEvent) => void;

// ─── Configuration ──────────────────────────────────────────

const SEGMENT_MS = 2000;   // flush and transcribe every 2 seconds for responsive tracking
// End-of-turn: how long the mic must be silent (no VAD-gated audio fed) before we
// consider the utterance finished. Must be comfortably ABOVE nothing-in-flight, and
// is only meaningful once the pipeline has drained (micBytes === 0 && !transcribing).
const END_OF_TURN_MS = 1200;
const END_OF_TURN_POLL_MS = 250;   // how often we check for end-of-turn
// Once the mic goes quiet mid-buffer, flush the trailing partial early instead of
// waiting for the next 2s tick — makes end-of-turn noticeably snappier.
const EARLY_FLUSH_SILENCE_MS = 500;
const SAMPLE_RATE = 16000;  // whisper expects 16kHz
const BYTES_PER_SAMPLE = 2;      // 16-bit signed LE
const CHANNELS = 1;      // mono
const SILENCE_THRESHOLD = 50;     // RMS below this is silence — skip transcription
const MAX_BUFFER_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 30; // 30s max before forced flush

// ─── State ──────────────────────────────────────────────────

let mode: TranscribeMode | null = null;
let onTranscript: TranscriptCallback | null = null;
let language = 'en';
let modelName = 'base.en';
let profileId = 'default';
let sessionId = '';
let sessionStartedAt = 0;

// STT engine for this session. Defaults to local whisper; the transcribe-start
// IPC handler passes `grok` + the api key when the user selects Grok STT.
let provider: SttProvider = 'whisper';
let grokApiKey: string | null = null;

// Per-channel PCM accumulators (raw s16le, 16kHz, mono)
const micBuffer: Buffer[] = [];
const speakerBuffer: Buffer[] = [];
let micBytes = 0;
let speakerBytes = 0;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let endOfTurnTimer: ReturnType<typeof setInterval> | null = null;
let transcribing = false;

// End-of-turn tracking (conversation mode). `lastMicFedAt` is the wall-clock of the
// most recent VAD-gated mic chunk — since PCM is only delivered while speaking, the
// gap since then is real silence. `utteranceOpen` guards a single utterance_end per turn.
let lastMicFedAt = 0;
let utteranceOpen = false;

// Full-utterance PCM (conversation mode). Each 2s segment is transcribed live as a
// partial for feedback, but its PCM is ALSO kept here so the complete utterance can be
// re-transcribed once at end-of-turn — one authoritative pass with full context, free of
// the mid-word cuts you get from transcribing fixed 2s slices independently.
const utterancePcm: Buffer[] = [];
let utterancePcmBytes = 0;
const tmpDir = path.join(os.tmpdir(), 'sulla-whisper');

// ─── Public API ─────────────────────────────────────────────

export function start(opts: {
  mode:         TranscribeMode;
  onTranscript: TranscriptCallback;
  language?:    string;
  model?:       string;
  provider?:    SttProvider;
  grokApiKey?:  string | null;
  profileId?:    string;
  sessionId?:    string;
}): boolean {
  const useGrok = opts.provider === 'grok';

  // Grok STT needs an api key; local whisper needs the binary + a model.
  if (useGrok) {
    if (!opts.grokApiKey) {
      log.error('WhisperTranscribe', 'Cannot start — Grok STT selected but no xAI api key');
      return false;
    }
  } else if (!whisperModel.isAvailable()) {
    log.error('WhisperTranscribe', 'Cannot start — whisper.cpp not installed');
    return false;
  }

  const status = whisperModel.getStatus();
  const models = status?.models ?? [];
  const requestedModel = opts.model || modelName;

  if (!useGrok && models.length === 0) {
    log.error('WhisperTranscribe', 'Cannot start — no whisper models downloaded');
    return false;
  }

  // If already running, just update the callback — don't reset buffers or
  // create duplicate flush timers. Multiple services (teleprompter, secretary)
  // share the same whisper instance.
  if (mode !== null && flushTimer) {
    log.info('WhisperTranscribe', 'Already running — updating callback only', { mode: opts.mode });
    onTranscript = opts.onTranscript;
    return true;
  }

  provider = opts.provider || 'whisper';
  grokApiKey = opts.grokApiKey || null;
  profileId = opts.profileId?.trim() || 'default';
  sessionId = opts.sessionId?.trim() || `transcription-${ Date.now() }`;
  sessionStartedAt = Date.now();

  // Use requested model if available, otherwise first available model (whisper only)
  modelName = models.includes(requestedModel) ? requestedModel : (models[0] || modelName);
  mode = opts.mode;
  onTranscript = opts.onTranscript;
  language = opts.language || 'en';

  // Ensure tmp directory
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Clear buffers
  resetBuffers();

  // Start periodic flush
  flushTimer = setInterval(() => flush(), SEGMENT_MS);

  // End-of-turn detection runs only in conversation mode (drives voice-chat turn
  // commit). Secretary mode keeps its own renderer-side turn accumulator.
  lastMicFedAt = 0;
  utteranceOpen = false;
  if (mode === 'conversation') {
    endOfTurnTimer = setInterval(() => checkEndOfTurn(), END_OF_TURN_POLL_MS);
  }

  log.info('WhisperTranscribe', 'Started', { mode, language, model: modelName });
  return true;
}

export function stop(): void {
  const elapsedMinutes = sessionStartedAt > 0 ? (Date.now() - sessionStartedAt) / 60000 : 0;
  if (elapsedMinutes > 0 && sessionId) {
    void MeterableUsageModel.accrue({
      profileId,
      dimension: 'transcription_minutes',
      quantity: Math.ceil(elapsedMinutes),
      idempotencyKey: sessionId,
      source: `transcription:${ provider }`,
      metadata: { mode, provider, sessionId },
    }).catch(() => { /* accounting must never break stopping transcription */ });
  }
  sessionStartedAt = 0;
  sessionId = '';
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (endOfTurnTimer) {
    clearInterval(endOfTurnTimer);
    endOfTurnTimer = null;
  }
  lastMicFedAt = 0;
  utteranceOpen = false;
  utterancePcm.length = 0;
  utterancePcmBytes = 0;

  // Final flush
  flush();

  mode = null;
  onTranscript = null;
  provider = 'whisper';
  grokApiKey = null;
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

  // PCM is VAD-gated upstream (only delivered while speaking), so any feed marks
  // an in-progress utterance and refreshes the silence clock.
  if (mode === 'conversation') {
    utteranceOpen = true;
    lastMicFedAt = Date.now();
  }

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

    if (mode === 'conversation') {
      // Keep the segment's PCM for the end-of-turn re-transcription, and show a live
      // partial now for immediate feedback (not committed — the final pass is).
      utterancePcm.push(pcm);
      utterancePcmBytes += pcm.length;
      transcribeChunk(pcm, 0, 'You', { partial: true });
    } else {
      transcribeChunk(pcm, 0, 'Mic');
    }
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
 * End-of-turn detector (conversation mode). Runs on a fast poll. Because mic PCM is
 * VAD-gated upstream, "no audio fed for a while" is genuine user silence. We flush any
 * trailing partial early, then — once the pipeline has fully drained — emit a single
 * `utterance_end` so the renderer can commit the whole turn as one message.
 */
function checkEndOfTurn(): void {
  if (mode !== 'conversation' || !utteranceOpen) return;

  const silentFor = Date.now() - lastMicFedAt;

  // Speech paused mid-buffer — transcribe the trailing partial now rather than
  // waiting up to SEGMENT_MS for the next tick.
  if (micBytes > 0 && !transcribing && silentFor >= EARLY_FLUSH_SILENCE_MS) {
    flush();
    return;
  }

  // Pipeline drained (no pending audio, no in-flight inference) and silence has
  // held past the threshold → the utterance is over. Re-transcribe the whole thing
  // once for an authoritative transcript, then signal end-of-turn.
  if (micBytes === 0 && !transcribing && silentFor >= END_OF_TURN_MS) {
    utteranceOpen = false;
    log.debug('WhisperTranscribe', 'utterance_end', { silentFor });
    finalizeUtterance();
  }
}

/**
 * End-of-turn finalization (conversation mode). Re-transcribes the full buffered
 * utterance once — one authoritative, boundary-clean transcript_turn — then emits
 * `utterance_end` so the renderer commits. Falls back to a bare `utterance_end`
 * when there's no buffered audio (e.g. only silence was captured).
 */
function finalizeUtterance(): void {
  const emitEnd = () => {
    if (onTranscript) onTranscript({ event_type: 'utterance_end', text: '', speaker: 'You', channel: 0 });
  };

  if (utterancePcmBytes === 0) {
    emitEnd();
    return;
  }

  const pcm = Buffer.concat(utterancePcm);
  utterancePcm.length = 0;
  utterancePcmBytes = 0;

  // whisper runs ~real-time; give the full pass generous, length-scaled headroom so a
  // long utterance isn't truncated by the default 10s per-chunk timeout.
  const audioSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  const timeoutMs = Math.min(60_000, Math.max(10_000, Math.ceil(audioSec) * 1500 + 5_000));
  log.debug('WhisperTranscribe', 'finalize re-transcribe', { audioSec: Math.round(audioSec), timeoutMs });

  transcribeChunk(pcm, 0, 'You', { partial: false, timeoutMs, onDone: emitEnd });
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

interface TranscribeOpts {
  /** Emit as an interim `transcript_partial` rather than a committed `transcript_turn`. */
  partial?:   boolean;
  /** Override the inference timeout (ms) — used for the length-scaled full-utterance pass. */
  timeoutMs?: number;
  /** Always invoked once the attempt settles (success, blank, or failure) so callers can chain. */
  onDone?:    () => void;
}

/**
 * Write PCM to a temp WAV file and run whisper-cpp on it. `onDone` always fires on
 * completion (any outcome) so end-of-turn finalization can chain reliably.
 */
function transcribeChunk(pcm: Buffer, channel: number, speakerLabel: string, opts: TranscribeOpts = {}): void {
  const done = opts.onDone;
  const eventType: TranscriptEvent['event_type'] = opts.partial ? 'transcript_partial' : 'transcript_turn';

  if (isSilent(pcm)) {
    log.debug('WhisperTranscribe', 'Skipping silent chunk', { channel, bytes: pcm.length });
    done?.();
    return;
  }

  // Cloud engine: transcribe the segment via Grok STT instead of local whisper.
  if (provider === 'grok' && grokApiKey) {
    transcribeChunkGrok(pcm, channel, speakerLabel, opts);
    return;
  }

  const wavPath = path.join(tmpDir, `ch${ channel }-${ Date.now() }.wav`);

  writeWav(wavPath, pcm);

  const status = whisperModel.getStatus();

  if (!status?.binaryPath || !status?.modelsPath) {
    log.error('WhisperTranscribe', 'Missing binary or models path');
    cleanupFile(wavPath);
    done?.();
    return;
  }

  const modelPath = path.join(status.modelsPath, `ggml-${ modelName }.bin`);

  if (!fs.existsSync(modelPath)) {
    log.error('WhisperTranscribe', 'Model file not found', { modelPath });
    cleanupFile(wavPath);
    done?.();
    return;
  }

  transcribing = true;

  // Use 2 threads max — whisper shares CPU with LlamaCpp and other services.
  // 4 threads caused whisper-cli to hang under contention.
  const threads = Math.min(os.cpus().length, 2);

  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', language,
    '--no-timestamps',
    '-nt',             // no-timestamps shorthand
    '--print-special', 'false',
    '-t', String(threads),
  ];

  const timeoutMs = opts.timeoutMs ?? 10000;

  log.debug('WhisperTranscribe', 'Running whisper', { channel, wavPath, model: modelName, threads, timeoutMs });

  // Timeout — if whisper hangs (CPU contention with LlamaCpp), release the mutex so the
  // next flush can try again with fresh audio.
  execFile(status.binaryPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
    transcribing = false;
    cleanupFile(wavPath);

    if (err) {
      const isTimeout = (err as any).killed || err.message?.includes('TIMEOUT');
      if (isTimeout) {
        log.warn('WhisperTranscribe', 'whisper-cpp timed out — skipping chunk', { channel, timeoutMs });
      } else {
        log.error('WhisperTranscribe', 'whisper-cpp failed', { error: err.message, stderr });
      }
      done?.();
      return;
    }

    const text = stdout
      .replace(/\[.*?\]/g, '')  // strip any timestamp artifacts
      .trim();

    if (!text || text === '[BLANK_AUDIO]' || text.length < 2) {
      log.debug('WhisperTranscribe', 'Blank/empty transcript — skipping', { channel, text: text || '(empty)' });
      done?.();
      return;
    }

    log.info('WhisperTranscribe', 'Transcript', { channel, speaker: speakerLabel, text: text.substring(0, 80), partial: !!opts.partial });

    if (onTranscript) {
      onTranscript({
        event_type: eventType,
        text,
        speaker:    speakerLabel,
        channel,
      });
    }

    done?.();
  });
}

/**
 * Build a valid WAV (RIFF header + PCM data) in memory.
 */
function buildWav(pcm: Buffer): Buffer {
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

  return Buffer.concat([header, pcm]);
}

/**
 * Write raw PCM data as a valid WAV file (RIFF header + data).
 */
function writeWav(filePath: string, pcm: Buffer): void {
  fs.writeFileSync(filePath, buildWav(pcm));
}

/**
 * Grok STT engine — transcribe a PCM segment via `POST https://api.x.ai/v1/stt`.
 * Wraps the segment as WAV and uploads it as multipart/form-data (the `file`
 * field must come after the other fields per the xAI API). Emits the same
 * transcript_turn event whisper does, so all downstream UI is unchanged.
 */
function transcribeChunkGrok(pcm: Buffer, channel: number, speakerLabel: string, opts: TranscribeOpts = {}): void {
  const eventType: TranscriptEvent['event_type'] = opts.partial ? 'transcript_partial' : 'transcript_turn';
  const wav = buildWav(pcm);

  transcribing = true;

  const form = new FormData();

  form.append('language', language);
  // `file` must be appended last (xAI multipart requirement).
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), `ch${ channel }.wav`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);

  fetch(GROK_STT_URL, {
    method:  'POST',
    signal:  controller.signal,
    headers: { Authorization: `Bearer ${ grokApiKey }` },
    body:    form,
  })
    .then(async(response) => {
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn('WhisperTranscribe', 'Grok STT failed', { status: response.status, body: body.slice(0, 200) });
        return;
      }

      const data = await response.json() as { text?: string };
      const text = (data.text || '').trim();

      if (!text || text.length < 2) {
        log.debug('WhisperTranscribe', 'Grok STT blank/empty — skipping', { channel });
        return;
      }

      log.info('WhisperTranscribe', 'Grok transcript', { channel, speaker: speakerLabel, text: text.substring(0, 80) });

      if (onTranscript) {
        onTranscript({
          event_type: eventType,
          text,
          speaker:    speakerLabel,
          channel,
        });
      }
    })
    .catch((err) => {
      log.warn('WhisperTranscribe', 'Grok STT request error', { error: err?.message });
    })
    .finally(() => {
      clearTimeout(timeout);
      transcribing = false;
      opts.onDone?.();
    });
}

function cleanupFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch { /* best effort */ }
}
