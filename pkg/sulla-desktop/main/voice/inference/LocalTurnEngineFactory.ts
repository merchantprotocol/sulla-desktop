// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ModelRepository } from '../engine/ModelRepository';
import type { VoiceLogger } from '../engine/VoiceEngines';
import { OrtInferenceClient } from './OrtInferenceClient';
import { OrtSileroVad, OrtSmartTurn, type VoiceClock } from './OrtVoiceEngines';
import type { KokoroSynthesizer } from '../tts/KokoroSynthesizer';
import { KokoroTextToSpeech } from '../tts/KokoroTextToSpeech';
import { WhisperOrtSpeechToText } from './WhisperOrtSpeechToText';
import { WhisperOrtSpeechToText } from './WhisperOrtSpeechToText';

/** Constructs local engines only when explicitly enabled; never participates in the live renderer path by default. */
export class LocalTurnEngineFactory {
  constructor(
    private readonly models: ModelRepository,
    private readonly client: OrtInferenceClient,
    private readonly logger: VoiceLogger,
    private readonly clock: VoiceClock,
    private readonly enabled = false,
    private readonly kokoro: KokoroSynthesizer | null = null,
  ) {}

  async create(): Promise<{ vad: OrtSileroVad; semantic: OrtSmartTurn; stt: WhisperOrtSpeechToText; tts: KokoroTextToSpeech | null } | null> {
    if (!this.enabled) return null;
    try {
      const [vad, smart] = await Promise.all([
        this.models.resolve('vad-silero-onnx'),
        this.models.resolve('eot-smart-turn-v3.2-cpu'),
      ]);
      return {
        vad: new OrtSileroVad(this.client, vad, this.clock),
        semantic: new OrtSmartTurn(this.client, smart, this.logger),
        stt: new WhisperOrtSpeechToText(this.models, this.client, this.logger),
        tts: this.kokoro ? new KokoroTextToSpeech(this.kokoro, this.logger) : null,
      };
    } catch (error) {
      this.logger.debug('Local turn models unavailable; heuristic remains active', error);
      return null;
    }
  }
}
