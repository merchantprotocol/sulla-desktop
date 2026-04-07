// HeartbeatNode.ts
// LLM-powered autonomous heartbeat agent. Mirrors AgentNode's execution
// pattern but uses the dreaming-protocol agent config for its identity
// and shows desktop notifications instead of WebSocket chat messages.

import { BaseNode } from './BaseNode';
import type { NodeRunPolicy } from './BaseNode';
import type { BaseThreadState, NodeResult } from './Graph';
import { throwIfAborted } from '../services/AbortService';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { stripProtocolTags } from '../utils/stripProtocolTags';
import { runSubconsciousMiddleware } from '../middleware/SubconsciousMiddleware';
import { GraphRegistry } from '../services/GraphRegistry';

// ============================================================================
// PROMPT CONSTANTS
// ============================================================================

async function buildChannelAwarenessPrompt(wsChannel: string): Promise<string> {
  try {
    const { getActiveAgentsRegistry } = await import('../services/ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    const block = await registry.buildContextBlock();
    return `${ block }\n\nYou run on the **${ wsChannel }** WebSocket channel. Your \`sender_id\` and \`sender_channel\` are both \`${ wsChannel }\`.`;
  } catch {
    return `## Inter-Agent Communication\n\nYou run on the **${ wsChannel }** WebSocket channel. Agent registry unavailable.`;
  }
}

const HEARTBEAT_PROMPT_DIRECTIVE = `## Output Rules — CRITICAL

Your text output triggers a desktop notification. The user does NOT want to see your thinking, reasoning, planning, or tool narration. They want terse status updates only.

**Your response text must be ONLY one of these:**

1. **Picking up a project:**
   Tell the user where the project stands, where it needs to go, and what your plan is.
   Example:
   > **Lead Generation** — Currently: scraper built but no enrichment pipeline. Goal: fully automated lead list with email verification. Plan: wire up the Clearbit integration, add email validation step, test with 50 leads.

2. **Made progress:**
   Say what you did and what's next.
   Example:
   > **Lead Generation**: Wired up Clearbit enrichment, 50 test leads processed. Next: add email verification step.

3. **No projects found:** "No active projects found."

That's it. Nothing else in your response text. No thinking. No "let me check." No "I found 3 projects, let me evaluate." No narration of tool calls. Just the status.

All detailed reasoning, tool results, and decision-making happen silently in your tool calls. Your final text response is the notification.

## ACTIVE_PROJECTS.md — Status Tracking

After every cycle where you make progress or hit a blocker, update \`~/sulla/projects/ACTIVE_PROJECTS.md\`:

- Record your current status for each project you touched: what you did, what's next, any blockers.
- Blockers go here, not in notifications — the user checks this file at their own pace.
- Keep entries concise: project name, status (active/blocked/done), one-line summary, blocker details if any.

## Completion Wrappers

- You MUST end every response with exactly ONE of the three wrapper blocks: DONE, BLOCKED, or CONTINUE.
- If the task is fully accomplished, output the DONE wrapper.
- If execution is blocked and you cannot proceed, output the BLOCKED wrapper.
- If you have made progress but the task is not yet complete, output the CONTINUE wrapper with a one-line status message of what you are working on right now.`;

const HEARTBEAT_PROMPT_COMPLETION_WRAPPERS = `
CRITICAL CONTINUITY RULES:
- This is a persistent conversation. Review the entire message history before every action.
- If you see the same user request again, it means previous actions failed or were incomplete — continue from there using the latest state.
- Never restart or repeat steps that are already marked complete in memory.
- Don't use language that would suggest this is a brand new conversation, like: "On it.", "Got it." etc.

DONE wrapper (use when goal fully completed):
<AGENT_DONE>
[1-3 sentence summary of what was accomplished]
Needs user input: [yes/no]
</AGENT_DONE>

BLOCKED wrapper (use when you need user input, credentials, or a decision before you can continue):
<AGENT_BLOCKED>
<BLOCKER_REASON>[one-line concrete blocker]</BLOCKER_REASON>
<UNBLOCK_REQUIREMENTS>[exact dependency/credential/input needed to proceed]</UNBLOCK_REQUIREMENTS>
</AGENT_BLOCKED>

IMPORTANT: If you have a question for the user, you MUST use the BLOCKED wrapper. Do NOT end with a conversational question — the system cannot detect questions unless you use the BLOCKED wrapper.

CONTINUE wrapper (use when you made progress but the task is NOT yet complete):
<AGENT_CONTINUE>
<STATUS_REPORT>[one-line: what you are actively working on now]</STATUS_REPORT>
</AGENT_CONTINUE>

You MUST end every response with exactly ONE of these three wrappers. Never end a response without one.
`;

// ============================================================================
// OUTCOME EXTRACTION — XML REGEXES
// ============================================================================

const AGENT_DONE_XML_REGEX = /<AGENT_DONE>([\s\S]*?)<\/AGENT_DONE>/i;
const AGENT_BLOCKED_XML_REGEX = /<AGENT_BLOCKED>([\s\S]*?)<\/AGENT_BLOCKED>/i;
const BLOCKER_REASON_XML_REGEX = /<BLOCKER_REASON>([\s\S]*?)<\/BLOCKER_REASON>/i;
const UNBLOCK_REQUIREMENTS_XML_REGEX = /<UNBLOCK_REQUIREMENTS>([\s\S]*?)<\/UNBLOCK_REQUIREMENTS>/i;
const AGENT_CONTINUE_XML_REGEX = /<AGENT_CONTINUE>([\s\S]*?)<\/AGENT_CONTINUE>/i;
const STATUS_REPORT_XML_REGEX = /<STATUS_REPORT>([\s\S]*?)<\/STATUS_REPORT>/i;
const NEEDS_USER_INPUT_REGEX = /Needs user input:\s*(yes|no)/i;

// ============================================================================
// NODE
// ============================================================================

/**
 * Heartbeat Node — LLM-powered autonomous agent.
 *
 * Mirrors AgentNode's execution pattern:
 *   1. Builds system prompt with channel awareness + completion wrappers
 *   2. Enriches with agent identity from dreaming-protocol config
 *   3. Runs subconscious middleware (memory recall, observations)
 *   4. Calls LLM, processes tool calls, extracts outcome
 *   5. Shows desktop notification instead of WebSocket chat
 *
 * Loops via the heartbeat graph until DONE or BLOCKED.
 */
export class HeartbeatNode extends BaseNode {
  constructor() {
    super('heartbeat', 'Heartbeat');
  }

  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> {
    const startTime = Date.now();

    // Check abort signal
    const abortSignal = (state.metadata as any).abortSignal as AbortSignal | undefined;
    if (abortSignal?.aborted) {
      console.log('[HeartbeatNode] Abort signal received — exiting');
      return { state, decision: { type: 'end' } };
    }

    // ----------------------------------------------------------------
    // 1. BUILD SYSTEM PROMPT
    // ----------------------------------------------------------------
    const wsChannel = String(state.metadata.wsChannel || 'heartbeat');
    const channelAwareness = await buildChannelAwarenessPrompt(wsChannel);

    // Load the user-editable heartbeat prompt from language model settings
    const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
    const settingsHeartbeatPrompt = await SullaSettingsModel.get('heartbeatPrompt', '');

    const baseSystemPrompt = [
      channelAwareness,
      settingsHeartbeatPrompt,
      HEARTBEAT_PROMPT_DIRECTIVE,
      HEARTBEAT_PROMPT_COMPLETION_WRAPPERS,
    ].filter(s => s.trim()).join('\n\n');

    // Enrich with global soul prompt + agent identity from dreaming-protocol config.
    const enrichedPrompt = await this.enrichPrompt(baseSystemPrompt, state, {
      includeSoul:        true,
      includeAwareness:   false,
      includeEnvironment: false,
      includeMemory:      false,
    });

    // ----------------------------------------------------------------
    // 2. SUBCONSCIOUS MIDDLEWARE (memory recall, observations)
    // ----------------------------------------------------------------
    const shouldInjectObservations = await this.shouldInjectObservationsForAgent(state);
    await runSubconsciousMiddleware(state, {
      includeObservations: shouldInjectObservations,
      recallVariant:       'heartbeat',
    });

    // Merge recall context into the last assistant message so the
    // agent treats it as its own knowledge.
    const recallContext = (state.metadata as any).recallContext;
    if (recallContext) {
      const recallBlock = `\n\n<recall_context>\n${ recallContext }\n</recall_context>`;
      let merged = false;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].role === 'assistant') {
          const msg = state.messages[i];
          if (typeof msg.content === 'string') {
            msg.content += recallBlock;
          } else if (Array.isArray(msg.content)) {
            msg.content.push({ type: 'text', text: recallBlock });
          } else {
            msg.content = (msg.content ? JSON.stringify(msg.content) : '') + recallBlock;
          }
          merged = true;
          break;
        }
      }
      if (!merged) {
        const insertIdx = Math.max(0, state.messages.length - 1);
        state.messages.splice(insertIdx, 0, {
          role:     'assistant',
          content:  recallBlock.trim(),
          metadata: { source: 'recall', _synthetic: true },
        });
      }
    }

    // Merge unstuck context from a previous cycle's analysis (if any)
    const unstuckContext = (state.metadata as any).unstuckContext;
    if (unstuckContext) {
      const unstuckBlock = `\n\n<unstuck_context>\nSpecialist agents analyzed why you got stuck and found these options:\n\n${ unstuckContext }\n</unstuck_context>`;
      let unstuckMerged = false;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].role === 'assistant') {
          const msg = state.messages[i];
          if (typeof msg.content === 'string') {
            msg.content += unstuckBlock;
          } else if (Array.isArray(msg.content)) {
            msg.content.push({ type: 'text', text: unstuckBlock });
          } else {
            msg.content = (msg.content ? JSON.stringify(msg.content) : '') + unstuckBlock;
          }
          unstuckMerged = true;
          break;
        }
      }
      if (!unstuckMerged) {
        const insertIdx = Math.max(0, state.messages.length - 1);
        state.messages.splice(insertIdx, 0, {
          role:     'assistant',
          content:  unstuckBlock.trim(),
          metadata: { source: 'unstuck', _synthetic: true },
        });
      }
      // Clear after injection — consumed once
      delete (state.metadata as any).unstuckContext;
    }

    // ----------------------------------------------------------------
    // 3. EXECUTE — LLM call with tool access
    // ----------------------------------------------------------------
    const reply = await this.executeHeartbeat(enrichedPrompt, state);

    // Abort check after LLM response
    throwIfAborted(state, 'Heartbeat execution aborted after LLM response');

    const resultText = typeof reply === 'string' ? reply : '';
    const outcome = this.extractAgentOutcome(resultText);
    const userVisibleText = this.toUserVisibleAgentMessage(resultText, outcome);

    // ----------------------------------------------------------------
    // 4. STORE OUTCOME ON METADATA
    // ----------------------------------------------------------------
    const statusNote = this.toOneLineStatusNote(
      outcome.statusReport ||
      outcome.blockerReason ||
      outcome.summary ||
      '',
    );

    (state.metadata as any).agent = {
      ...((state.metadata as any).agent || {}),
      status:               outcome.status,
      status_report:        outcome.statusReport,
      blocker_reason:       outcome.blockerReason,
      unblock_requirements: outcome.unblockRequirements,
      status_note:          statusNote,
      response:             outcome.status === 'done' ? stripProtocolTags(resultText) : null,
      updatedAt:            Date.now(),
    };

    if (outcome.status === 'done') {
      state.metadata.cycleComplete = true;
    }

    if (outcome.status === 'blocked') {
      state.metadata.cycleComplete = true;
      // Heartbeat is headless — no waitingForUser
    }

    if (statusNote) {
      await this.updateAgentStatusNote(state, statusNote);
    }

    // ----------------------------------------------------------------
    // 4b. POST-CYCLE UNSTUCK — if blocked or quick done, run analysis
    // ----------------------------------------------------------------
    const agentLoopCount = (state.metadata as any).agentLoopCount || 0;
    const unstuckAttempts = (state.metadata as any).unstuckAttempts || 0;
    const shouldRunUnstuck =
      unstuckAttempts === 0 &&
      (outcome.status === 'blocked' ||
       (outcome.status === 'done' && agentLoopCount <= 2));

    if (shouldRunUnstuck) {
      (state.metadata as any).unstuckAttempts = 1;
      await this.runUnstuckMiddleware(state);

      // If unstuck agents found something, override status to continue
      // so the graph routes back for another heartbeat cycle with fresh ideas
      if ((state.metadata as any).unstuckContext) {
        (state.metadata as any).agent = {
          ...((state.metadata as any).agent || {}),
          status: 'continue',
        };
        outcome.status = 'continue' as any;
        state.metadata.cycleComplete = false;
      }
    }

    // ----------------------------------------------------------------
    // 5. DESKTOP NOTIFICATION
    // ----------------------------------------------------------------
    if (userVisibleText) {
      try {
        const { showHeartbeatNotification } = await import('../../main/heartbeatNotification');
        const notifTitle = outcome.status === 'blocked' ? 'Sulla — Blocked' : 'Sulla';
        const notifMessage = statusNote || userVisibleText.slice(0, 200);
        showHeartbeatNotification(notifTitle, notifMessage);
      } catch (err) {
        console.warn('[HeartbeatNode] Failed to show desktop notification:', err);
      }
    }

    // ----------------------------------------------------------------
    // 6. PUSH ASSISTANT MESSAGE TO THREAD
    // ----------------------------------------------------------------
    if (userVisibleText) {
      if (!Array.isArray(state.messages)) {
        state.messages = [];
      }
      const normalized = userVisibleText.trim();
      const stripWrapperXml = (text: string): string => text
        .replace(AGENT_DONE_XML_REGEX, '')
        .replace(AGENT_BLOCKED_XML_REGEX, '')
        .replace(AGENT_CONTINUE_XML_REGEX, '')
        .trim();

      const alreadyStored = state.messages.some((msg: any) => {
        if (msg.role !== 'assistant') return false;
        if (typeof msg.content === 'string' && stripWrapperXml(msg.content) === normalized) return true;
        if (Array.isArray(msg.content)) {
          return msg.content.some((block: any) =>
            block?.type === 'text' && typeof block.text === 'string' && stripWrapperXml(block.text) === normalized,
          );
        }
        return false;
      });

      if (normalized && !alreadyStored) {
        state.messages.push({
          role:     'assistant',
          content:  normalized,
          metadata: {
            nodeId:    this.id,
            nodeName:  this.name,
            kind:      'heartbeat_result',
            timestamp: Date.now(),
          },
        } as ChatMessage);
        this.bumpStateVersion(state);
      }
    }

    // ----------------------------------------------------------------
    // 7. LOG
    // ----------------------------------------------------------------
    const executionTimeMs = Date.now() - startTime;
    console.log(`[HeartbeatNode] Complete — status: ${ outcome.status } in ${ executionTimeMs }ms`);

    return { state, decision: { type: 'next' } };
  }

  // ======================================================================
  // HEARTBEAT EXECUTION
  // ======================================================================

  private async executeHeartbeat(
    systemPrompt: string,
    state: BaseThreadState,
  ): Promise<string | null> {
    try {
      const policy: Required<NodeRunPolicy> = {
        messageSource:           'graph',
        persistAssistantToGraph: true,
      };

      const reply = await this.normalizedChat(state, systemPrompt, {
        temperature:   0.2,
        nodeRunPolicy: policy,
      });

      if (!reply) return null;

      // Process tool calls
      await this.processPendingToolCalls(state, reply);

      return reply.content || null;
    } catch (error) {
      if ((error as any)?.name === 'AbortError') throw error;

      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[HeartbeatNode] Execution failed:', errorMsg);

      (state.metadata as any).agent = {
        ...((state.metadata as any).agent || {}),
        status:         'blocked',
        blocker_reason: errorMsg,
        updatedAt:      Date.now(),
      };

      return null;
    }
  }

  // ======================================================================
  // OUTCOME EXTRACTION
  // ======================================================================

  private extractAgentOutcome(resultText: string): {
    status:              'done' | 'blocked' | 'continue' | 'in_progress';
    summary:             string | null;
    statusReport:        string | null;
    blockerReason:       string | null;
    unblockRequirements: string | null;
  } {
    // Check BLOCKED first
    const blockedMatch = AGENT_BLOCKED_XML_REGEX.exec(resultText);
    if (blockedMatch) {
      const blockedBlock = String(blockedMatch[1] || '').trim();
      const blockerReasonMatch = BLOCKER_REASON_XML_REGEX.exec(blockedBlock);
      const unblockRequirementsMatch = UNBLOCK_REQUIREMENTS_XML_REGEX.exec(blockedBlock);
      const blockerReason = String(blockerReasonMatch?.[1] || '').trim() || null;
      const unblockRequirements = String(unblockRequirementsMatch?.[1] || '').trim() || null;
      const fallbackSummary = blockedBlock
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) || null;

      return {
        status:       'blocked',
        summary:      blockerReason || fallbackSummary,
        statusReport: null,
        blockerReason,
        unblockRequirements,
      };
    }

    // Check DONE
    const doneMatch = AGENT_DONE_XML_REGEX.exec(resultText);
    if (doneMatch) {
      const doneBlock = String(doneMatch[1] || '').trim();
      const summary = doneBlock
        .replace(NEEDS_USER_INPUT_REGEX, '')
        .trim()
        .split('\n').map(l => l.trim()).filter(Boolean).join(' ') || null;

      return {
        status:              'done',
        summary,
        statusReport:        null,
        blockerReason:       null,
        unblockRequirements: null,
      };
    }

    // Check CONTINUE
    const continueMatch = AGENT_CONTINUE_XML_REGEX.exec(resultText);
    if (continueMatch) {
      const continueBlock = String(continueMatch[1] || '').trim();
      const statusReportMatch = STATUS_REPORT_XML_REGEX.exec(continueBlock);
      const statusReport = statusReportMatch
        ? String(statusReportMatch[1] || '').trim() || null
        : continueBlock.split('\n').map(l => l.trim()).find(Boolean) || null;

      return {
        status:              'continue',
        summary:             statusReport,
        statusReport,
        blockerReason:       null,
        unblockRequirements: null,
      };
    }

    // No wrapper — in_progress fallback
    return {
      status:              'in_progress',
      summary:             null,
      statusReport:        null,
      blockerReason:       null,
      unblockRequirements: null,
    };
  }

  private toUserVisibleAgentMessage(
    rawResultText: string,
    outcome: {
      status:              'done' | 'blocked' | 'continue' | 'in_progress';
      summary:             string | null;
      statusReport:        string | null;
      blockerReason:       string | null;
      unblockRequirements: string | null;
    },
  ): string {
    if (!rawResultText) return '';

    const proseWithoutWrappers = rawResultText
      .replace(AGENT_DONE_XML_REGEX, '')
      .replace(AGENT_BLOCKED_XML_REGEX, '')
      .replace(AGENT_CONTINUE_XML_REGEX, '')
      .trim();

    if (outcome.status === 'done') {
      return proseWithoutWrappers || outcome.summary || '';
    }

    if (outcome.status === 'continue') {
      return proseWithoutWrappers || outcome.statusReport || outcome.summary || 'Continuing.';
    }

    if (outcome.status === 'blocked') {
      const parts = [
        proseWithoutWrappers,
        outcome.blockerReason,
        outcome.unblockRequirements,
      ]
        .filter((part): part is string => Boolean(part && part.trim()))
        .map(part => part.trim());
      if (parts.length > 0) return parts.join('\n\n');
      return 'Blocked.';
    }

    return proseWithoutWrappers;
  }

  private toOneLineStatusNote(value: string): string | null {
    const normalized = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    return normalized || null;
  }

  private async updateAgentStatusNote(state: BaseThreadState, statusNote: string): Promise<void> {
    const channel = String(state.metadata.wsChannel || '').trim();
    if (!channel || !statusNote) return;

    try {
      const { getActiveAgentsRegistry } = await import('../services/ActiveAgentsRegistry');
      const registry = getActiveAgentsRegistry();
      await registry.updateStatusNoteByChannel(channel, statusNote);
    } catch (error) {
      console.warn('[HeartbeatNode] Failed to update active-agent status note:', error);
    }
  }

  // ======================================================================
  // POST-CYCLE UNSTUCK MIDDLEWARE
  // ======================================================================

  /**
   * Run two parallel subconscious agents when the heartbeat is stuck:
   * 1. Research Agent — searches for concrete solutions using tools
   * 2. Constraint Relaxation Agent — thinks creatively about alternatives
   * Results are merged into state.metadata.unstuckContext for the next cycle.
   */
  private async runUnstuckMiddleware(state: BaseThreadState): Promise<void> {
    const startTime = Date.now();
    console.log('[HeartbeatNode:Unstuck] Launching research + relaxation agents in parallel');

    try {
      const [researchResult, relaxationResult] = await Promise.allSettled([
        this.runUnstuckAgent(state, 'research'),
        this.runUnstuckAgent(state, 'relaxation'),
      ]);

      const parts: string[] = [];

      if (researchResult.status === 'fulfilled' && researchResult.value) {
        parts.push('## Research Agent Findings\n\n' + researchResult.value);
      } else if (researchResult.status === 'rejected') {
        console.error('[HeartbeatNode:Unstuck] Research agent failed:', (researchResult as PromiseRejectedResult).reason?.message || (researchResult as PromiseRejectedResult).reason);
      }

      if (relaxationResult.status === 'fulfilled' && relaxationResult.value) {
        parts.push('## Creative Alternatives\n\n' + relaxationResult.value);
      } else if (relaxationResult.status === 'rejected') {
        console.error('[HeartbeatNode:Unstuck] Relaxation agent failed:', (relaxationResult as PromiseRejectedResult).reason?.message || (relaxationResult as PromiseRejectedResult).reason);
      }

      if (parts.length > 0) {
        (state.metadata as any).unstuckContext = parts.join('\n\n---\n\n');
        console.log(`[HeartbeatNode:Unstuck] Complete in ${ Date.now() - startTime }ms | ${ parts.length } agent(s) contributed | ${ ((state.metadata as any).unstuckContext as string).length } chars`);
      } else {
        console.log(`[HeartbeatNode:Unstuck] No results from either agent in ${ Date.now() - startTime }ms`);
      }
    } catch (error) {
      console.error('[HeartbeatNode:Unstuck] Middleware failed:', error instanceof Error ? error.message : error);
    }
  }

  private async runUnstuckAgent(state: BaseThreadState, variant: 'research' | 'relaxation'): Promise<string | null> {
    const creator = variant === 'research'
      ? GraphRegistry.createUnstuckResearch
      : GraphRegistry.createUnstuckRelaxation;

    const { graph, state: subState, threadId } = await creator.call(GraphRegistry, state);
    console.log(`[HeartbeatNode:Unstuck:${ variant }] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 20 });

    // Extract response — same pattern as runMemoryRecall
    const agentMeta = (subState.metadata as any).agent || {};
    let response = agentMeta.response;
    if (!response || !String(response).trim()) {
      for (let i = subState.messages.length - 1; i >= 0; i--) {
        const msg = subState.messages[i];
        if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 50) {
          response = msg.content;
          break;
        }
      }
    }

    if (response && typeof response === 'string' && response.trim()) {
      console.log(`[HeartbeatNode:Unstuck:${ variant }] Returned ${ response.length } chars`);
      return response.trim();
    }

    console.log(`[HeartbeatNode:Unstuck:${ variant }] No useful response`);
    return null;
  }
}
