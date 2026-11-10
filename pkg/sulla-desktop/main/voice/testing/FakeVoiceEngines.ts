// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  AudioChunk,
  SemanticEndOfTurn,
  SemanticTurnResult,
  SpeechToText,
  TextToSpeech,
  TranscriptEvent,
  Vad,
  VadEvent,
} from '../engine/VoiceEngines';

/** Deterministic fake VAD for engine-contract tests. */
export class FakeVad implements Vad {
  constructor(private readonly events: VadEvent[] = []) {}

  async process(_frame: Float32Array, _id: number, signal: AbortSignal): Promise<VadEvent[]> {
    if (signal.aborted) {
      throw new Error('aborted');
    }
    return [...this.events];
  }
}

/** Deterministic fake transcription adapter. */
export class FakeSpeechToText implements SpeechToText {
  constructor(private readonly events: TranscriptEvent[] = []) {}

  async transcribe(_audio: AsyncIterable<Float32Array>, _id: number, signal: AbortSignal): Promise<TranscriptEvent[]> {
    if (signal.aborted) {
      throw new Error('aborted');
    }
    return [...this.events];
  }
}

/** Fake TTS that observes cancellation before every emitted chunk. */
export class FakeTextToSpeech implements TextToSpeech {
  constructor(private readonly chunks: AudioChunk[] = []) {}

  async *synthesize(_text: string, _id: number, signal: AbortSignal): AsyncGenerator<AudioChunk> {
    for (const chunk of this.chunks) {
      if (signal.aborted) {
        return;
      }
      yield chunk;
    }
  }
}

/** Fake semantic endpoint classifier, configurable with a result or failure. */
export class FakeSemanticEndOfTurn implements SemanticEndOfTurn {
  constructor(private readonly result: SemanticTurnResult | Error = { complete: 'unknown', probability: 0 }) {}

  async classify(_audio: Float32Array, _text: string, _id: number, signal: AbortSignal): Promise<SemanticTurnResult> {
    if (signal.aborted) {
      throw new Error('aborted');
    }
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
}
