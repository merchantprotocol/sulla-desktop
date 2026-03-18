// ObservationalSummaryService.ts
// Background service that manages the growing observational memory list
// by spawning the observation-curator agent to prioritize and trim observations
// through the lens of the human's active goals.
//
// Key Features:
// - Non-blocking: triggered from InputHandler but runs in background
// - Observation-focused: only manages the observational memory, not messages
// - Goal-aware: spawns the observation-curator agent which loads goal journals
// - Concurrency safe: coordinates with ConversationSummaryService
// - Line-based limits: counts observation lines vs fixed count limits
// - Fallback: degrades to raw LLM call if agent spawn fails

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

/** The agent ID used for goal-aware observation curation */
const CURATOR_AGENT_ID = 'observation-curator';

// ============================================================================
// CURATOR AGENT PROMPT TEMPLATE
// ============================================================================

const CURATOR_TASK_PROMPT = `You are running as a background observation curator. Your task is to prioritize and trim a list of observations that has grown too large.

**IMPORTANT:** Before prioritizing, read the current daily goals from:
- ~/sulla/identity/human-journal.md — human goals (daily, weekly, 13-week)
- ~/sulla/identity/business-journal.md — business goals
- ~/sulla/identity/agent-journal.md — agent goals

Use these goals as your filtering lens. Observations that relate to active goals are more valuable.

Here are the current observations to curate:

{OBSERVATIONS}

**Rules:**
1. Never drop observations about explicit human preferences, hard-no's, or identity signals
2. Never drop observations less than 2 hours old
3. Bias toward keeping over dropping — when in doubt, keep
4. 🔴 Critical observations (identity, core preferences, promises, deal-breakers, goal-critical) have highest priority
5. 🟡 Valuable observations (decisions, patterns, progress toward goals) have medium priority
6. ⚪ Low priority observations (minor details unrelated to goals) have lowest priority
7. Merge duplicates — if multiple observations cover the same fact, keep only the most complete version
8. Consolidate related facts into single richer observations
9. Remove outdated observations superseded by newer ones

**You MUST respond with ONLY valid JSON — no explanations, no markdown, no additional text:**
{
  "selectedObservations": [
    { "priority": "🔴", "content": "Observation content to keep" }
  ],
  "reasoning": "Brief explanation of prioritization decisions including which goals influenced your choices"
}`;

// ============================================================================
// FALLBACK PROMPT (used when agent spawn fails)
// ============================================================================

const FALLBACK_PRIORITIZATION_PROMPT = `
You are an observational memory curator. Your job is to prioritize and trim a list of observations
that has grown too large, keeping only the most valuable ones.

Rules for prioritization:
- 🔴 Critical observations (identity, core preferences, promises, deal-breakers) have highest priority
- 🟡 Valuable observations (decisions, patterns, progress) have medium priority
- ⚪ Low priority observations (minor details) have lowest priority
- Within same priority level, prefer more recent and specific observations
- **Merge duplicates**: If multiple observations cover the same fact or event, keep ONLY the most complete and recent version.
- **Consolidate related facts**: Combine observations about the same topic into a single, richer observation.
- Remove outdated observations that have been superseded by newer ones
- Keep observations that provide unique context or insights

Your task: Select the most important observations to keep, removing the least valuable ones.

IMPORTANT: Your response must be valid JSON only. No explanations, no markdown, no additional text.
Return only the JSON object specified in the format above.
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
  content:  string;
}

interface PrioritizationResult {
  selectedObservations: ObservationEntry[];
  reasoning?:           string;
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
    const threadId = state.metadata.threadId;

    // Skip if already processing this thread or any thread
    if (ObservationalSummaryService.isProcessing ||
        ObservationalSummaryService.processingQueue.has(threadId)) {
      return;
    }

    // Check if ConversationSummaryService is currently processing this thread
    // Import dynamically to avoid circular dependency
    try {
      const { ConversationSummaryService } = require('./ConversationSummaryService');
      if (ConversationSummaryService.isProcessingThread?.(threadId)) {
        if (!_deferLogged) {
          console.log(`[ObservationalSummary] Deferring until ConversationSummaryService finishes thread ${ threadId }`);
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
          console.error(`[ObservationalSummary] Fatal error for thread ${ threadId }:`, err);
        })
        .finally(() => {
          ObservationalSummaryService.processingQueue.delete(threadId);
        });
    }, 0);

    console.log(`[ObservationalSummary] Queued background trimming for thread ${ threadId } (${ currentLines } lines)`);
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
          console.log(`[ObservationalSummary] Successfully trimmed observations for thread ${ threadId } on attempt ${ attempts + 1 }`);
          break;
        } catch (err) {
          attempts++;
          console.warn(`[ObservationalSummary] Attempt ${ attempts } failed for thread ${ threadId }:`,
            err instanceof Error ? err.message : String(err));

          if (attempts >= MAX_RETRY_ATTEMPTS) {
            console.error(`[ObservationalSummary] All retry attempts exhausted for thread ${ threadId }`);
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
   * Core trimming logic — spawns the observation-curator agent for goal-aware curation
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

    console.log(`[ObservationalSummary] Trimming ${ currentObservations.length } observations (${ currentLines } lines -> target: ${ TARGET_OBSERVATION_LINES })`);

    // Prioritize observations — try curator agent first, fall back to raw LLM
    const prioritizedObservations = await this.prioritizeWithCuratorAgent(currentObservations)
      || await this.prioritizeWithFallbackLLM(currentObservations);

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

    console.log(`[ObservationalSummary] Trimmed to ${ selectedObservations.length } observations (${ newLines } lines)`);

    // Update conversation summary message if it exists
    this.updateConversationSummaryMessage(state, selectedObservations);
  }

  /**
   * Spawn the observation-curator agent to prioritize observations with goal awareness.
   * The curator agent loads goal journals and filters through the goal lens.
   * Returns null if the agent spawn fails (caller should fall back to LLM).
   */
  private async prioritizeWithCuratorAgent(observations: ObservationEntry[]): Promise<ObservationEntry[] | null> {
    try {
      const { GraphRegistry } = await import('./GraphRegistry');

      const observationText = observations
        .map(obs => `${ obs.priority } ${ obs.content }`)
        .join('\n');

      const prompt = CURATOR_TASK_PROMPT.replace('{OBSERVATIONS}', observationText);

      const threadId = `obs-curator-${ Date.now() }-${ Math.random().toString(36).slice(2, 8) }`;

      console.log(`[ObservationalSummary] Spawning observation-curator agent (threadId=${ threadId })`);

      const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(CURATOR_AGENT_ID, threadId) as {
        graph: any;
        state: any;
      };

      // Inject the curation task as a user message
      subState.messages.push({ role: 'user', content: prompt });

      // Mark as sub-agent so blocked status doesn't trigger waitingForUser
      subState.metadata.isSubAgent = true;

      // Execute the curator agent graph
      const finalState = await graph.execute(subState);

      // Extract the result from the agent's final output
      const agentOutput = finalState.metadata?.finalSummary ||
        finalState.messages?.[finalState.messages.length - 1]?.content ||
        '';

      const outputStr = typeof agentOutput === 'string' ? agentOutput : JSON.stringify(agentOutput);

      // Parse JSON from the agent's response (it may be wrapped in markdown or contract tags)
      const jsonMatch = outputStr.match(/\{[\s\S]*"selectedObservations"[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[ObservationalSummary] Curator agent response did not contain expected JSON structure');
        // Clean up the registry entry
        GraphRegistry.delete(threadId);
        return null;
      }

      const data = parseJson(jsonMatch[0]) as PrioritizationResult | null;
      const selectedObservations = Array.isArray(data?.selectedObservations) ? data.selectedObservations : [];

      const validObservations = selectedObservations
        .filter((obs: ObservationEntry) => obs.priority && obs.content && typeof obs.content === 'string');

      if (data?.reasoning) {
        console.log(`[ObservationalSummary] Curator reasoning: ${ data.reasoning }`);
      }

      // Clean up the registry entry
      GraphRegistry.delete(threadId);

      if (validObservations.length > 0) {
        console.log(`[ObservationalSummary] Curator agent returned ${ validObservations.length } prioritized observations`);
        return validObservations;
      }

      console.warn('[ObservationalSummary] Curator agent returned no valid observations');
      return null;
    } catch (err) {
      console.warn('[ObservationalSummary] Curator agent spawn failed, will fall back to LLM:',
        err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Fallback: use a raw LLM call for observation prioritization
   * when the curator agent is unavailable or fails.
   */
  private async prioritizeWithFallbackLLM(observations: ObservationEntry[]): Promise<ObservationEntry[]> {
    console.log('[ObservationalSummary] Using fallback LLM prioritization (no goal awareness)');

    const llmService = await getPrimaryService();

    const observationText = observations
      .map(obs => `${ obs.priority } ${ obs.content }`)
      .join('\n');

    const llmMessages: ChatMessage[] = [
      {
        role:    'system',
        content: FALLBACK_PRIORITIZATION_PROMPT,
      },
      {
        role:    'user',
        content: `Here are the observations to prioritize and trim:\n\n${ observationText }`,
      },
    ];

    const response = await llmService.chat(llmMessages, {
      temperature: 0.1,
      maxTokens:   2000,
      format:      'json',
      tools:       [],
    });

    if (!response) {
      console.error('[ObservationalSummary] No response from fallback LLM — returning original observations');
      return observations;
    }

    const data = parseJson(response.content) as PrioritizationResult | null;
    const selectedObservations = Array.isArray(data?.selectedObservations) ? data.selectedObservations : [];

    const validObservations = selectedObservations
      .filter((obs: ObservationEntry) => obs.priority && obs.content && typeof obs.content === 'string');

    if (data?.reasoning) {
      console.log(`[ObservationalSummary] Fallback LLM reasoning: ${ data.reasoning }`);
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
      msg.role === 'assistant' && (msg.metadata as any)?._conversationSummary,
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
      sections.push(`**Critical Context:**\n${ critical.map(obs => `• ${ obs.content }`).join('\n') }`);
    }

    if (valuable.length > 0) {
      sections.push(`**Key Context:**\n${ valuable.map(obs => `• ${ obs.content }`).join('\n') }`);
    }

    if (low.length > 0) {
      sections.push(`**Background:**\n${ low.map(obs => `• ${ obs.content }`).join('\n') }`);
    }

    const summaryContent = `## Conversation Summary\n\n${ sections.join('\n\n') }`;

    // Add summary message to state as oldest message
    state.messages.unshift({
      role:     'assistant',
      content:  summaryContent,
      metadata: {
        nodeId:               this.id,
        timestamp:            Date.now(),
        _conversationSummary: true, // Flag for identification
      },
    });
  }
}
