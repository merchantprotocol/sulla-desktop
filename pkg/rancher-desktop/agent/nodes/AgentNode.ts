import { BaseNode } from './BaseNode';
import { runSubconsciousMiddleware } from '../middleware/SubconsciousMiddleware';
import { throwIfAborted } from '../services/AbortService';
import { stripProtocolTags } from '../utils/stripProtocolTags';

import type { NodeRunPolicy } from './BaseNode';
import type { BaseThreadState, NodeResult } from './Graph';
import type { ChatMessage, NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ============================================================================
// AGENT PROMPT — Now section-based via SystemPromptBuilder.
// Inline constants removed; content migrated to prompts/sections/*.ts.
// ============================================================================

const AGENT_DONE_XML_REGEX = /<AGENT_DONE>([\s\S]*?)<\/AGENT_DONE>/i;
const AGENT_BLOCKED_XML_REGEX = /<AGENT_BLOCKED>([\s\S]*?)<\/AGENT_BLOCKED>/i;
const BLOCKER_REASON_XML_REGEX = /<BLOCKER_REASON>([\s\S]*?)<\/BLOCKER_REASON>/i;
const UNBLOCK_REQUIREMENTS_XML_REGEX = /<UNBLOCK_REQUIREMENTS>([\s\S]*?)<\/UNBLOCK_REQUIREMENTS>/i;
const AGENT_CONTINUE_XML_REGEX = /<AGENT_CONTINUE>([\s\S]*?)<\/AGENT_CONTINUE>/i;
const STATUS_REPORT_XML_REGEX = /<STATUS_REPORT>([\s\S]*?)<\/STATUS_REPORT>/i;
const NEEDS_USER_INPUT_REGEX = /Needs user input:\s*(yes|no)/i;

// ============================================================================
// AGENT NODE
// ============================================================================

/**
 * Agent Node - Independent single-thread executor
 *
 * Purpose:
 *   - Works directly with user messages in a single conversation thread
 *   - No reasoning node, no critic node, no planner dependency
 *   - Full tool access via BaseNode
 *   - Self-contained: reads user messages, executes with tools, responds
 *
 * Design:
 *   - System prompt = AGENT_PROMPT (self-contained directive)
 *   - Tools enabled — agent has full tool access
 *   - Uses the graph message thread directly (no separate lane)
 *   - Loops on itself until DONE or BLOCKED
 */
export class AgentNode extends BaseNode {
  constructor() {
    super('agent', 'Agent');
  }

  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> {
    const startTime = Date.now();

    // Emit an immediate thinking heartbeat so the UI shows activity within
    // milliseconds of the user sending a message — before enrichPrompt or
    // subconscious agents (which can take 30+ seconds with Claude Code).
    // Only on fresh turns, never inside workflows (subconscious already skips those).
    const _isFirstEntry = ((state.metadata as any).consecutiveSameNode ?? 0) === 0;
    const _inWorkflow   = (state.metadata as any).workflowNodeId || (state.metadata as any).activeWorkflow || (state.metadata as any).scopedWorkflowId;
    if (_isFirstEntry && !_inWorkflow) {
      await this.wsChatMessage(state, 'Thinking…', 'assistant', 'thinking');
    }

    // ----------------------------------------------------------------
    // 1. BUILD SYSTEM PROMPT
    // ----------------------------------------------------------------
    // Determine chat mode for voice section injection
    const controller = this.getChatController();
    const inputSource = (state.metadata as any).inputSource ?? '';
    const voiceMode = (state.metadata as any).voiceMode ?? '';
    let chatMode: 'text' | 'voice' | 'secretary' | 'intake' = 'text';
    if (inputSource === 'microphone') {
      chatMode = (voiceMode === 'secretary' || voiceMode === 'intake') ? voiceMode : 'voice';
    } else if (inputSource.startsWith('secretary-') || voiceMode === 'secretary') {
      chatMode = 'secretary';
    }
    controller.setMode(chatMode);

    // Build system prompt via section-based builder.
    // All sections (soul, workspace, tooling, voice mode, completion wrappers,
    // channel awareness, etc.) are composed by SystemPromptBuilder.
    const enrichedPrompt = await this.enrichPrompt('', state, {
      chatMode,
    });

    // Run subconscious middleware: parallel agents for summarization,
    // memory recall, and observation management.
    // Recall context is merged into the last assistant message so the
    // primary agent treats it as its own knowledge, not external info.
    // Skip during tool-call loops (consecutiveSameNode > 0) — only run
    // on fresh user turns to avoid redundant LLM calls.
    // Also skipped inside workflow runs (see the gate at the top of
    // runSubconsciousMiddleware) so routines aren't slowed by recall/
    // observation sub-agents on every orchestrator turn.
    const isToolCallLoop = ((state.metadata as any).consecutiveSameNode ?? 0) > 0;
    if (!isToolCallLoop) {
      const shouldInjectObservations = await this.shouldInjectObservationsForAgent(state);
      await runSubconsciousMiddleware(state, {
        includeObservations: shouldInjectObservations,
      });
    }

    // Merge recall context into the last assistant message (or create one)
    // so the primary agent sees it as information it already has.
    const recallContext = (state.metadata as any).recallContext;
    if (recallContext) {
      const recallBlock = `\n\n<recall_context>\n${ recallContext }\n</recall_context>`;
      let merged = false;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].role === 'assistant') {
          const msg = state.messages[i];
          if (typeof msg.content === 'string') {
            // Plain string content — append directly
            msg.content += recallBlock;
          } else if (Array.isArray(msg.content)) {
            // Content blocks array (e.g. [{type:'text', text:'...'}, ...])
            // Append a new text block with the recall context
            msg.content.push({ type: 'text', text: recallBlock });
          } else {
            // Unknown format — wrap as string
            msg.content = (msg.content ? JSON.stringify(msg.content) : '') + recallBlock;
          }
          merged = true;
          break;
        }
      }
      if (!merged) {
        // First turn — no assistant message yet, insert one before the last user message
        const insertIdx = Math.max(0, state.messages.length - 1);
        state.messages.splice(insertIdx, 0, {
          role:     'assistant',
          content:  recallBlock.trim(),
          metadata: { source: 'recall', _synthetic: true },
        });
      }
    }

    // ----------------------------------------------------------------
    // 2. EXECUTE — LLM reads conversation, calls tools, responds
    // ----------------------------------------------------------------
    const agentResult = await this.executeAgent(enrichedPrompt, state);

    // If aborted while the LLM was responding, stop immediately —
    // don't process the result or let the graph loop back.
    throwIfAborted(state, 'Agent execution aborted after LLM response');

    const agentResultText = typeof agentResult === 'string' ? agentResult : '';
    const agentOutcome = this.extractAgentOutcome(agentResultText);
    const userVisibleResultText = this.toUserVisibleAgentMessage(agentResultText, agentOutcome);

    // Store outcome on metadata
    const statusNote = this.toOneLineStatusNote(
      agentOutcome.statusReport ||
      agentOutcome.blockerReason ||
      agentOutcome.summary ||
      '',
    );

    (state.metadata as any).agent = {
      ...((state.metadata as any).agent || {}),
      status:               agentOutcome.status,
      status_report:        agentOutcome.statusReport,
      blocker_reason:       agentOutcome.blockerReason,
      unblock_requirements: agentOutcome.unblockRequirements,
      status_note:          statusNote,
      response:             agentOutcome.status === 'done' ? stripProtocolTags(agentResultText) : null,
      updatedAt:            Date.now(),
    };

    // When the agent reports done or blocked, mark the cycle as complete
    // so the graph loop doesn't restart when the response is processed.
    if (agentOutcome.status === 'done') {
      state.metadata.cycleComplete = true;
    }

    // When the agent is blocked, decide how to pause based on context:
    // - Primary agent (direct user conversation): wait for user input
    // - Sub-agent (heartbeat/workflow): bubble blocker to orchestrator
    if (agentOutcome.status === 'blocked') {
      state.metadata.cycleComplete = true;
      if (state.metadata.isSubAgent) {
        // Sub-agent: don't wait for user — the orchestrator will read
        // blocker_reason / unblock_requirements from agent metadata
        console.log(`[AgentNode] Sub-agent blocked — deferring to orchestrator. Reason: ${ agentOutcome.blockerReason }`);
      } else {
        state.metadata.waitingForUser = true;
      }
    }

    if (statusNote) {
      await this.updateAgentStatusNote(state, statusNote);
    }

    // Push assistant response to conversation thread
    // appendResponse already stores native content arrays (including text+tool_use),
    // so only push here if the text isn't already present in the last message.
    if (userVisibleResultText) {
      if (!Array.isArray(state.messages)) {
        state.messages = [];
      }
      const normalizedUserVisibleResult = userVisibleResultText.trim();
      const stripWrapperXml = (text: string): string => text
        .replace(AGENT_DONE_XML_REGEX, '')
        .replace(AGENT_BLOCKED_XML_REGEX, '')
        .replace(AGENT_CONTINUE_XML_REGEX, '')
        .trim();

      const alreadyStored = state.messages.some((msg: any) => {
        if (msg.role !== 'assistant') return false;
        // Match string content (strip wrapper XML so raw responses match their stripped counterparts)
        if (typeof msg.content === 'string' && stripWrapperXml(msg.content) === normalizedUserVisibleResult) return true;
        // Match text inside native content arrays (e.g. [{ type: 'text', text: '...' }, { type: 'tool_use', ... }])
        if (Array.isArray(msg.content)) {
          return msg.content.some((block: any) =>
            block?.type === 'text' && typeof block.text === 'string' && stripWrapperXml(block.text) === normalizedUserVisibleResult,
          );
        }
        return false;
      });

      if (normalizedUserVisibleResult && !alreadyStored) {
        state.messages.push({
          role:     'assistant',
          content:  normalizedUserVisibleResult,
          metadata: {
            nodeId:    this.id,
            nodeName:  this.name,
            kind:      'agent_result',
            timestamp: Date.now(),
          },
        } as ChatMessage);
        this.bumpStateVersion(state);
      }
      // Text already dispatched to UI in executeAgent() before tool execution
    }

    // ----------------------------------------------------------------
    // 3. LOG
    // ----------------------------------------------------------------
    const executionTimeMs = Date.now() - startTime;
    console.log(`[AgentNode] Complete — status: ${ agentOutcome.status } in ${ executionTimeMs }ms`);

    return { state, decision: { type: 'next' } };
  }

  // ======================================================================
  // AGENT EXECUTION
  // ======================================================================

  private async executeAgent(
    systemPrompt: string,
    state: BaseThreadState,
  ): Promise<string | null> {
    try {
      const policy: Required<NodeRunPolicy> = {
        messageSource:           'graph',
        persistAssistantToGraph: true,
      };

      // Find the last assistant message BEFORE the LLM call (for dedup).
      // Content may be a string OR a native content array (when tool_use blocks are present).
      let lastAssistantText: string | null = null;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (msg.role === 'assistant') {
          if (typeof msg.content === 'string') {
            lastAssistantText = stripProtocolTags(msg.content).trim();
          } else if (Array.isArray(msg.content)) {
            // Extract text from native content blocks: [{ type: 'text', text: '...' }, { type: 'tool_use', ... }]
            const textParts = (msg.content as any[])
              .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text);
            if (textParts.length > 0) {
              lastAssistantText = stripProtocolTags(textParts.join('\n')).trim();
            }
          }
          break;
        }
      }

      const reply = await this.normalizedChat(state, systemPrompt, {
        temperature:   0.2,
        nodeRunPolicy: policy,
      });

      if (!reply) return null;

      // Emit text to the UI BEFORE tool execution so text appears before tool cards.
      // Dedup: skip only if this response is 100% identical to the immediately
      // previous assistant message. Prevents duplicate display when AGENT_CONTINUE
      // causes a second LLM turn that regenerates identical text.
      const agentOutcome = this.extractAgentOutcome(reply.content);
      const userVisibleText = this.toUserVisibleAgentMessage(reply.content, agentOutcome);
      if (userVisibleText?.trim()) {
        const isDuplicate = lastAssistantText !== null &&
          lastAssistantText === userVisibleText.trim();
        if (!isDuplicate) {
          await this.wsChatMessage(state, userVisibleText, 'assistant');
        }
      }

      // Now execute tool calls — tool cards appear after text in the UI
      await this.processPendingToolCalls(state, reply);

      return reply.content || null;
    } catch (error) {
      // Re-throw abort errors so they propagate to the graph loop
      if ((error as any)?.name === 'AbortError') throw error;

      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[AgentNode] Execution failed:', errorMsg);

      // Surface the error to the user instead of silently dying
      const userMessage = `⚠️ I encountered an error and couldn't complete the request: ${ errorMsg }. Please try again or switch to a different model.`;

      // Push error as assistant message so user sees it in the chat
      state.messages.push({
        role:     'assistant',
        content:  userMessage,
        metadata: {
          nodeId:    this.id,
          nodeName:  this.name,
          kind:      'agent_error',
          timestamp: Date.now(),
        },
      } as ChatMessage);

      // Send error via WebSocket so user sees it immediately
      await this.wsChatMessage(state, userMessage, 'assistant');

      // Mark as blocked so graph takes the clean exit path (not the ambiguous in_progress path)
      (state.metadata as any).agent = {
        ...((state.metadata as any).agent || {}),
        status:         'blocked',
        blocker_reason: errorMsg,
        updatedAt:      Date.now(),
      };

      return userMessage;
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
      // Strip the "Needs user input: yes/no" line to get the summary
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

    // No wrapper found — treat as in_progress (legacy fallback)
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
    if (!rawResultText) {
      return '';
    }

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
      // Preserve any prose the agent wrote before the AGENT_BLOCKED wrapper —
      // this is the agent's explanation or question to the user, critical for
      // training data and user context.
      const parts = [
        proseWithoutWrappers,
        outcome.blockerReason,
        outcome.unblockRequirements,
      ]
        .filter((part): part is string => Boolean(part && part.trim()))
        .map(part => part.trim());
      if (parts.length > 0) {
        return parts.join('\n\n');
      }
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
      console.warn('[AgentNode] Failed to update active-agent status note:', error);
    }
  }
}
