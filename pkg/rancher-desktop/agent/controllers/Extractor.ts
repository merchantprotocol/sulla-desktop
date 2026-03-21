/**
 * Extractor — two-way module interface for the ChatController.
 *
 * Each extractor modifies the prompt going IN to the LLM and cleans
 * the response coming OUT. Extractors dispatch their own extracted
 * data to the frontend independently and are unit-testable in isolation.
 *
 * Lifecycle per LLM call:
 *   1. controller calls reset()
 *   2. controller calls enrichPrompt() → extractor appends its directives
 *   3. LLM streams → controller calls processChunk() for each token
 *   4. LLM completes → controller calls processComplete() on full text
 */

import type { BaseThreadState } from '../nodes/Graph';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Types ──────────────────────────────────────────────────────

export interface StreamContext {
  state: BaseThreadState;
  threadId: string;
  channel: string;
}

/**
 * Function that dispatches data to the frontend via WebSocket.
 * Provided by the ChatController so extractors don't need WebSocket access.
 */
export type DispatchFn = (
  state: BaseThreadState,
  type: string,
  data: Record<string, unknown>,
) => Promise<boolean>;

/**
 * Function that sends a chat message to the frontend UI.
 * Used by ThinkingExtractor to dispatch thinking bubbles.
 */
export type ChatMessageFn = (
  state: BaseThreadState,
  content: string,
  role: 'assistant' | 'system',
  kind: string,
) => Promise<boolean>;

/**
 * Function that logs voice events to ConversationLogger.
 * Uses the VOICE:<COMPONENT>:<EVENT> tag format.
 */
export type VoiceLogFn = (
  state: BaseThreadState,
  component: string,
  event: string,
  data?: Record<string, unknown>,
) => void;

// ─── Interface ──────────────────────────────────────────────────

export interface Extractor {
  readonly name: string;

  /** Modify the system prompt before it goes to the LLM. */
  enrichPrompt(systemPrompt: string, ctx: StreamContext): string;

  /** Process a streaming chunk in real-time. Returns the cleaned chunk. */
  processChunk(chunk: string, ctx: StreamContext): string;

  /**
   * Process the complete LLM response after streaming ends.
   * May mutate reply.content (strip tags). Returns cleaned text.
   */
  processComplete(reply: NormalizedResponse, ctx: StreamContext): string;

  /** Reset internal state between LLM calls (buffers, flags). */
  reset(): void;
}
