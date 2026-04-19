/**
 * IntakeExtractor — injects INTAKE_MODE_PROMPT for continuous streaming
 * voice input (fast dispatcher mode).
 *
 * Two-way extractor:
 *   IN:  enrichPrompt() appends INTAKE_MODE_PROMPT to the system prompt
 *   OUT: processChunk() is a no-op
 *        processComplete() strips accidental <speak> tags (safety)
 *
 * Active only in intake mode.
 */

import { INTAKE_MODE_PROMPT } from '../prompts/voiceModes';

import type { Extractor, StreamContext } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Extractor ──────────────────────────────────────────────────

export class IntakeExtractor implements Extractor {
  readonly name = 'intake';

  // ─── Prompt Enrichment ──────────────────────────────────────

  enrichPrompt(systemPrompt: string, _ctx: StreamContext): string {
    return systemPrompt + INTAKE_MODE_PROMPT;
  }

  // ─── Chunk Processing ──────────────────────────────────────

  processChunk(chunk: string, _ctx: StreamContext): string {
    return chunk; // No-op
  }

  // ─── Complete Processing ────────────────────────────────────

  processComplete(reply: NormalizedResponse, _ctx: StreamContext): string {
    // Safety: strip any accidental <speak> tags (intake mode should not produce them)
    reply.content = reply.content.replace(/<speak>[\s\S]*?<\/speak>/gi, '').trim();

    return reply.content;
  }

  // ─── Reset ──────────────────────────────────────────────────

  reset(): void {
    // No state to reset
  }
}
