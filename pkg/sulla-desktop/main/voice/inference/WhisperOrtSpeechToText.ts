// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ModelRepository } from '../engine/ModelRepository';
import type { SpeechToText, TranscriptEvent, VoiceLogger } from '../engine/VoiceEngines';
import { OrtInferenceClient } from './OrtInferenceClient';

/** Chunked, CPU-only Whisper tiny adapter; one call represents one <=30s utterance at 16 kHz. */
export class WhisperOrtSpeechToText implements SpeechToText {
  static readonly maxSamples = 30 * 16_000;

  constructor(
    private readonly models: ModelRepository,
    private readonly client: OrtInferenceClient,
    private readonly logger: VoiceLogger,
  ) {}

  async transcribe(
    audio: AsyncIterable<Float32Array>,
    sequenceId: number,
    signal: AbortSignal,
  ): Promise<TranscriptEvent[]> {
    try {
      const chunks: Float32Array[] = [];
      let length = 0;
      for await (const chunk of audio) {
        if (signal.aborted) return [];
        length += chunk.length;
        if (length > WhisperOrtSpeechToText.maxSamples) throw new Error('Whisper utterance exceeds 30 seconds');
        chunks.push(chunk);
      }
      if (signal.aborted || length === 0) return [];
      const samples = new Float32Array(length);
      let offset = 0;
      for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
      const [encoder, decoder, tokenizer] = await Promise.all([
        this.models.resolve('stt-whisper-tiny-encoder-q8', signal),
        this.models.resolve('stt-whisper-tiny-decoder-merged-q8', signal),
        this.models.resolve('stt-whisper-tiny-tokenizer', signal),
      ]);
      if (signal.aborted) return [];
      const result = await this.client.infer({
        operation: 'stt', modelPath: encoder, decoderPath: decoder, tokenizerPath: tokenizer,
        audio: samples, sequenceId,
      }, signal, 120_000);
      if (!result.ok || result.text === undefined || signal.aborted) return [];
      return [{ kind: 'final', text: result.text, sequenceId }];
    } catch (error) {
      if (!signal.aborted) this.logger.debug('Local Whisper transcription unavailable; retaining existing STT path', error);
      return [];
    }
  }
}
