// SPDX-License-Identifier: GPL-2.0-or-later
import type { EndOfTurnDetector } from '../../../composables/voice/ConversationTurnPolicy';
import type { SemanticEndOfTurn, VoiceClock, VoiceLogger } from './VoiceEngines';
/** Applies semantic decisions asynchronously while preserving the renderer heuristic on uncertainty. */
export class SemanticEndOfTurnAdapter {
  constructor(private readonly detector: EndOfTurnDetector, private readonly engine: SemanticEndOfTurn | null, private readonly clock: VoiceClock, private readonly logger: VoiceLogger, private readonly timeoutMs = 500) {}
  delayMs(transcript: string, defaultHoldMs: number): number { return this.detector.delayMs(transcript, defaultHoldMs); }
  async delayMsWithContext(transcript: string, audio: Float32Array, defaultHoldMs: number, sequenceId: number, signal: AbortSignal): Promise<number> {
    const fallback = this.delayMs(transcript, defaultHoldMs); if (!this.engine) return fallback;
    const controller = new AbortController(); const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const started = this.clock.now(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await Promise.race([this.engine.classify(audio, transcript, sequenceId, controller.signal), new Promise<never>((_resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Semantic classifier timed out')), this.timeoutMs); controller.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new Error('Semantic classifier aborted')); }, { once: true }); })]);
      if (controller.signal.aborted || this.clock.now() - started >= this.timeoutMs || result.complete === 'unknown') return fallback;
      return result.complete ? Math.min(fallback, Math.round(defaultHoldMs * (1 - result.probability))) : Math.max(fallback, Math.round(defaultHoldMs * (1 + result.probability)));
    } catch (error) { this.logger.debug('Semantic end-of-turn unavailable; retaining heuristic hold', error); return fallback; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
