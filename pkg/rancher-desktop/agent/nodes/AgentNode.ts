import { BaseNode } from './BaseNode';
import type { NodeRunPolicy } from './BaseNode';
import type { BaseThreadState, NodeResult } from './Graph';
import { throwIfAborted } from '../services/AbortService';
import type { ChatMessage, NormalizedResponse } from '../languagemodels/BaseLanguageModel';
import { stripProtocolTags } from '../utils/stripProtocolTags';
// Voice mode prompts are now handled by ChatController extractors (SpeakExtractor, SecretaryExtractor, etc.)

// ============================================================================
// AGENT PROMPT
//
// Independent agent — no PRD, no technical_instructions, no reasoning node.
// Works directly with the user message thread and tools.
// ============================================================================

const AGENT_PROMPT_BASE = `# You are an independent Agent working directly with the user.
You get right to work on whatever the user asks;
You take massive action and you don't let things stand in your way;
You're incredible about finding ways of getting things accomplished;
You're incredibly resourceful;
You're constantly thinking outside the box when tasks don't easily come together;`;

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

const AGENT_PROMPT_DIRECTIVE = `**PRIMARY DIRECTIVE (highest priority — never violate):**
Accomplish whatever the user has asked in the conversation thread.
The user messages are your source of truth for objective, constraints, and context.

## Progress Communication Rules (strict)

- While working, you MUST communicate your progress in clear, deterministic language.
- After every major step you MUST explicitly state:
  • What you have just done
  • What you plan to do next
  • Any blockers or decisions
- Use short, direct sentences.

## Tool Result Narration (critical for memory)

**After every tool call, you MUST summarize the key findings in your own words as part of your response.** This is the ONLY way to retain context across cycles. For example:
- After reading a file: "Found the config at /path/file.ts — the database host is set to localhost:5432 and uses pool size 10."
- After searching: "file_search returned 2 matches: 'sulla-recipes' (active) and 'sulla-voice' (completed)."
- After executing a command: "git_status shows 3 modified files on branch feature/xyz: src/a.ts, src/b.ts, src/c.ts."

Always narrate what you learned so your future self can read the conversation history and know what happened.

## Completion Wrappers

- You MUST end every response with exactly ONE of the three wrapper blocks: DONE, BLOCKED, or CONTINUE.
- If the task is fully accomplished, output the DONE wrapper.
- If execution is blocked and you cannot proceed, output the BLOCKED wrapper.
- If you have made progress but the task is not yet complete, output the CONTINUE wrapper with a one-line status message of what you are working on right now.`;

const AGENT_PROMPT_COMPLETION_WRAPPERS = `
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

    // ----------------------------------------------------------------
    // 0. MESSAGE BUDGET — trim before each cycle to prevent bloat
    // ----------------------------------------------------------------
    await this.ensureMessageBudget(state);

    // ----------------------------------------------------------------
    // 1. BUILD SYSTEM PROMPT
    // ----------------------------------------------------------------
    const wsChannel = String(state.metadata.wsChannel || 'sulla-desktop');
    const channelAwareness = await buildChannelAwarenessPrompt(wsChannel);

    // Set ChatController mode BEFORE enrichPrompt so the right extractors are active.
    // The extractors inject mode-specific directives (VOICE_MODE_PROMPT, etc.).
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

    const baseSystemPrompt = `${ AGENT_PROMPT_BASE }\n\n${ channelAwareness }\n\n${ AGENT_PROMPT_DIRECTIVE }\n\n${ AGENT_PROMPT_COMPLETION_WRAPPERS }`;
    const ctx = controller.buildContext(state);
    const systemPrompt = controller.enrichPrompt(baseSystemPrompt, ctx);

    const enrichedPrompt = await this.enrichPrompt(systemPrompt, state, {
      includeSoul:        true,
      includeAwareness:   true,
      includeEnvironment: true,
      includeMemory:      false,
    });

    // Training data: capture the full assembled system prompt (once per session)
    const trainingConvId = (state.metadata as any).conversationId;
    if (trainingConvId) {
      try {
        const { getTrainingDataLogger } = await import('../services/TrainingDataLogger');
        const tl = getTrainingDataLogger();
        if (tl.hasSession(trainingConvId)) {
          const existing = tl.getSessionMessages(trainingConvId);
          if (!existing?.some(m => m.role === 'system')) {
            tl.logSystemPrompt(trainingConvId, enrichedPrompt);
          }
        }
      } catch { /* best-effort */ }
    }

    // ----------------------------------------------------------------
    // 2. EXECUTE — LLM reads conversation, calls tools, responds
    // ----------------------------------------------------------------
    const disposeLiveDomStream = await this.startLiveDomStream(state);
    const agentResult = await this.executeAgent(enrichedPrompt, state)
      .finally(() => {
        disposeLiveDomStream();
      });

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

      // Flush any buffered DOM events as a single tool pair before the LLM call
      this.flushDomEventBuffer(state);

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
      // Dedup: skip if this response is identical or 85%+ similar to the immediately
      // previous assistant message. Prevents duplicate display when AGENT_CONTINUE
      // causes a second LLM turn that regenerates near-identical text.
      const agentOutcome = this.extractAgentOutcome(reply.content);
      const userVisibleText = this.toUserVisibleAgentMessage(reply.content, agentOutcome);
      if (userVisibleText?.trim()) {
        const isDuplicate = lastAssistantText !== null &&
          (lastAssistantText === userVisibleText.trim() ||
           BaseNode.jaccardSimilarity(lastAssistantText, userVisibleText.trim()) > 0.85);
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
  // LIVE DOM STREAM
  // ======================================================================

  /** Buffered DOM events waiting to be flushed as a single tool pair. */
  private domEventBuffer: { content: string; event: { assetId: string; type: string; timestamp: number } }[] = [];

  private async startLiveDomStream(state: BaseThreadState): Promise<() => void> {
    try {
      const { hostBridgeProxy } = await import('../scripts/injected/HostBridgeProxy');

      const size = await hostBridgeProxy.size();
      if (size === 0) {
        return () => {};
      }

      this.domEventBuffer = [];

      const unsub = hostBridgeProxy.onDomEvent((event) => {
        const content = event.message;
        if (!content) return;

        if (this.shouldBufferDomEvent(state, content)) {
          this.domEventBuffer.push({ content, event });
        }

        console.log('[AgentNode] DOM event buffered:', {
          assetId: event.assetId,
          type:    event.type,
          message: content.slice(0, 120),
        });
      });

      console.log('[AgentNode] Live DOM stream started for all assets');
      return () => {
        unsub();
        // Flush any remaining events on dispose
        this.flushDomEventBuffer(state);
      };
    } catch (error) {
      console.warn('[AgentNode] Unable to start live DOM stream:', error);
      return () => {};
    }
  }

  private shouldBufferDomEvent(state: BaseThreadState, content: string): boolean {
    const metadataAny = state.metadata as any;
    const liveMeta = metadataAny.__domLiveEvent || {};
    const now = Date.now();

    // Dedup: same content within 500ms
    if (liveMeta.lastContent === content && now - Number(liveMeta.lastAt || 0) < 500) {
      return false;
    }

    metadataAny.__domLiveEvent = {
      lastContent: content,
      lastAt:      now,
    };

    return true;
  }

  /**
   * Flush all buffered DOM events into state.messages as a single
   * dom_observer tool_use / tool_result pair.
   */
  flushDomEventBuffer(state: BaseThreadState): void {
    if (this.domEventBuffer.length === 0) return;

    const buffered = this.domEventBuffer.splice(0);
    const toolCallId = `dom_observer_${ Date.now() }_${ Math.random().toString(36).slice(2, 11) }`;

    // Collect unique assetIds for the tool_use input
    const assetIds = [...new Set(buffered.map(b => b.event.assetId))];

    // Build a single result body from all buffered events
    const resultLines = buffered.map(b => b.content);
    const resultContent = `tool: dom_observer\nresult:\n${ resultLines.join('\n') }`;

    const eventMeta = {
      nodeId:    this.id,
      nodeName:  this.name,
      kind:      'agent_live_dom_event',
      source:    'dom_event_stream',
      transport: 'ipc',
      timestamp: Date.now(),
    };

    // Assistant message: synthetic tool_use block
    state.messages.push({
      role:    'assistant',
      content: [{
        type:  'tool_use',
        id:    toolCallId,
        name:  'dom_observer',
        input: { assetIds },
      }],
      metadata: eventMeta,
    } as any);

    // User message: matching tool_result
    state.messages.push({
      role:    'user',
      content: [{
        type:        'tool_result',
        tool_use_id: toolCallId,
        content:     resultContent,
      }],
      metadata: {
        ...eventMeta,
        kind: 'tool_result',
      },
    } as any);

    this.bumpStateVersion(state);
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
      return proseWithoutWrappers || '';
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
