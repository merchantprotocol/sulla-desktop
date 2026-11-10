// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ModelRepository } from '../engine/ModelRepository';
import type { VoiceLogger } from '../engine/VoiceEngines';
import { OrtInferenceClient } from './OrtInferenceClient';
import { OrtSileroVad, OrtSmartTurn, type VoiceClock } from './OrtVoiceEngines';

/** Constructs local engines only when explicitly enabled; never participates in the live renderer path by default. */
export class LocalTurnEngineFactory {
  constructor(
    private readonly models: ModelRepository,
    private readonly client: OrtInferenceClient,
    private readonly logger: VoiceLogger,
    private readonly clock: VoiceClock,
    private readonly enabled = false,
  ) {}

  async create(): Promise<{ vad: OrtSileroVad; semantic: OrtSmartTurn } | null> {
    if (!this.enabled) return null;
    try {
      const [vad, smart] = await Promise.all([
        this.models.resolve('vad-silero-onnx'),
        this.models.resolve('eot-smart-turn-v3.2-cpu'),
      ]);
      return {
        vad: new OrtSileroVad(this.client, vad, this.clock),
        semantic: new OrtSmartTurn(this.client, smart, this.logger),
      };
    } catch (error) {
      this.logger.debug('Local turn models unavailable; heuristic remains active', error);
      return null;
    }
  }
}
