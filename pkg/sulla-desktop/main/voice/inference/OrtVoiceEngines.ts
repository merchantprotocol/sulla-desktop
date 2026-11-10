// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  SemanticEndOfTurn,
  SemanticTurnResult,
  Vad,
  VadEvent,
  VoiceLogger,
} from '../engine/VoiceEngines';
import { OrtInferenceClient } from './OrtInferenceClient';

export interface VoiceClock {
  now(): number;
}

export interface OrtSileroVadOptions {
  startThreshold?: number;
  endThreshold?: number;
  minSilenceMs?: number;
}

/**
 * Streaming Silero VAD for pinned onnx-community/silero-vad revision
 * e71cae966052b992a7eca6b17738916ce0eca4ec. Its 16 kHz streaming signature
 * follows the V5 OnnxWrapper: 512 new samples + 64 prior context, state [2,1,128].
 * Reference: snakers4/silero-vad/src/silero_vad/utils_vad.py at
 * 066409f3d9db45a30d21dfcbf9147826ffdd7052 (context_size=64, input+context).
 */
export class OrtSileroVad implements Vad {
  private readonly state = new Float32Array(256);
  private readonly context = new Float32Array(64);
  private activeSequenceId: number | null = null;
  private speaking = false;
  private silenceMs = 0;

  constructor(
    private readonly client: OrtInferenceClient,
    private readonly modelPath: string,
    private readonly clock: VoiceClock,
    private readonly options: OrtSileroVadOptions = {},
  ) {}

  async process(frame: Float32Array, sequenceId: number, _signal: AbortSignal): Promise<VadEvent[]> {
    if (frame.length !== 512) {
      throw new Error('VAD frames must be exactly 512 samples at 16 kHz');
    }

    if (this.activeSequenceId !== sequenceId) {
      this.reset();
      this.activeSequenceId = sequenceId;
    }

    const audio = new Float32Array(576);
    audio.set(this.context);
    audio.set(frame, this.context.length);
    const response = await this.client.infer({
      operation: 'vad',
      modelPath: this.modelPath,
      audio,
      state: this.state,
    });
    if (!response.ok || response.probability === undefined || !response.state) {
      throw new Error('VAD inference unavailable');
    }

    this.state.set(response.state);
    this.context.set(audio.subarray(audio.length - this.context.length));
    const events: VadEvent[] = [];
    const now = this.clock.now();
    const startThreshold = this.options.startThreshold ?? 0.5;
    const endThreshold = this.options.endThreshold ?? 0.35;
    const minSilenceMs = this.options.minSilenceMs ?? 300;

    if (!this.speaking && response.probability >= startThreshold) {
      this.speaking = true;
      this.silenceMs = 0;
      events.push({ kind: 'speech-start', sequenceId, timestampMs: now });
    } else if (this.speaking) {
      this.silenceMs = response.probability < endThreshold ? this.silenceMs + 32 : 0;
      if (this.silenceMs >= minSilenceMs) {
        this.speaking = false;
        this.silenceMs = 0;
        events.push({ kind: 'speech-end', sequenceId, timestampMs: now });
      }
    }

    return events;
  }

  /** Clears all audio context when a caller explicitly starts a new session. */
  reset(): void {
    this.state.fill(0);
    this.context.fill(0);
    this.activeSequenceId = null;
    this.speaking = false;
    this.silenceMs = 0;
  }
}

/** Smart Turn adapter; raw audio is featurized in the utility process, never on the main thread. */
export class OrtSmartTurn implements SemanticEndOfTurn {
  constructor(
    private readonly client: OrtInferenceClient,
    private readonly modelPath: string,
    private readonly logger: VoiceLogger,
  ) {}

  async classify(
    audio: Float32Array,
    _transcript: string,
    _sequenceId: number,
    _signal: AbortSignal,
  ): Promise<SemanticTurnResult> {
    try {
      const response = await this.client.infer({
        operation: 'smart-turn',
        modelPath: this.modelPath,
        audio,
      });
      const probability = response.probability;
      if (!response.ok || probability === undefined) {
        return { complete: 'unknown', probability: 0 };
      }

      return { complete: probability >= 0.5, probability };
    } catch (error) {
      this.logger.debug('Smart Turn unavailable', error);
      return { complete: 'unknown', probability: 0 };
    }
  }
}
