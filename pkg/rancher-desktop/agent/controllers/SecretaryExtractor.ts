/**
 * SecretaryExtractor — extracts <secretary_analysis> blocks from LLM responses
 * and parses actions, facts, and conclusions.
 *
 * Two-way extractor:
 *   IN:  enrichPrompt() appends SECRETARY_MODE_PROMPT to the system prompt
 *   OUT: processChunk() is a no-op (analysis is post-completion)
 *        processComplete() extracts <secretary_analysis> blocks, parses
 *        structured data, dispatches via callback, strips accidental <speak> tags.
 *
 * Active only in secretary mode.
 */

import { SECRETARY_MODE_PROMPT } from '../prompts/voiceModes';

import type { Extractor, StreamContext } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Types ──────────────────────────────────────────────────────

export interface SecretaryAnalysis {
  actions:     string[];
  facts:       string[];
  conclusions: string[];
}

export type SecretaryResultFn = (result: SecretaryAnalysis) => void;

// ─── Extractor ──────────────────────────────────────────────────

export class SecretaryExtractor implements Extractor {
  readonly name = 'secretary';

  private readonly onResult: SecretaryResultFn;

  constructor(onResult: SecretaryResultFn) {
    this.onResult = onResult;
  }

  // ─── Prompt Enrichment ──────────────────────────────────────

  enrichPrompt(systemPrompt: string, _ctx: StreamContext): string {
    return systemPrompt + SECRETARY_MODE_PROMPT;
  }

  // ─── Chunk Processing ──────────────────────────────────────

  processChunk(chunk: string, _ctx: StreamContext): string {
    return chunk; // No-op — analysis is post-completion
  }

  // ─── Complete Processing ────────────────────────────────────

  processComplete(reply: NormalizedResponse, _ctx: StreamContext): string {
    // Extract secretary analysis blocks
    const analysisRegex = /<secretary_analysis>([\s\S]*?)<\/secretary_analysis>/i;
    const match = analysisRegex.exec(reply.content);

    if (match) {
      const block = match[1];

      this.onResult({
        actions:     extractListItems(block, 'actions'),
        facts:       extractListItems(block, 'facts'),
        conclusions: extractListItems(block, 'conclusions'),
      });
    }

    // Safety: strip any accidental <speak> tags (secretary mode should not produce them)
    reply.content = reply.content.replace(/<speak>[\s\S]*?<\/speak>/gi, '').trim();

    return reply.content;
  }

  // ─── Reset ──────────────────────────────────────────────────

  reset(): void {
    // No state to reset
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function extractListItems(block: string, tag: string): string[] {
  const match = new RegExp(`<${ tag }>([\\s\\S]*?)<\\/${ tag }>`, 'i').exec(block);

  if (!match) return [];

  return match[1]
    .split('\n')
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}
