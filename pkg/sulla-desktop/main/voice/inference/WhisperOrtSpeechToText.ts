// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ModelRepository } from '../engine/ModelRepository';
import type { SpeechToText, TranscriptEvent, VoiceLogger } from '../engine/VoiceEngines';
import { OrtInferenceClient } from './OrtInferenceClient';
import { WhisperWindowPlanner } from './WhisperWindowPlanner';

/** CPU-only Whisper tiny adapter; long utterances are decoded in ordered <=30s windows. */
export class WhisperOrtSpeechToText implements SpeechToText {
  constructor(
    private readonly models: ModelRepository,
    private readonly client: OrtInferenceClient,
    private readonly logger: VoiceLogger,
    private readonly windows = new WhisperWindowPlanner(),
  ) {}

  async transcribe(
    audio: AsyncIterable<Float32Array>,
    sequenceId: number,
    signal: AbortSignal,
  ): Promise<TranscriptEvent[]> {
    const chunks: Float32Array[] = [];
    let length = 0;
    for await (const chunk of audio) {
      if (signal.aborted) return [];
      if (chunk.length) { chunks.push(chunk); length += chunk.length; }
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
    const texts: string[] = [];
    for (const window of this.windows.plan(samples)) {
      if (signal.aborted) return [];
      let result;
      try {
        result = await this.client.infer({
          operation: 'stt', modelPath: encoder, decoderPath: decoder, tokenizerPath: tokenizer,
          audio: window, sequenceId,
        }, signal, 120_000);
      } catch (error) {
        if (signal.aborted) return [];
        this.logger.debug('Local Whisper transcription failed; caller may use fallback STT', error);
        throw error;
      }
      if (signal.aborted) return [];
      if (!result.ok) throw new Error(result.error ?? 'Whisper inference failed');
      if (result.text === undefined) throw new Error('Whisper inference returned no text');
      if (result.text.trim()) texts.push(result.text.trim());
    }
    return [{ kind: 'final', text: texts.join(' '), sequenceId }];
  }
}
