/**
 * VoiceLogger — unified, grep-friendly voice event logging.
 *
 * All voice events flow through `vlog(component, event, data)` which:
 *   1. Writes to DevTools console for live debugging
 *   2. Sends via IPC to ConversationLogger for persistent, searchable log files
 *
 * Log format (in the persistent log file):
 *   [2026-03-20T12:00:00.000Z] [VOICE:TTS:ENQUEUE] text="Hello" queueLen=0
 *
 * Components:
 *   REC     — Microphone recording lifecycle (start, stop)
 *   VAD     — Voice Activity Detection (speech detected, silence)
 *   STT     — Speech-to-text transcription results
 *   PIPE    — VoicePipeline state machine (state transitions, flush, barge-in)
 *   TTS     — TTSPlayerService playback queue (enqueue, play, stop)
 *   TIMING  — Round-trip latency measurements
 *
 * How to search logs:
 *   grep "VOICE:TTS"             — all TTS events
 *   grep "VOICE:PIPE:FLUSH"      — all pipeline flushes
 *   grep "VOICE:PIPE:STATE"      — all state transitions
 *   grep "VOICE:STT:TRANSCRIPT"  — all transcription results
 *   grep "VOICE:TTS:ENQUEUE"     — every time TTS is queued (includes caller trace)
 *   grep "VOICE:TIMING"          — all latency measurements
 *   grep "seq="                   — correlate events within a single voice turn
 *
 * Backend (BaseNode.ts) uses the same tag format via ConversationLogger directly:
 *   grep "VOICE:LLM"             — all LLM-side speak extraction events
 *   grep "VOICE:WS"              — WebSocket speak dispatch events
 */

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Voice system component identifiers.
 * Used as the middle segment of the log tag: VOICE:<Component>:<Event>
 */
export type VoiceComponent = 'REC' | 'VAD' | 'STT' | 'PIPE' | 'TTS' | 'TIMING';

// ─── Context ────────────────────────────────────────────────────

let _threadId = '';
let _channel  = 'sulla-desktop';

/**
 * Set the active thread context for voice logging.
 * Call this whenever the chat thread changes so log entries
 * land in the correct thread log file.
 */
export function setVoiceLogContext(threadId: string, channel = 'sulla-desktop'): void {
  _threadId = threadId;
  _channel  = channel;
}

// ─── Core Logger ────────────────────────────────────────────────

/**
 * Log a voice event. This is the single entry point for ALL frontend voice logging.
 *
 * @param component - Which subsystem produced the event (REC, VAD, STT, PIPE, TTS, TIMING)
 * @param event     - What happened (START, STOP, ENQUEUE, FLUSH, etc.)
 * @param data      - Key-value pairs to include in the log line
 *
 * Produces a tag like `VOICE:TTS:ENQUEUE` which appears in both:
 *   - DevTools console (for live debugging)
 *   - Persistent log file at ~/sulla/logs/ (via IPC → ConversationLogger)
 */
export function vlog(component: VoiceComponent, event: string, data: Record<string, unknown> = {}): void {
  const tag = `VOICE:${ component }:${ event }`;

  // Format key=value pairs for console output
  const pairs = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      if (typeof v === 'string') {
        return `${ k }="${ v.length > 120 ? v.slice(0, 120) + '…' : v }"`;
      }

      return `${ k }=${ v }`;
    })
    .join(' ');

  console.log(`[${ tag }] ${ pairs }`);

  // Send to main process for persistent logging
  if (!_threadId) return;

  try {
    ipcRenderer.send('voice-log', {
      type:     tag,
      ts:       new Date().toISOString(),
      threadId: _threadId,
      channel:  _channel,
      ...data,
    });
  } catch {
    // Renderer may not be connected yet — swallow silently
  }
}

// ─── Recording Events (REC) ─────────────────────────────────────

/** Microphone recording started. Logged when VoiceRecorderService.start() acquires the mic. */
export function logRecordingStart(mode: string): void {
  vlog('REC', 'START', { mode });
}

/** Microphone recording stopped. Logged when VoiceRecorderService.stop() is called. */
export function logRecordingStop(duration: string): void {
  vlog('REC', 'STOP', { duration });
}

/** Microphone or transcription error. */
export function logVoiceError(message: string): void {
  vlog('REC', 'ERROR', { message });
}

// ─── VAD Events (VAD) ───────────────────────────────────────────

/**
 * VAD detected speech — audio RMS exceeded threshold.
 * This triggers the pipeline to transition IDLE → LISTENING.
 */
export function logVADSpeechStart(rms: number, threshold: number): void {
  vlog('VAD', 'SPEECH_START', { rms: Math.round(rms * 10) / 10, threshold });
}

/**
 * VAD detected silence onset — audio RMS dropped below threshold.
 * Silence timer starts; if it exceeds vadSilenceDuration, segment is flushed.
 */
export function logVADSilenceStart(rms: number, threshold: number): void {
  vlog('VAD', 'SILENCE_START', { rms: Math.round(rms * 10) / 10, threshold });
}

/**
 * VAD confirmed silence — silence duration exceeded threshold.
 * This triggers the batch segment to be flushed for transcription.
 */
export function logVADSilenceConfirmed(silenceDurationMs: number): void {
  vlog('VAD', 'SILENCE_CONFIRMED', { silenceDurationMs });
}

// ─── STT Events (STT) ──────────────────────────────────────────

/**
 * Transcription result received from STT engine (ElevenLabs or browser).
 * This is the raw result before any non-speech filtering.
 */
export function logTranscription(text: string, speaker?: string): void {
  vlog('STT', 'TRANSCRIPT', { text: text.slice(0, 500), speaker: speaker ?? 'unknown' });
}

/**
 * Non-speech audio was filtered out (e.g. [background noise], [music]).
 * The raw text contained only bracketed labels — no actual speech.
 */
export function logTranscriptionFiltered(rawText: string): void {
  vlog('STT', 'FILTERED', { rawText: rawText.slice(0, 200) });
}

// ─── Pipeline Events (PIPE) ────────────────────────────────────

/**
 * Pipeline state machine transition (e.g. IDLE → LISTENING, THINKING → SPEAKING).
 * The state machine drives which events are handled and what UI is shown.
 */
export function logPipelineState(from: string, to: string): void {
  vlog('PIPE', 'STATE', { from, to });
}

/**
 * Barge-in detected — user started speaking while TTS was playing or graph was running.
 * This stops TTS playback and aborts any in-progress graph run.
 */
export function logBargeIn(): void {
  vlog('PIPE', 'BARGE_IN');
}

/**
 * Silence detected by pipeline — triggers flush in voice mode.
 * (This is the pipeline's response to VAD silence, not the VAD event itself.)
 */
export function logSilence(): void {
  vlog('PIPE', 'SILENCE');
}

/**
 * Pipeline flushed accumulated voice buffer and sent it as a user message.
 * seq is the pipeline sequence counter (correlates with all subsequent events for this turn).
 */
export function logFlush(seq: number, mode: string, text: string): void {
  vlog('PIPE', 'FLUSH', { seq, mode, text: text.slice(0, 500) });
}

/** Speaker change detected — previous speaker's buffer was flushed. */
export function logSpeakerChange(from: string | undefined, to: string | undefined): void {
  vlog('PIPE', 'SPEAKER_CHANGE', { from: from ?? 'none', to: to ?? 'none' });
}

/**
 * VoicePipeline.detectSpeakMessages() found a message with kind='speak'.
 * This is the SOLE frontend entry point for TTS — if this doesn't fire, TTS shouldn't play.
 * The message was created by AgentPersonaModel from a speak_dispatch WebSocket event.
 */
export function logSpeakDetected(messageId: string, kind: string, content: string): void {
  vlog('PIPE', 'SPEAK_DETECTED', { messageId, kind, content: content.slice(0, 200) });
}

// ─── TTS Events (TTS) ──────────────────────────────────────────

/**
 * Text enqueued for TTS playback. Includes the caller stack trace so we can
 * trace exactly which code path initiated the TTS request.
 * Search: grep "VOICE:TTS:ENQUEUE" to see every TTS enqueue with its caller.
 */
export function logTTSEnqueue(text: string, callerStack: string): void {
  vlog('TTS', 'ENQUEUE', { text: text.slice(0, 200), caller: callerStack });
}

/** TTS playback started for a sentence. seq is TTSPlayerService's internal sequence. */
export function logTTSPlayStart(text: string, seq: number, remaining: number): void {
  vlog('TTS', 'PLAY_START', { text: text.slice(0, 200), seq, remaining });
}

/** TTS audio finished playing for a sentence. */
export function logTTSPlayEnd(text: string, durationMs: number): void {
  vlog('TTS', 'PLAY_END', { text: text.slice(0, 200), durationMs });
}

/** TTS stop() called — queue cleared, prefetch cancelled, audio paused. */
export function logTTSStop(): void {
  vlog('TTS', 'STOP');
}

/** TTS text was deduplicated (same content within 10s window or same message ID). */
export function logTTSDedup(text: string): void {
  vlog('TTS', 'DEDUP', { text: text.slice(0, 200) });
}

/** TTS fell back to browser SpeechSynthesis because IPC audio-speak failed. */
export function logTTSFallback(text: string): void {
  vlog('TTS', 'FALLBACK', { text: text.slice(0, 200) });
}

// ─── Round-Trip Timing (TIMING) ─────────────────────────────────

/**
 * Tracks timing milestones for a single voice turn so we can measure
 * each leg of the round trip: speech → transcription → flush → LLM → TTS → audio.
 *
 * Call order:
 *   1. timingSpeechStart()    — when VAD detects speech
 *   2. timingTranscription()  — when STT returns text
 *   3. timingFlush(seq)       — when pipeline flushes buffer
 *   4. timingFirstSpeak()     — when first speak message detected
 *   5. timingFirstAudio()     — when first TTS audio starts playing → logs ROUND_TRIP
 */
const _timing = {
  speechStartMs:   0,
  transcriptionMs: 0,
  flushMs:         0,
  firstSpeakMs:    0,
  firstAudioMs:    0,
  seq:             0,
};

/** Mark the start of a new voice turn (VAD speech detected). Resets all timing. */
export function timingSpeechStart(): void {
  _timing.speechStartMs = Date.now();
  _timing.transcriptionMs = 0;
  _timing.flushMs = 0;
  _timing.firstSpeakMs = 0;
  _timing.firstAudioMs = 0;
  vlog('TIMING', 'SPEECH_START');
}

/** Mark when STT transcription was received. Logs STT latency. */
export function timingTranscription(): void {
  _timing.transcriptionMs = Date.now();
  const sttMs = _timing.speechStartMs ? _timing.transcriptionMs - _timing.speechStartMs : 0;
  vlog('TIMING', 'STT_DONE', { sttMs });
}

/** Mark when pipeline flushed the buffer. Logs buffer delay. */
export function timingFlush(seq: number): void {
  _timing.flushMs = Date.now();
  _timing.seq = seq;
  const bufferMs = _timing.transcriptionMs ? _timing.flushMs - _timing.transcriptionMs : 0;
  const totalMs = _timing.speechStartMs ? _timing.flushMs - _timing.speechStartMs : 0;
  vlog('TIMING', 'FLUSH', { seq, bufferMs, totalMs });
}

/** Mark when first speak message was detected. Logs LLM latency. */
export function timingFirstSpeak(): void {
  if (_timing.firstSpeakMs) return; // only first speak matters
  _timing.firstSpeakMs = Date.now();
  const llmMs = _timing.flushMs ? _timing.firstSpeakMs - _timing.flushMs : 0;
  const totalMs = _timing.speechStartMs ? _timing.firstSpeakMs - _timing.speechStartMs : 0;
  vlog('TIMING', 'FIRST_SPEAK', { llmMs, totalMs });
}

/**
 * Mark when first TTS audio started playing. Logs TTS generation latency
 * and the FULL ROUND TRIP from speech to audio output.
 * This is the final timing event for a voice turn.
 */
export function timingFirstAudio(): void {
  if (_timing.firstAudioMs) return; // only first audio matters
  _timing.firstAudioMs = Date.now();
  const ttsGenMs = _timing.firstSpeakMs ? _timing.firstAudioMs - _timing.firstSpeakMs : 0;
  const roundTripMs = _timing.speechStartMs ? _timing.firstAudioMs - _timing.speechStartMs : 0;
  vlog('TIMING', 'ROUND_TRIP', {
    seq:         _timing.seq,
    sttMs:       _timing.transcriptionMs ? _timing.transcriptionMs - _timing.speechStartMs : 0,
    bufferMs:    _timing.flushMs && _timing.transcriptionMs ? _timing.flushMs - _timing.transcriptionMs : 0,
    llmMs:       _timing.firstSpeakMs && _timing.flushMs ? _timing.firstSpeakMs - _timing.flushMs : 0,
    ttsGenMs,
    roundTripMs,
  });
}

// ─── Legacy Exports ─────────────────────────────────────────────
// These aliases maintain backward compatibility with existing callers
// while everything is being migrated to vlog() directly.

/** @deprecated Use logTTSEnqueue instead */
export const logTTSEnqueueTrace = logTTSEnqueue;
/** @deprecated Use logTTSEnqueue instead — now merged into ENQUEUE event */
export function logTTSQueued(text: string, queueLen: number): void {
  // This is now a no-op — the ENQUEUE event in logTTSEnqueue covers this.
  // Kept for import compatibility during migration.
}
