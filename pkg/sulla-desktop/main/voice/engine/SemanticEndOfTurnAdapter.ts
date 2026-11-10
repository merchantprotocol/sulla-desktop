// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { EndOfTurnDetector } from '../../../composables/voice/ConversationTurnPolicy';
import type { SemanticEndOfTurn, SemanticTurnResult, VoiceLogger, VoiceTimer } from './VoiceEngines';

export interface SemanticEndOfTurnOptions {
  /** Deadline for the semantic classifier before the heuristic hold is used. */
  timeoutMs?: number;
  /** Lowest hold a confident 'complete' may shorten to. Prevents cutting the speaker off mid-thought. */
  minHoldMs?: number;
  /** Classifier probability required before a 'complete' result may shorten the hold. */
  shortenThreshold?: number;
  timer?: VoiceTimer;
}

/** Applies semantic decisions asynchronously while preserving the renderer heuristic on uncertainty. */
export class SemanticEndOfTurnAdapter {
  private readonly timeoutMs: number;
  private readonly minHoldMs: number;
  private readonly shortenThreshold: number;
  private readonly timer: VoiceTimer;

  constructor(
    private readonly detector: EndOfTurnDetector,
    private readonly engine: SemanticEndOfTurn | null,
    private readonly logger: VoiceLogger,
    options: SemanticEndOfTurnOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 500;
    this.minHoldMs = options.minHoldMs ?? 250;
    this.shortenThreshold = options.shortenThreshold ?? 0.7;
    this.timer = options.timer ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  delayMs(transcript: string, defaultHoldMs: number): number {
    return this.detector.delayMs(transcript, defaultHoldMs);
  }

  async delayMsWithContext(
    transcript: string,
    audio: Float32Array,
    defaultHoldMs: number,
    sequenceId: number,
    signal: AbortSignal,
  ): Promise<number> {
    const fallback = this.delayMs(transcript, defaultHoldMs);
    if (!this.engine) {
      return fallback;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.classifyWithDeadline(this.engine, audio, transcript, sequenceId, controller);
      return this.holdFor(result, defaultHoldMs, fallback);
    } catch (error) {
      this.logger.debug('Semantic end-of-turn unavailable; retaining heuristic hold', error);
      return fallback;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  /** Single timeout path: the deadline timer aborts the classifier, and the abort rejects the race. */
  private async classifyWithDeadline(
    engine: SemanticEndOfTurn,
    audio: Float32Array,
    transcript: string,
    sequenceId: number,
    controller: AbortController,
  ): Promise<SemanticTurnResult> {
    const deadline = this.timer.setTimeout(() => controller.abort(), this.timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('Semantic classifier timed out or was aborted')),
        { once: true },
      );
    });
    try {
      return await Promise.race([engine.classify(audio, transcript, sequenceId, controller.signal), aborted]);
    } finally {
      this.timer.clearTimeout(deadline);
    }
  }

  private holdFor(result: SemanticTurnResult, defaultHoldMs: number, fallback: number): number {
    if (result.complete === 'unknown') {
      return fallback;
    }
    if (result.complete === true) {
      if (result.probability < this.shortenThreshold) {
        return fallback;
      }
      const shortened = Math.max(this.minHoldMs, Math.round(defaultHoldMs * (1 - result.probability)));
      return Math.min(fallback, shortened);
    }
    return Math.max(fallback, Math.round(defaultHoldMs * (1 + result.probability)));
  }
}
