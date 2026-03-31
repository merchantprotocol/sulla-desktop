// ConversationSummaryService.ts
// Background service that asynchronously compresses conversation history
// by summarizing the oldest 25% of messages into observational memory format.
//
// Key Features:
// - Supports immediate (awaited) and background (fire-and-forget) execution
// - Single tenant: operates directly on live state object references
// - Retry logic: failed summarizations are retried without breaking conversation
// - Concurrency safe: only one summarization process at a time
// - State coherent: updates immediately reflect across entire agent

import type { BaseThreadState } from '../nodes/Graph';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { getPrimaryService } from '../languagemodels';
import { parseJson } from './JsonParseService';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Max messages before triggering background summarization */
const TRIGGER_WINDOW_SIZE = 45;

/** Percentage of oldest messages to batch-summarize */
const BATCH_SUMMARY_PERCENT = 0.25;

/** Max retries for failed summarization attempts */
const MAX_RETRY_ATTEMPTS = 3;

/** Delay between retry attempts (ms) */
const RETRY_DELAY_MS = 2000;

/** Message scoring configuration */
const SCORING_CONFIG = {
  /** Threshold score above which messages become candidates for summarization */
  SUMMARIZATION_THRESHOLD: 0.7,
  /** Weight for age factor (0-1) */
  AGE_WEIGHT:              0.6,
  /** Weight for relevancy factor (0-1) */
  RELEVANCY_WEIGHT:        0.4,
  /** Maximum number of recent messages to use for relevancy context */
  RELEVANCY_CONTEXT_SIZE:  10,
  /** Minimum batch size for summarization */
  MIN_BATCH_SIZE:          3,
  /** Maximum batch size for summarization */
  MAX_BATCH_SIZE:          40,
};

// ============================================================================
// BATCH SUMMARY PROMPT
// ============================================================================

const JSON_ONLY_RESPONSE_INSTRUCTIONS = `
IMPORTANT: Your response must be valid JSON only. No explanations, no markdown, no additional text.
Return only the JSON object specified in the format above.`;

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

NEVER extract observations about:
- Browser anti-bot blocking, CAPTCHAs, rate-limiting, or access denied errors. These are transient, site-specific events that must NOT be remembered. Recording them causes the agent to permanently avoid browser tools, which is harmful.
- Any tool failure that is temporary or site-specific in nature.

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
// CONVERSATION SUMMARY SERVICE
// ============================================================================

interface ObservationEntry {
  priority: string;
  content:  string;
}

interface MessageScore {
  message:        ChatMessage;
  index:          number;
  ageScore:       number;
  relevancyScore: number;
  combinedScore:  number;
}

export class ConversationSummaryService {
  private static instance: ConversationSummaryService | null = null;
  private static isProcessing = false;
  private static processingQueue = new Set<string>();

  public readonly id = 'conversation_summary_service';
  public readonly name = 'Conversation Summary Service';

  /**
   * Check if a specific thread is currently being processed
   */
  static isProcessingThread(threadId: string): boolean {
    return ConversationSummaryService.processingQueue.has(threadId);
  }

  /**
   * Check if service is currently processing any thread
   */
  static isCurrentlyProcessing(): boolean {
    return ConversationSummaryService.isProcessing;
  }

  constructor() {
    // Standalone service - no BaseNode dependency
  }

  /**
   * Calculate age score for a message based on position and timestamp
   * Returns 0-1 where 1 means very old (high candidate for summarization)
   */
  private calculateAgeScore(messageIndex: number, totalMessages: number, message: ChatMessage): number {
    // Position-based age (older position = higher score)
    const positionScore = (totalMessages - 1 - messageIndex) / Math.max(totalMessages - 1, 1);

    // Time-based age (if timestamp available)
    let timeScore = 0;
    const messageTimestamp = (message.metadata as any)?.timestamp;
    if (messageTimestamp) {
      const now = Date.now();
      const age = now - messageTimestamp;
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours in ms
      timeScore = Math.min(age / maxAge, 1);
    }

    // Combine position and time scores (favor position if no timestamp)
    return messageTimestamp ? (positionScore * 0.7 + timeScore * 0.3) : positionScore;
  }

  /**
   * Calculate relevancy score by comparing message content to recent context
   * Returns 0-1 where 1 means very irrelevant (high candidate for summarization)
   */
  private calculateRelevancyScore(message: ChatMessage, recentContext: string[]): number {
    const messageContent = typeof message.content === 'string'
      ? message.content.toLowerCase()
      : JSON.stringify(message.content).toLowerCase();

    if (messageContent.length < 10) return 0.8; // Very short messages are likely less relevant

    // Extract key terms from recent context
    const contextTerms = recentContext.join(' ').toLowerCase()
      .split(/\s+/)
      .filter(term => term.length > 3)
      .slice(0, 50); // Limit terms to avoid noise

    // Count overlapping terms
    const messageTerms = messageContent.split(/\s+/).filter(term => term.length > 3);
    const overlap = messageTerms.filter(term => contextTerms.includes(term)).length;
    const relevancyRatio = overlap / Math.max(messageTerms.length, 1);

    // Invert score (high overlap = low summarization score)
    return Math.max(0, 1 - relevancyRatio * 2);
  }

  /**
   * Score all messages and return candidates for summarization
   */
  private scoreMessages(workingMessages: ChatMessage[]): MessageScore[] {
    if (workingMessages.length === 0) return [];

    // Get recent context for relevancy scoring
    const recentMessages = workingMessages.slice(-SCORING_CONFIG.RELEVANCY_CONTEXT_SIZE);
    const recentContext = recentMessages
      .filter(m => typeof m.content === 'string')
      .map(m => m.content as string);

    return workingMessages.map((message, index) => {
      // Skip system messages and latest user message
      if (message.role === 'system' ||
          (message.role === 'user' && index === workingMessages.length - 1)) {
        return {
          message,
          index,
          ageScore:       0,
          relevancyScore: 0,
          combinedScore:  0,
        };
      }

      const ageScore = this.calculateAgeScore(index, workingMessages.length, message);
      const relevancyScore = this.calculateRelevancyScore(message, recentContext);
      const combinedScore = (ageScore * SCORING_CONFIG.AGE_WEIGHT) +
                           (relevancyScore * SCORING_CONFIG.RELEVANCY_WEIGHT);

      return {
        message,
        index,
        ageScore,
        relevancyScore,
        combinedScore,
      };
    });
  }

  /**
   * Get singleton instance of the service
   */
  private static getInstance(): ConversationSummaryService {
    if (!ConversationSummaryService.instance) {
      ConversationSummaryService.instance = new ConversationSummaryService();
    }
    return ConversationSummaryService.instance;
  }

  /**
   * Build deterministic fallback observations when LLM summarization returns no observations.
   */
  private buildFallbackObservations(messages: ChatMessage[]): ObservationEntry[] {
    const observations: ObservationEntry[] = [];

    for (const message of messages) {
      const content = typeof message.content === 'string'
        ? message.content.trim()
        : JSON.stringify(message.content || '').trim();

      if (!content) {
        continue;
      }

      observations.push({
        priority: '🟡',
        content:  `${ (message.role || 'unknown').toUpperCase() }: ${ content.slice(0, 220) }`,
      });

      if (observations.length >= 8) {
        break;
      }
    }

    return observations;
  }

  /**
   * Run summarization immediately against the live state reference.
   * This is the mandatory path when callers must enforce message trimming before continuing.
   */
  static async summarizeNow(state: BaseThreadState): Promise<void> {
    const threadId = state.metadata.threadId;

    if (ConversationSummaryService.isProcessing ||
        ConversationSummaryService.processingQueue.has(threadId)) {
      console.log(`[ConversationSummary] Skipping - already processing thread ${ threadId }`);
      return;
    }

    if (state.messages.length <= TRIGGER_WINDOW_SIZE) {
      return;
    }

    ConversationSummaryService.processingQueue.add(threadId);
    try {
      await ConversationSummaryService.getInstance().processSummarization(state, threadId);
    } finally {
      ConversationSummaryService.processingQueue.delete(threadId);
    }
  }

  /**
   * Trigger background summarization for a conversation thread.
   * Non-blocking: returns immediately, work happens asynchronously.
   */
  static triggerBackgroundSummarization(state: BaseThreadState): void {
    void ConversationSummaryService.summarizeNow(state).catch(err => {
      const threadId = state.metadata.threadId;
      console.error(`[ConversationSummary] Fatal error for thread ${ threadId }:`, err);
    });
  }

  /**
   * Main summarization process with retry logic
   */
  private async processSummarization(state: BaseThreadState, threadId: string): Promise<void> {
    ConversationSummaryService.isProcessing = true;

    try {
      let attempts = 0;
      while (attempts < MAX_RETRY_ATTEMPTS) {
        try {
          await this.performSummarization(state);
          console.log(`[ConversationSummary] Successfully summarized thread ${ threadId } on attempt ${ attempts + 1 }`);
          break;
        } catch (err) {
          attempts++;
          console.warn(`[ConversationSummary] Attempt ${ attempts } failed for thread ${ threadId }:`,
            err instanceof Error ? err.message : String(err));

          if (attempts >= MAX_RETRY_ATTEMPTS) {
            console.error(`[ConversationSummary] All retry attempts exhausted for thread ${ threadId }`);
            throw err;
          }

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempts));
        }
      }
    } finally {
      ConversationSummaryService.isProcessing = false;
    }
  }

  /**
   * Core summarization logic that updates the state object directly
   */
  private async performSummarization(state: BaseThreadState): Promise<void> {
    const messages = state.messages;
    const batchSize = Math.floor(TRIGGER_WINDOW_SIZE * BATCH_SUMMARY_PERCENT);

    // 1. Check if oldest message is existing summary and extract its observations
    let existingObservations: ObservationEntry[] = [];
    let hasExistingSummary = false;

    if (messages.length > 0 &&
        messages[0].role === 'assistant' &&
        (messages[0].metadata as any)?._conversationSummary) {
      hasExistingSummary = true;
      // Extract observations from metadata if available
      const metadata = state.metadata as any;
      if (metadata.conversationSummaries) {
        existingObservations = [...metadata.conversationSummaries];
      }
    }

    // 2. Remove existing summary from messages before collecting batch
    const workingMessages = hasExistingSummary ? messages.slice(1) : messages;

    // 3. Score all messages for age and relevancy
    const messageScores = this.scoreMessages(workingMessages);

    // Protect system messages and the latest user message from summarization.
    const latestUserIndex = (() => {
      for (let i = workingMessages.length - 1; i >= 0; i--) {
        if (workingMessages[i].role === 'user') return i;
      }
      return -1;
    })();

    const summarizableScores = messageScores.filter(score => {
      if (score.message.role === 'system') return false;
      if (latestUserIndex >= 0 && score.index === latestUserIndex) return false;
      return true;
    });

    // Force summarization of everything that exceeds the trigger window budget.
    // Account for insertion of a summary message when there isn't one yet.
    const targetWindow = TRIGGER_WINDOW_SIZE - (hasExistingSummary ? 0 : 1);
    const requiredRemovalCount = Math.max(0, state.messages.length - targetWindow);
    const forcedOverflowScores = [...summarizableScores]
      .sort((a, b) => a.index - b.index) // Oldest first
      .slice(0, requiredRemovalCount);
    const forcedOverflowSet = new Set(forcedOverflowScores);

    // 4. Select messages that exceed the summarization threshold
    const candidateMessages = summarizableScores
      .filter(score => score.combinedScore >= SCORING_CONFIG.SUMMARIZATION_THRESHOLD)
      .filter(score => !forcedOverflowSet.has(score))
      .sort((a, b) => b.combinedScore - a.combinedScore) // Sort by score descending
      .slice(0, SCORING_CONFIG.MAX_BATCH_SIZE); // Cap at max batch size

    // 5. Ensure we have minimum batch size, add oldest messages if needed
    const messagesToSummarize: ChatMessage[] = forcedOverflowScores.map(score => score.message);
    messagesToSummarize.push(...candidateMessages.map(score => score.message));

    if (messagesToSummarize.length < SCORING_CONFIG.MIN_BATCH_SIZE) {
      // Add oldest non-protected messages to reach minimum batch size
      const remainingMessages = workingMessages.filter(msg =>
        !messagesToSummarize.includes(msg) &&
        msg.role !== 'system' &&
        workingMessages.indexOf(msg) !== latestUserIndex,
      );

      const additionalNeeded = SCORING_CONFIG.MIN_BATCH_SIZE - messagesToSummarize.length;
      messagesToSummarize.push(...remainingMessages.slice(0, additionalNeeded));
    }

    // Ensure tool_use/tool_result pairs are always summarized together.
    // If one half is selected, pull in the other half too.
    const summarizeSet = new Set(messagesToSummarize);
    for (let i = 0; i < workingMessages.length - 1; i++) {
      const msg = workingMessages[i];
      const next = workingMessages[i + 1];
      const isToolUse = msg.role === 'assistant' && Array.isArray(msg.content) &&
        msg.content.some((b: any) => b?.type === 'tool_use');
      const isToolResult = next.role === 'user' && Array.isArray(next.content) &&
        next.content.some((b: any) => b?.type === 'tool_result');
      if (isToolUse && isToolResult) {
        if (summarizeSet.has(msg) && !summarizeSet.has(next)) {
          messagesToSummarize.push(next);
          summarizeSet.add(next);
        } else if (summarizeSet.has(next) && !summarizeSet.has(msg)) {
          messagesToSummarize.push(msg);
          summarizeSet.add(msg);
        }
      }
    }

    if (messagesToSummarize.length < 2) {
      console.log('[ConversationSummary] Not enough messages to summarize, skipping');
      return;
    }

    console.log(`[ConversationSummary] Selected ${ messagesToSummarize.length } messages for summarization (${ forcedOverflowScores.length } forced overflow, ${ candidateMessages.length } exceeded threshold)`);

    // Log scoring details for debugging
    if (candidateMessages.length > 0) {
      const avgScore = candidateMessages.reduce((sum, s) => sum + s.combinedScore, 0) / candidateMessages.length;
      console.log(`[ConversationSummary] Average score: ${ avgScore.toFixed(3) }, threshold: ${ SCORING_CONFIG.SUMMARIZATION_THRESHOLD }`);
    }

    // 4. Generate new summary observations using LLM
    const newObservations = await this.summarizeBatch(state, messagesToSummarize);

    const effectiveObservations = newObservations.length > 0
      ? newObservations
      : this.buildFallbackObservations(messagesToSummarize);

    if (effectiveObservations.length === 0) {
      console.warn('[ConversationSummary] No observations generated, unable to build fallback summary');
      return;
    }

    // 5. Combine existing and new observations
    const allObservations = [...existingObservations, ...effectiveObservations];

    // 6. Update state metadata with combined observations
    const metadata = state.metadata as any;

    // 7. Remove summarized messages from snapshot (but keep existing summary position)
    const messagesToRemove = new Set(messagesToSummarize);
    let committedMessages = messages.filter(msg => !messagesToRemove.has(msg));

    // 8. Add/update comprehensive conversation summary as oldest message
    if (hasExistingSummary) {
      // Remove old summary (it's at index 0)
      committedMessages = committedMessages.slice(1);
    }

    state.messages.splice(0, state.messages.length, ...committedMessages);
    metadata.conversationSummaries = allObservations;
    this.appendConversationSummary(state, allObservations);

    console.log(`[ConversationSummary] Updated state: removed ${ messagesToRemove.size } messages, combined ${ existingObservations.length } existing + ${ effectiveObservations.length } new observations`);
  }

  /**
   * Summarize batch of messages into observational memory format
   */
  private async summarizeBatch(state: BaseThreadState, messages: ChatMessage[]): Promise<ObservationEntry[]> {
    // Build transcript from batch
    const transcript = messages
      .map(m => `${ (m.role || 'unknown').toUpperCase() }: ${
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      }`)
      .join('\n')
      .slice(0, 12_000); // Cap input size

    // Get primary LLM service
    const llmService = await getPrimaryService();

    // Prepare messages for LLM
    const llmMessages: ChatMessage[] = [
      {
        role:    'system',
        content: BATCH_SUMMARY_PROMPT,
      },
      {
        role:    'user',
        content: `Here are the conversation messages to extract observations from:\n\n${ transcript }`,
      },
    ];

    const response = await llmService.chat(llmMessages, {
      temperature: 0.1, // Low temperature for consistent extraction
      maxTokens:   1000,
      format:      'json',
      tools:       [], // No tools needed for conversation summarization
    });

    if (!response) {
      console.error('[ConversationSummary] No response from LLM during batch summarization - returning empty observations');
      return [];
    }

    const data = parseJson(response.content) as { observations?: ObservationEntry[] } | null;
    const observations = Array.isArray(data?.observations) ? data.observations : [];

    // Validate and return observations
    return observations
      .filter((obs: ObservationEntry) => obs.priority && obs.content && typeof obs.content === 'string')
      .slice(0, 8); // Cap at 8 observations
  }

  /**
   * Append comprehensive conversation summary message to state
   */
  private appendConversationSummary(state: BaseThreadState, allObservations: ObservationEntry[]): void {
    if (!allObservations.length) return;

    // Group observations by priority
    const critical = allObservations.filter(obs => obs.priority === '🔴');
    const valuable = allObservations.filter(obs => obs.priority === '🟡');
    const low = allObservations.filter(obs => obs.priority === '⚪');

    const sections = [];

    if (critical.length > 0) {
      sections.push(`**Critical Context:**\n${ critical.map(obs => `• ${ obs.content }`).join('\n') }`);
    }

    if (valuable.length > 0) {
      sections.push(`**Key Context:**\n${ valuable.map(obs => `• ${ obs.content }`).join('\n') }`);
    }

    if (low.length > 0) {
      sections.push(`**Background:**\n${ low.map(obs => `• ${ obs.content }`).join('\n') }`);
    }

    const summaryContent = `## Conversation Summary\n\n${ sections.join('\n\n') }`;

    // Add summary message to state as the oldest message
    state.messages.unshift({
      role:     'assistant',
      content:  summaryContent,
      metadata: {
        nodeId:               this.id,
        timestamp:            Date.now(),
        _conversationSummary: true, // Flag for identification
      },
    });

    // Guard against consecutive assistant messages after unshift.
    // If the first remaining message is also assistant-role, insert a
    // synthetic user message to satisfy the alternating-role requirement.
    if (state.messages.length >= 2 &&
        state.messages[0]?.role === 'assistant' &&
        state.messages[1]?.role === 'assistant') {
      state.messages.splice(1, 0, {
        role:     'user',
        content:  '(continued)',
        metadata: { _synthetic: true, timestamp: Date.now() },
      });
    }
  }
}
