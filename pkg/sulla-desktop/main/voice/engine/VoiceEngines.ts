// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Turn-correlated events emitted by local voice engines. */
export interface VoiceEvent {
  sequenceId: number;
}

export interface VadEvent extends VoiceEvent {
  kind: 'speech-start' | 'speech-end';
  timestampMs: number;
}

export interface TranscriptEvent extends VoiceEvent {
  kind: 'partial' | 'final';
  text: string;
}

export interface AudioChunk extends VoiceEvent {
  data: Uint8Array;
  sampleRate: number;
}

export interface SemanticTurnResult {
  complete: boolean | 'unknown';
  probability: number;
}

export interface Vad {
  process(frame: Float32Array, sequenceId: number, signal: AbortSignal): Promise<VadEvent[]>;
}

export interface SpeechToText {
  transcribe(audio: AsyncIterable<Float32Array>, sequenceId: number, signal: AbortSignal): Promise<TranscriptEvent[]>;
}

export interface TextToSpeech {
  synthesize(text: string, sequenceId: number, signal: AbortSignal): AsyncIterable<AudioChunk>;
}

export interface SemanticEndOfTurn {
  classify(audio: Float32Array, transcript: string, sequenceId: number, signal: AbortSignal): Promise<SemanticTurnResult>;
}

export interface VoiceLogger {
  debug(message: string, details?: unknown): void;
}

/** Injected scheduler so timeout behavior stays deterministic under test. */
export interface VoiceTimer {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
