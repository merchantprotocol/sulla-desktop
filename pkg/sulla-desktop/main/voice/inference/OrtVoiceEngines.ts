// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { SemanticEndOfTurn, SemanticTurnResult, Vad, VadEvent, VoiceLogger } from '../engine/VoiceEngines';
import { OrtInferenceClient } from './OrtInferenceClient';
import { WhisperLogMelExtractor } from './WhisperLogMelExtractor';

/** Silero streaming VAD adapter; recurrent state belongs to this instance and persists across frames. */
export class OrtSileroVad implements Vad {
  private state = new Float32Array(256);
  private speaking = false;
  private silenceMs = 0;
  constructor(private readonly client: OrtInferenceClient, private readonly modelPath: string, private readonly startThreshold = 0.5, private readonly endThreshold = 0.35, private readonly minSilenceMs = 300) {}
  async process(frame: Float32Array, sequenceId: number, _signal: AbortSignal): Promise<VadEvent[]> {
    if (frame.length !== 512) throw new Error('VAD frames must be 512 samples at 16 kHz');
    const response = await this.client.infer({ operation: 'vad', modelPath: this.modelPath, audio: frame, state: this.state });
    if (!response.ok || response.probability === undefined || !response.state) throw new Error('VAD inference unavailable');
    this.state = new Float32Array(response.state); const events: VadEvent[] = []; const now = Date.now();
    if (!this.speaking && response.probability >= this.startThreshold) { this.speaking = true; this.silenceMs = 0; events.push({ kind: 'speech-start', sequenceId, timestampMs: now }); }
    else if (this.speaking) { this.silenceMs = response.probability < this.endThreshold ? this.silenceMs + 32 : 0; if (this.silenceMs >= this.minSilenceMs) { this.speaking = false; this.silenceMs = 0; events.push({ kind: 'speech-end', sequenceId, timestampMs: now }); } }
    return events;
  }
}

/** Semantic Smart Turn adapter. Unavailable inference always returns unknown to retain heuristic hold. */
export class OrtSmartTurn implements SemanticEndOfTurn {
  constructor(private readonly client: OrtInferenceClient, private readonly modelPath: string, private readonly extractor: WhisperLogMelExtractor, private readonly logger: VoiceLogger) {}
  async classify(audio: Float32Array, _transcript: string, _sequenceId: number, _signal: AbortSignal): Promise<SemanticTurnResult> {
    try { const response = await this.client.infer({ operation: 'smart-turn', modelPath: this.modelPath, audio: this.extractor.extract(audio) }); const probability = response.probability; if (!response.ok || probability === undefined) return { complete: 'unknown', probability: 0 }; return { complete: probability >= 0.5, probability }; }
    catch (error) { this.logger.debug('Smart Turn unavailable', error); return { complete: 'unknown', probability: 0 }; }
  }
}
