// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AudioChunk, TextToSpeech, VoiceLogger } from '../engine/VoiceEngines';
import type { KokoroSynthesis, KokoroSynthesizer, SpeechUnitSplitter } from './KokoroSynthesizer';
import { SynthesisUnitSplitter } from './SynthesisUnitSplitter';

export interface KokoroTextToSpeechOptions {
  /** Kokoro voice key (e.g. 'af_bella'); null lets the engine apply its default. */
  voiceKey?: string | null;
  speed?: number;
  splitter?: SpeechUnitSplitter;
}

/**
 * Speaks a full reply with Kokoro only, one sentence at a time, so the first audio arrives early.
 * Never falls back to a system voice: a sentence Kokoro cannot speak is logged and skipped.
 * The abort signal is checked before and after every synthesis call, and nothing is yielded after abort.
 */
export class KokoroTextToSpeech implements TextToSpeech {
  private readonly voiceKey: string | null;
  private readonly speed: number;
  private readonly splitter: SpeechUnitSplitter;

  constructor(
    private readonly synthesizer: KokoroSynthesizer,
    private readonly logger: VoiceLogger,
    options: KokoroTextToSpeechOptions = {},
  ) {
    this.voiceKey = options.voiceKey ?? null;
    this.speed = options.speed ?? 1;
    this.splitter = options.splitter ?? new SynthesisUnitSplitter();
  }

  async *synthesize(text: string, sequenceId: number, signal: AbortSignal): AsyncGenerator<AudioChunk> {
    for (const unit of this.splitter.split(text)) {
      if (signal.aborted) return;

      let synthesis: KokoroSynthesis;
      try {
        synthesis = await this.synthesizer.synthesize(unit, this.voiceKey, this.speed);
      } catch (error) {
        if (signal.aborted) return;
        this.logger.debug('Kokoro could not speak a sentence; skipping it', {
          sequenceId,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (signal.aborted) return;
      yield { sequenceId, data: synthesis.data, sampleRate: synthesis.sampleRate };
    }
  }
}
