/**
 * ThinkingExtractor — extracts <thinking> tags and Anthropic reasoning
 * metadata from LLM responses and dispatches them as thinking bubbles.
 *
 * Two-way extractor:
 *   IN:  enrichPrompt() is a no-op (thinking is natively supported)
 *   OUT: processChunk() is a no-op (thinking arrives as metadata, not in stream)
 *        processComplete() extracts <thinking> tags + Anthropic reasoning,
 *        dispatches as 'thinking' kind message, strips tags from content.
 *
 * Always enabled in all modes.
 */

import type { Extractor, StreamContext, ChatMessageFn } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Extractor ──────────────────────────────────────────────────

export class ThinkingExtractor implements Extractor {
  readonly name = 'thinking';

  private readonly sendChatMessage: ChatMessageFn;

  constructor(sendChatMessage: ChatMessageFn) {
    this.sendChatMessage = sendChatMessage;
  }

  // ─── Prompt Enrichment ──────────────────────────────────────

  enrichPrompt(systemPrompt: string, _ctx: StreamContext): string {
    return systemPrompt; // No-op — thinking is natively supported
  }

  // ─── Chunk Processing ──────────────────────────────────────

  processChunk(chunk: string, _ctx: StreamContext): string {
    return chunk; // No-op — thinking comes as metadata, not content stream
  }

  // ─── Complete Processing ────────────────────────────────────

  processComplete(reply: NormalizedResponse, ctx: StreamContext): string {
    let thinkingText = '';

    // Source 1: Anthropic reasoning metadata
    if (reply.metadata.reasoning) {
      thinkingText = reply.metadata.reasoning.trim();
    }

    // Source 2: <thinking> tags in content
    const thinkingTagRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
    const tagMatches = reply.content.match(thinkingTagRegex);

    if (tagMatches) {
      const extracted = tagMatches
        .map(m => m.replace(/<\/?thinking>/gi, '').trim())
        .filter(Boolean)
        .join('\n');

      if (extracted) {
        thinkingText = thinkingText ? `${ thinkingText }\n${ extracted }` : extracted;
      }

      // Strip thinking tags from the content
      reply.content = reply.content.replace(thinkingTagRegex, '').trim();
    }

    if (!thinkingText) {
      return reply.content;
    }

    // Dispatch as a 'thinking' kind message to the frontend
    this.sendChatMessage(ctx.state, thinkingText, 'assistant', 'thinking');

    return reply.content;
  }

  // ─── Reset ──────────────────────────────────────────────────

  reset(): void {
    // No state to reset
  }
}
