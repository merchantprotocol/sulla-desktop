// ObservationalSummaryService.ts
// Background service that manages the growing observational memory list
// by prioritizing and trimming observations when they exceed line limits.
//
// Key Features:
// - Non-blocking: triggered from InputHandler but runs in background
// - Observation-focused: only manages the observational memory, not messages
// - Priority-based: uses LLM to rank observations by priority when trimming
// - Concurrency safe: coordinates with ConversationSummaryService
// - Line-based limits: counts observation lines vs fixed count limits

import type { BaseThreadState } from '../nodes/Graph';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { getPrimaryService } from '../languagemodels';
import { parseJson } from './JsonParseService';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Maximum lines allowed in observational summary before trimming */
const MAX_OBSERVATION_LINES = 35;

/** Target lines to trim down to when limit exceeded */
const TARGET_OBSERVATION_LINES = 25;

/** Max retries for failed prioritization attempts */
const MAX_RETRY_ATTEMPTS = 2;

/** Delay between retry attempts (ms) */
const RETRY_DELAY_MS = 1000;

// ============================================================================
// OBSERVATION PRIORITIZATION PROMPT
// ============================================================================

const JSON_ONLY_RESPONSE_INSTRUCTIONS = `
IMPORTANT: Your response must be valid JSON only. No explanations, no markdown, no additional text.
Return only the JSON object specified in the format above.`;

const OBSERVATION_PRIORITIZATION_PROMPT = `
You are an observational memory curator. Your job is to prioritize and trim a list of observations 
that has grown too large, keeping only the most valuable ones.

Rules for prioritization:
- 🔴 Critical observations (identity, core preferences, promises, deal-breakers) have highest priority
- 🟡 Valuable observations (decisions, patterns, progress) have medium priority  
- ⚪ Low priority observations (minor details) have lowest priority
- Within same priority level, prefer more recent and specific observations
- Remove redundant or outdated observations
- Keep observations that provide unique context or insights

Your task: Select the most important observations to keep, removing the least valuable ones.

${JSON_ONLY_RESPONSE_INSTRUCTIONS}
{
  "selectedObservations": [
    {
      "priority": "🔴",
      "content": "Observation content to keep"
    }
  ],
  "reasoning": "Brief explanation of prioritization decisions"
}`.trim();

// ============================================================================
// OBSERVATIONAL SUMMARY SERVICE
// ============================================================================

interface ObservationEntry {
  priority: string;
  content: string;
}

interface PrioritizationResult {
  selectedObservations: ObservationEntry[];
  reasoning?: string;
}

export class ObservationalSummaryService {
  private static instance: ObservationalSummaryService | null = null;
  private static isProcessing = false;
  private static processingQueue = new Set<string>();
  
  public readonly id = 'observational_summary_service';
  public readonly name = 'Observational Summary Service';

  constructor() {
    // Standalone service - no BaseNode dependency
  }

  /**
   * Get singleton instance of the service
   */
  private static getInstance(): ObservationalSummaryService {
    if (!ObservationalSummaryService.instance) {
      ObservationalSummaryService.instance = new ObservationalSummaryService();
    }
    return ObservationalSummaryService.instance;
  }

  /**
   * Trigger background observation trimming for a conversation thread.
   * Non-blocking: returns immediately, work happens asynchronously.
   */
  static triggerBackgroundTrimming(state: BaseThreadState, _deferLogged = false): void {
    const threadId = state.metadata.threadId as string;
    
    // Skip if already processing this thread or any thread
    if (ObservationalSummaryService.isProcessing || 
        ObservationalSummaryService.processingQueue.has(threadId)) {
      return;
    }

    // Check if ConversationSummaryService is currently processing this thread
    // Import dynamically to avoid circular dependency
    try {
      const { ConversationSummaryService } = require('./ConversationSummaryService');
      if (ConversationSummaryService.isProcessingThread && 
          ConversationSummaryService.isProcessingThread(threadId)) {
        if (!_deferLogged) {
          console.log(`[ObservationalSummary] Deferring until ConversationSummaryService finishes thread ${threadId}`);
        }
        // Retry after delay (suppress repeated log)
        setTimeout(() => ObservationalSummaryService.triggerBackgroundTrimming(state, true), 2000);
        return;
      }
    } catch (err) {
      // If ConversationSummaryService not available, continue
    }

    // Check if trimming is actually needed
    const currentLines = ObservationalSummaryService.countObservationLines(state);
    if (currentLines <= MAX_OBSERVATION_LINES) {
      return;
    }

    // Queue the work asynchronously 
    ObservationalSummaryService.processingQueue.add(threadId);
    setTimeout(() => {
      ObservationalSummaryService.getInstance()
        .processTrimming(state, threadId)
        .catch(err => {
          console.error(`[ObservationalSummary] Fatal error for thread ${threadId}:`, err);
        })
        .finally(() => {
          ObservationalSummaryService.processingQueue.delete(threadId);
        });
    }, 0);

    console.log(`[ObservationalSummary] Queued background trimming for thread ${threadId} (${currentLines} lines)`);
  }

  /**
   * Count total lines in observational summary
   */
  private static countObservationLines(state: BaseThreadState): number {
    const metadata = state.metadata as any;
    const observations = metadata.conversationSummaries || [];
    
    return observations.reduce((total: number, obs: ObservationEntry) => {
      // Count lines in content (split by \n and count)
      const contentLines = obs.content.split('\n').length;
      return total + contentLines;
    }, 0);
  }

  /**
   * Main trimming process with retry logic
   */
  private async processTrimming(state: BaseThreadState, threadId: string): Promise<void> {
    ObservationalSummaryService.isProcessing = true;

    try {
      let attempts = 0;
      while (attempts < MAX_RETRY_ATTEMPTS) {
        try {
          await this.performTrimming(state);
          console.log(`[ObservationalSummary] Successfully trimmed observations for thread ${threadId} on attempt ${attempts + 1}`);
          break;
        } catch (err) {
          attempts++;
          console.warn(`[ObservationalSummary] Attempt ${attempts} failed for thread ${threadId}:`, 
            err instanceof Error ? err.message : String(err));

          if (attempts >= MAX_RETRY_ATTEMPTS) {
            console.error(`[ObservationalSummary] All retry attempts exhausted for thread ${threadId}`);
            throw err;
          }

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempts));
        }
      }
    } finally {
      ObservationalSummaryService.isProcessing = false;
    }
  }

  /**
   * Core trimming logic that prioritizes observations using LLM
   */
  private async performTrimming(state: BaseThreadState): Promise<void> {
    const metadata = state.metadata as any;
    const currentObservations = metadata.conversationSummaries || [];
    
    if (currentObservations.length === 0) {
      console.log('[ObservationalSummary] No observations to trim, skipping');
      return;
    }

    const currentLines = ObservationalSummaryService.countObservationLines(state);
    if (currentLines <= MAX_OBSERVATION_LINES) {
      console.log('[ObservationalSummary] Observation count within limits, skipping');
      return;
    }

    console.log(`[ObservationalSummary] Trimming ${currentObservations.length} observations (${currentLines} lines -> target: ${TARGET_OBSERVATION_LINES})`);

    // Use LLM to prioritize observations
    const prioritizedObservations = await this.prioritizeObservations(state, currentObservations);
    
    if (prioritizedObservations.length === 0) {
      console.warn('[ObservationalSummary] No observations selected by prioritization, skipping trim');
      return;
    }

    // Calculate target count based on line limits
    const targetCount = this.calculateTargetCount(prioritizedObservations, TARGET_OBSERVATION_LINES);
    const selectedObservations = prioritizedObservations.slice(0, targetCount);

    // Update state metadata with trimmed observations
    metadata.conversationSummaries = selectedObservations;

    const newLines = selectedObservations.reduce((total: number, obs: ObservationEntry) => {
      return total + obs.content.split('\n').length;
    }, 0);

    console.log(`[ObservationalSummary] Trimmed to ${selectedObservations.length} observations (${newLines} lines)`);

    // Update conversation summary message if it exists
    this.updateConversationSummaryMessage(state, selectedObservations);
  }

  /**
   * Use LLM to prioritize observations based on importance
   */
  private async prioritizeObservations(state: BaseThreadState, observations: ObservationEntry[]): Promise<ObservationEntry[]> {
    // Get LLM service using same logic as conversation system
    const llmService = await getPrimaryService();
    
    // Build observation list for LLM
    const observationText = observations
      .map(obs => `${obs.priority} ${obs.content}`)
      .join('\n');
    
    // Prepare messages for LLM
    const llmMessages: ChatMessage[] = [
      {
        role: 'system',
        content: OBSERVATION_PRIORITIZATION_PROMPT
      },
      {
        role: 'user', 
        content: `Here are the observations to prioritize and trim:\n\n${observationText}`
      }
    ];

    const response = await llmService.chat(llmMessages, {
      temperature: 0.1, // Low temperature for consistent prioritization
      maxTokens: 2000,
      format: 'json',
      tools: [] // No tools needed for observation prioritization
    });

    if (!response) {
      console.error('[ObservationalSummary] No response from LLM during prioritization - returning original observations');
      return observations;
    }

    const data = parseJson(response.content) as PrioritizationResult | null;
    const selectedObservations = Array.isArray(data?.selectedObservations) ? data.selectedObservations : [];
    
    // Validate and return prioritized observations
    const validObservations = selectedObservations
      .filter(obs => obs.priority && obs.content && typeof obs.content === 'string');

    if (data?.reasoning) {
      console.log(`[ObservationalSummary] LLM reasoning: ${data.reasoning}`);
    }

    return validObservations.length > 0 ? validObservations : observations;
  }

  /**
   * Calculate how many observations to keep based on target line count
   */
  private calculateTargetCount(observations: ObservationEntry[], targetLines: number): number {
    let lineCount = 0;
    let count = 0;
    
    for (const obs of observations) {
      const obsLines = obs.content.split('\n').length;
      if (lineCount + obsLines > targetLines && count > 0) {
        break;
      }
      lineCount += obsLines;
      count++;
    }
    
    return Math.max(count, Math.floor(observations.length * 0.5)); // Keep at least 50%
  }

  /**
   * Update the conversation summary message with new observations
   */
  private updateConversationSummaryMessage(state: BaseThreadState, observations: ObservationEntry[]): void {
    // Find existing conversation summary message
    const summaryIndex = state.messages.findIndex(msg => 
      msg.role === 'assistant' && (msg.metadata as any)?._conversationSummary
    );
    
    if (summaryIndex >= 0) {
      // Remove old summary and add updated one
      state.messages.splice(summaryIndex, 1);
      this.appendConversationSummary(state, observations);
      console.log('[ObservationalSummary] Updated conversation summary message');
    }
  }

  /**
   * Append conversation summary message to state (copied from ConversationSummaryService)
   */
  private appendConversationSummary(state: BaseThreadState, allObservations: ObservationEntry[]): void {
    if (!allObservations.length) return;
    
    // Group observations by priority
    const critical = allObservations.filter(obs => obs.priority === '🔴');
    const valuable = allObservations.filter(obs => obs.priority === '🟡');
    const low = allObservations.filter(obs => obs.priority === '⚪');
    
    const sections = [];
    
    if (critical.length > 0) {
      sections.push(`**Critical Context:**\n${critical.map(obs => `• ${obs.content}`).join('\n')}`);
    }
    
    if (valuable.length > 0) {
      sections.push(`**Key Context:**\n${valuable.map(obs => `• ${obs.content}`).join('\n')}`);
    }
    
    if (low.length > 0) {
      sections.push(`**Background:**\n${low.map(obs => `• ${obs.content}`).join('\n')}`);
    }
    
    const summaryContent = `## Conversation Summary\n\n${sections.join('\n\n')}`;
    
    // Add summary message to state as oldest message
    state.messages.unshift({
      role: 'assistant',
      content: summaryContent,
      metadata: {
        nodeId: this.id,
        timestamp: Date.now(),
        _conversationSummary: true, // Flag for identification
      }
    });
  }
}
