/**
 * ChatController — top-level orchestrator that sits above the Graph.
 *
 * Assembles the system prompt, registers extractors by mode, prepares the
 * tool list, and processes LLM responses through extractors. The Graph
 * (BaseNode) is a pure LLM executor that takes what the controller gives
 * it and returns raw output.
 *
 * Architecture:
 *   Controller.enrichPrompt()  → modifies prompt going IN to LLM
 *   Controller.processChunk()  → cleans streaming tokens coming OUT
 *   Controller.processComplete() → cleans final response coming OUT
 *
 * Mode → Extractor mapping:
 *   text      → [ThinkingExtractor]
 *   voice     → [ThinkingExtractor, SpeakExtractor]
 *   secretary → [ThinkingExtractor, SecretaryExtractor]
 *   intake    → [ThinkingExtractor, IntakeExtractor]
 */

import { IntakeExtractor } from './IntakeExtractor';
import { SecretaryExtractor, type SecretaryResultFn } from './SecretaryExtractor';
import { SpeakExtractor } from './SpeakExtractor';
import { ThinkingExtractor } from './ThinkingExtractor';

import type { Extractor, StreamContext, DispatchFn, ChatMessageFn, VoiceLogFn } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';
import type { BaseThreadState } from '../nodes/Graph';

// ─── Types ──────────────────────────────────────────────────────

export type ChatMode = 'text' | 'voice' | 'secretary' | 'intake';

export interface ChatControllerConfig {
  /** Dispatches WebSocket events (speak_dispatch, etc.) to the frontend. */
  dispatch: DispatchFn;

  /** Sends chat messages (streaming, thinking, progress) to the frontend. */
  sendChatMessage: ChatMessageFn;

  /** Logs voice events to ConversationLogger. */
  voiceLog: VoiceLogFn;

  /** Callback for secretary analysis results. */
  onSecretaryResult?: SecretaryResultFn;
}

// ─── Controller ─────────────────────────────────────────────────

export class ChatController {
  private extractors: Extractor[] = [];
  private mode:       ChatMode = 'text';

  private readonly dispatch:           DispatchFn;
  private readonly sendChatMessage:    ChatMessageFn;
  private readonly voiceLog:           VoiceLogFn;
  private readonly onSecretaryResult?: SecretaryResultFn;

  // Keep references to mode-specific extractors for reuse
  private thinkingExtractor:  ThinkingExtractor;
  private speakExtractor:     SpeakExtractor;
  private secretaryExtractor: SecretaryExtractor;
  private intakeExtractor:    IntakeExtractor;

  constructor(config: ChatControllerConfig) {
    this.dispatch = config.dispatch;
    this.sendChatMessage = config.sendChatMessage;
    this.voiceLog = config.voiceLog;
    this.onSecretaryResult = config.onSecretaryResult;

    // Create extractor instances
    this.thinkingExtractor = new ThinkingExtractor(config.sendChatMessage);
    this.speakExtractor = new SpeakExtractor(config.dispatch, config.voiceLog);
    this.secretaryExtractor = new SecretaryExtractor(config.onSecretaryResult ?? (() => {}));
    this.intakeExtractor = new IntakeExtractor();

    // Default mode: text (ThinkingExtractor only)
    this.extractors = [this.thinkingExtractor];
  }

  // ─── Mode Management ───────────────────────────────────────

  /**
   * Set the chat mode. Reconfigures which extractors are active.
   * Call this before each LLM invocation based on the request metadata.
   */
  setMode(mode: ChatMode): void {
    if (this.mode === mode) return;
    this.mode = mode;

    switch (mode) {
    case 'voice':
      this.extractors = [this.thinkingExtractor, this.speakExtractor];
      break;
    case 'secretary':
      this.extractors = [this.thinkingExtractor, this.secretaryExtractor];
      break;
    case 'intake':
      this.extractors = [this.thinkingExtractor, this.intakeExtractor];
      break;
    case 'text':
    default:
      this.extractors = [this.thinkingExtractor];
      break;
    }
  }

  getMode(): ChatMode {
    return this.mode;
  }

  getExtractors(): readonly Extractor[] {
    return this.extractors;
  }

  // ─── Prompt Enrichment ──────────────────────────────────────

  /**
   * Run all active extractors' enrichPrompt() on the system prompt.
   * Each extractor appends its mode-specific directives.
   */
  enrichPrompt(systemPrompt: string, ctx: StreamContext): string {
    for (const ext of this.extractors) {
      systemPrompt = ext.enrichPrompt(systemPrompt, ctx);
    }

    return systemPrompt;
  }

  // ─── Streaming ──────────────────────────────────────────────

  /**
   * Process a streaming chunk through all active extractors.
   * Returns the cleaned chunk (with extracted tags stripped).
   * This is the callback passed to the Graph's LLM streaming.
   */
  processChunk(chunk: string, ctx: StreamContext): string {
    for (const ext of this.extractors) {
      chunk = ext.processChunk(chunk, ctx);
    }

    return chunk;
  }

  // ─── Complete Processing ────────────────────────────────────

  /**
   * Process the complete LLM response through all active extractors.
   * Each extractor strips its tags, dispatches its data, and returns
   * the cleaned content. Returns the final cleaned text.
   */
  processComplete(reply: NormalizedResponse, ctx: StreamContext): string {
    for (const ext of this.extractors) {
      reply.content = ext.processComplete(reply, ctx);
    }

    return reply.content;
  }

  /**
   * Process a non-voice response that may contain <speak> tags.
   * Used in text mode when the LLM spontaneously includes speak tags.
   */
  processNonVoiceSpeak(reply: NormalizedResponse, ctx: StreamContext): void {
    this.speakExtractor.extractAndDispatchFromComplete(reply, ctx);
  }

  // ─── Reset ──────────────────────────────────────────────────

  /**
   * Reset all extractors' internal state. Call this before each new
   * LLM invocation to clear buffers from the previous call.
   */
  reset(): void {
    for (const ext of this.extractors) {
      ext.reset();
    }
  }

  // ─── Context Helper ─────────────────────────────────────────

  /**
   * Build a StreamContext from thread state. Convenience method so callers
   * don't have to construct it manually.
   */
  buildContext(state: BaseThreadState): StreamContext {
    return {
      state,
      threadId: state.metadata.threadId,
      channel:  state.metadata.wsChannel || 'workbench',
    };
  }
}
