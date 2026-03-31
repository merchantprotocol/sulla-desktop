// InputHandlerNode.ts
// First node in any graph pipeline — prepares, validates, and shapes the
// context window before downstream nodes ever see it.
//
// Responsibilities (executed in order):
//   1. Input sanitization           – normalize & strip dangerous patterns
//   2. Rate-limit / abuse / spam    – heuristic gate on message velocity & quality
//   3. Batch summarization          – when hitting MAX_WINDOW_SIZE, batch oldest 25% for LLM compression
//   4. Summary storage & retrieval  – store summaries on state, remove old summary to avoid re-summarizing
//   5. Conversation summary append  – create comprehensive summary message from all observations
//   6. Token budget enforcement     – hard ceiling fallback if needed
//
// Design principles:
//   - Batch-first approach: summarize in chunks rather than individual message relevance
//   - LLM summarization in observational memory format (🔴/🟡/⚪ priority system)
//   - All summaries tracked on state.metadata.conversationSummaries
//   - Summary message appended to conversation with _conversationSummary flag
//   - Never mutates the latest user message or system messages
//   - Always returns { type: 'next' } — routing lives in graph edges

import type { BaseThreadState, NodeResult } from './Graph';
import { type ChatMessage, getTextContent } from '../languagemodels/BaseLanguageModel';
import { BaseNode, JSON_ONLY_RESPONSE_INSTRUCTIONS } from './BaseNode';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Max messages to retain after trimming (rolling window size) */
const MAX_WINDOW_SIZE = 80;

/** Percentage of window to batch-summarize when hitting max size */
const BATCH_SUMMARY_PERCENT = 0.25;

/** Absolute token ceiling for the full message array (≈ chars / 4) */
const MAX_TOKEN_BUDGET = 96_000;

/** Chars-per-token estimate (conservative for English + code) */
const CHARS_PER_TOKEN = 4;

/** Minimum interval (ms) between user messages before rate-limit triggers */
const RATE_LIMIT_INTERVAL_MS = 400;

/** Max user messages allowed within the burst window */
const RATE_LIMIT_BURST_MAX = 12;

/** Burst window duration (ms) — 12 messages in 10 s = likely abuse */
const RATE_LIMIT_BURST_WINDOW_MS = 10_000;

/** Minimum content length for a user message to be considered non-spam */
const MIN_MESSAGE_LENGTH = 1;

/** Maximum single-message length before truncation (chars) */
const MAX_MESSAGE_LENGTH = 100_000;

// ============================================================================
// PROMPT — used only when evicted messages need summarization
// ============================================================================

const BATCH_SUMMARY_PROMPT = `
You are a precision fact-extractor processing a batch of conversation messages for compression.

Your job: Extract key facts, decisions, commitments, entities, preferences, and actionable 
outcomes in the exact format used by the observational memory system.

Rules:
- Extract 3–8 observational memory entries
- Each entry: priority (🔴/🟡/⚪), one-sentence content
- Third-person neutral voice ("User requested…", "System completed…")
- Include specifics: names, dates, numbers, slugs, URLs, versions
- 🔴 Critical = identity, strong prefs/goals, promises, deal-breakers
- 🟡 Valuable = decisions, patterns, progress markers
- ⚪ Low = minor items (use sparingly)

${ JSON_ONLY_RESPONSE_INSTRUCTIONS }
{
  "observations": [
    {
      "priority": "🟡",
      "content": "One concise fact sentence with specific details."
    },
    {
      "priority": "🔴", 
      "content": "Another critical fact sentence."
    }
  ]
}`.trim();

// ============================================================================
// HELPERS
// ============================================================================

/** Rough token count from character length */
function estimateTokens(text: string): number {
  return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);
}

/** Estimate total tokens across all messages */
function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  ), 0);
}

// ============================================================================
// SANITIZATION PATTERNS
// ============================================================================

/** Patterns that indicate prompt injection or adversarial input */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(your\s+)?instructions/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:new|different)\s+(?:ai|assistant|bot)/i,
  /\bsystem\s*:\s*/i,      // raw system role injection
  /\[INST\]/i,              // Llama-style injection
  /<\|im_start\|>/i,        // ChatML injection
  /\bDAN\b.*\bjailbreak/i,
];

/** Unicode control chars & zero-width chars that serve no legitimate purpose */
const CONTROL_CHAR_REGEX = /[\u200B-\u200F\u2028-\u202F\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

// ============================================================================
// NODE
// ============================================================================

/**
 * Input Handler Node
 *
 * Purpose:
 *   - First node in every graph pipeline
 *   - Validates, sanitizes, scores, trims, and budget-enforces the message
 *     context window so downstream nodes operate on clean, bounded state
 *
 * Key Design Decisions (2026 refactor):
 *   - Heuristic-first: no LLM calls except eviction summarization
 *   - Relevance scoring uses keyword overlap + recency decay (no embedding call)
 *   - Rate-limiting is per-thread via state.metadata timestamps
 *   - Evicted facts are persisted to observational memory (SullaSettingsModel)
 *   - Token budget is a hard ceiling; relevance-aware eviction before naive slice
 *   - Latest user message is never mutated or evicted
 *
 * Input expectations:
 *   - state.messages contains at least one user message
 *   - state.metadata.threadId is set
 *
 * Output mutations:
 *   - state.messages may be trimmed / reordered
 *   - state.metadata.inputHandler.* populated with diagnostics
 *   - Observational memory may gain eviction summaries
 *
 * Failure modes:
 *   - Rate-limited → sets metadata flag, still returns 'next'
 *   - Empty / spam message → sets metadata flag, returns 'next'
 *   - Eviction summary LLM fails → silently continues (messages still trimmed)
 *
 * @extends BaseNode
 */
export class InputHandlerNode<TState extends BaseThreadState = BaseThreadState> extends BaseNode {
  constructor() {
    super('input_handler', 'Input Handler');
  }

  async execute(state: TState): Promise<NodeResult<TState>> {
    // Initialize diagnostics metadata
    const diagnostics: Record<string, any> = {
      sanitized:          false,
      rateLimited:        false,
      spamDetected:       false,
      injectionDetected:  false,
      messagesEvicted:    0,
      tokensBefore:       0,
      tokensAfter:        0,
      relevanceScored:    false,
      evictionSummarized: false,
    };

    // ----------------------------------------------------------------
    // 0. CONVERSATION TRIMMING MAINTENANCE
    // ----------------------------------------------------------------
    // Trigger maintenance asynchronously so downstream execution is non-blocking.
    this.triggerBackgroundStateMaintenance(state);

    // ----------------------------------------------------------------
    // 1. INPUT SANITIZATION
    // ----------------------------------------------------------------
    const latestUserMsg = this.findLatestUserMessage(state.messages);

    if (latestUserMsg) {
      const original = getTextContent(latestUserMsg.content);
      const sanitized = this.sanitizeMessage(original);

      // Check for injection patterns (flag but don't block — downstream decides)
      if (this.detectInjection(original)) {
        diagnostics.injectionDetected = true;
        console.warn(`[InputHandler] Injection pattern detected in thread ${ state.metadata.threadId }`);
      }

      if (sanitized !== original) {
        latestUserMsg.content = sanitized;
        diagnostics.sanitized = true;
      }
    }

    // ----------------------------------------------------------------
    // 2. RATE LIMITING / ABUSE / SPAM DETECTION
    // ----------------------------------------------------------------
    const rateCheck = this.checkRateLimit(state);
    if (rateCheck.limited) {
      diagnostics.rateLimited = true;
      diagnostics.rateLimitReason = rateCheck.reason;
      console.warn(`[InputHandler] Rate limited: ${ rateCheck.reason }`);
    }

    if (latestUserMsg && this.isSpam(getTextContent(latestUserMsg.content))) {
      diagnostics.spamDetected = true;
      console.warn(`[InputHandler] Spam detected in thread ${ state.metadata.threadId }`);
    }

    // ----------------------------------------------------------------
    // 3. BATCH SUMMARIZATION WHEN HITTING MAX WINDOW
    // ----------------------------------------------------------------
    diagnostics.tokensBefore = estimateTotalTokens(state.messages);

    const needsBatchSummarization = state.messages.length > MAX_WINDOW_SIZE;

    if (needsBatchSummarization) {
      diagnostics.summaryServiceTriggered = true;
      console.log(`[InputHandler] Triggered background summarization for ${ state.messages.length } messages`);
    }

    // ----------------------------------------------------------------
    // 4. TOKEN BUDGET ENFORCEMENT (hard ceiling)
    // ----------------------------------------------------------------
    this.enforceTokenBudget(state);

    diagnostics.tokensAfter = estimateTotalTokens(state.messages);

    // Persist diagnostics on state for downstream inspection
    (state.metadata as any).inputHandler = diagnostics;

    // Record rate-limit timestamp
    this.recordMessageTimestamp(state);

    return { state, decision: { type: 'next' } };
  }

  // ======================================================================
  // SANITIZATION
  // ======================================================================

  /**
   * Normalize and clean a user message:
   * - Strip zero-width / control characters
   * - Collapse excessive whitespace
   * - Truncate if over max length
   */
  private sanitizeMessage(text: string): string {
    let cleaned = text;

    // Remove zero-width and control characters
    cleaned = cleaned.replace(CONTROL_CHAR_REGEX, '');

    // Collapse runs of whitespace (preserve single newlines for formatting)
    cleaned = cleaned.replace(/[ \t]+/g, ' ');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Trim leading/trailing
    cleaned = cleaned.trim();

    // Hard truncation for absurdly long messages
    if (cleaned.length > MAX_MESSAGE_LENGTH) {
      cleaned = cleaned.slice(0, MAX_MESSAGE_LENGTH) + '\n[truncated]';
    }

    return cleaned;
  }

  /** Check input for known prompt-injection patterns */
  private detectInjection(text: string): boolean {
    return INJECTION_PATTERNS.some(p => p.test(text));
  }

  /** Basic spam heuristic: too short, all caps, excessive repetition */
  private isSpam(text: string): boolean {
    if (!text || text.trim().length < MIN_MESSAGE_LENGTH) return true;

    // All-caps message longer than 20 chars
    if (text.length > 20 && text === text.toUpperCase() && /[A-Z]/.test(text)) return true;

    // Repetitive character spam (e.g. "aaaaaaaaaa" or "!!!!!!!!!!!")
    if (/(.)\1{15,}/.test(text)) return true;

    // Repetitive word spam (same word 8+ times)
    const words = text.toLowerCase().split(/\s+/);
    if (words.length >= 8) {
      const freq = new Map<string, number>();
      for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
      const maxFreq = Math.max(...freq.values());
      if (maxFreq / words.length > 0.7) return true;
    }

    return false;
  }

  // ======================================================================
  // RATE LIMITING
  // ======================================================================

  /**
   * Heuristic rate limiter using timestamps stored on state metadata.
   * Tracks message arrival times and enforces:
   *   - Minimum interval between consecutive messages
   *   - Burst ceiling within a sliding window
   */
  private checkRateLimit(state: BaseThreadState): { limited: boolean; reason?: string } {
    const meta = state.metadata as any;
    const now = Date.now();
    const timestamps: number[] = meta._inputTimestamps || [];

    // Check minimum interval
    if (timestamps.length > 0) {
      const lastTs = timestamps[timestamps.length - 1];
      if (now - lastTs < RATE_LIMIT_INTERVAL_MS) {
        return { limited: true, reason: 'Too fast — minimum interval not met' };
      }
    }

    // Check burst window
    const windowStart = now - RATE_LIMIT_BURST_WINDOW_MS;
    const recentCount = timestamps.filter(t => t >= windowStart).length;
    if (recentCount >= RATE_LIMIT_BURST_MAX) {
      return { limited: true, reason: `Burst limit exceeded (${ recentCount } in ${ RATE_LIMIT_BURST_WINDOW_MS / 1000 }s)` };
    }

    return { limited: false };
  }

  /** Append current timestamp for future rate-limit checks */
  private recordMessageTimestamp(state: BaseThreadState): void {
    const meta = state.metadata as any;
    if (!meta._inputTimestamps) meta._inputTimestamps = [];
    meta._inputTimestamps.push(Date.now());

    // Keep only last 30 timestamps
    if (meta._inputTimestamps.length > 30) {
      meta._inputTimestamps = meta._inputTimestamps.slice(-30);
    }
  }

  // ======================================================================
  // TOKEN BUDGET ENFORCEMENT
  // ======================================================================

  /**
   * Hard-ceiling enforcement. After smart trim, if we're still over budget
   * (edge case with very large individual messages), do a naive oldest-first
   * eviction until we're under the limit. System messages and latest user
   * message are still protected.
   */
  private enforceTokenBudget(state: BaseThreadState): void {
    const latest = this.findLatestUserMessage(state.messages);
    const totalTokens = estimateTotalTokens(state.messages);

    if (totalTokens <= MAX_TOKEN_BUDGET) return;

    // Walk from oldest, evict non-protected until under budget
    const surviving: ChatMessage[] = [];
    const runningTokens = 0;

    // First pass: calculate tokens for protected messages
    const protectedTokens = state.messages
      .filter(m => m.role === 'system' || m === latest)
      .reduce((sum, m) => sum + estimateTokens(
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ), 0);

    const budgetForNonProtected = MAX_TOKEN_BUDGET - protectedTokens;

    // Second pass: walk from newest to oldest, keep until budget exhausted
    const reversed = [...state.messages].reverse();
    const kept = new Set<ChatMessage>();

    // Always keep protected
    for (const m of state.messages) {
      if (m.role === 'system' || m === latest) kept.add(m);
    }

    let usedBudget = 0;
    for (const m of reversed) {
      if (kept.has(m)) continue;
      const tokens = estimateTokens(
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      );
      if (usedBudget + tokens <= budgetForNonProtected) {
        kept.add(m);
        usedBudget += tokens;
      }
    }

    state.messages = state.messages.filter(m => kept.has(m));
    console.log(`[InputHandler] Token budget enforcement: ${ totalTokens } → ${ estimateTotalTokens(state.messages) } tokens`);
  }

  // ======================================================================
  // UTILITIES
  // ======================================================================

  /** Find the most recent user message in the array */
  private findLatestUserMessage(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return null;
  }
}
