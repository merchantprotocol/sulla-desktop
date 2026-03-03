import { BaseNode } from './BaseNode';
import type { NodeRunPolicy } from './BaseNode';
import type { BaseThreadState, NodeResult } from './Graph';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';

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
    return `${block}\n\nYou run on the **${wsChannel}** WebSocket channel. Your \`sender_id\` and \`sender_channel\` are both \`${wsChannel}\`.`;
  } catch {
    return `## Inter-Agent Communication\n\nYou run on the **${wsChannel}** WebSocket channel. Agent registry unavailable.`;
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
- After searching: "search_projects returned 2 matches: 'sulla-recipes' (active) and 'sulla-voice' (completed)."
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
<KEY_RESULT>[one-line summary of accomplishment]</KEY_RESULT>
</AGENT_DONE>

BLOCKED wrapper (use when goal cannot be completed — missing dependency/credential/input):
<AGENT_BLOCKED>
<BLOCKER_REASON>[one-line concrete blocker]</BLOCKER_REASON>
<UNBLOCK_REQUIREMENTS>[exact dependency/credential/input needed to proceed]</UNBLOCK_REQUIREMENTS>
</AGENT_BLOCKED>

CONTINUE wrapper (use when you made progress but the task is NOT yet complete):
<AGENT_CONTINUE>
<STATUS_REPORT>[one-line: what you are actively working on now]</STATUS_REPORT>
OR
<STATUS_MESSAGE>[one-line: what you are actively working on now]</STATUS_MESSAGE>
</AGENT_CONTINUE>

You MUST end every response with exactly ONE of these three wrappers.
`;

const AGENT_DONE_XML_REGEX = /<AGENT_DONE>([\s\S]*?)<\/AGENT_DONE>/i;
const KEY_RESULT_XML_REGEX = /<KEY_RESULT>([\s\S]*?)<\/KEY_RESULT>/i;
const AGENT_BLOCKED_XML_REGEX = /<AGENT_BLOCKED>([\s\S]*?)<\/AGENT_BLOCKED>/i;
const BLOCKER_REASON_XML_REGEX = /<BLOCKER_REASON>([\s\S]*?)<\/BLOCKER_REASON>/i;
const UNBLOCK_REQUIREMENTS_XML_REGEX = /<UNBLOCK_REQUIREMENTS>([\s\S]*?)<\/UNBLOCK_REQUIREMENTS>/i;
const AGENT_CONTINUE_XML_REGEX = /<AGENT_CONTINUE>([\s\S]*?)<\/AGENT_CONTINUE>/i;
const STATUS_REPORT_XML_REGEX = /<STATUS_REPORT>([\s\S]*?)<\/STATUS_REPORT>/i;
const STATUS_MESSAGE_XML_REGEX = /<STATUS_MESSAGE>([\s\S]*?)<\/STATUS_MESSAGE>/i;

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
    const wsChannel = String(state.metadata.wsChannel || 'chat-controller');
    const channelAwareness = await buildChannelAwarenessPrompt(wsChannel);
    const systemPrompt = `${AGENT_PROMPT_BASE}\n\n${channelAwareness}\n\n${AGENT_PROMPT_DIRECTIVE}\n\n${AGENT_PROMPT_COMPLETION_WRAPPERS}`;

    const enrichedPrompt = await this.enrichPrompt(systemPrompt, state, {
      includeSoul: true,
      includeAwareness: true,
      includeEnvironment: true,
      includeMemory: false,
    });

    // ----------------------------------------------------------------
    // 2. EXECUTE — LLM reads conversation, calls tools, responds
    // ----------------------------------------------------------------
    const disposeLiveDomStream = await this.startLiveDomStream(state);
    const agentResult = await this.executeAgent(enrichedPrompt, state)
      .finally(() => {
        disposeLiveDomStream();
      });

    const agentResultText = typeof agentResult === 'string' ? agentResult : '';
    const agentOutcome = this.extractAgentOutcome(agentResultText);
    const userVisibleResultText = this.toUserVisibleAgentMessage(agentResultText, agentOutcome);

    // Store outcome on metadata
    const statusNote = this.toOneLineStatusNote(
      agentOutcome.statusReport
      || agentOutcome.blockerReason
      || agentOutcome.summary
      || '',
    );

    (state.metadata as any).agent = {
      ...((state.metadata as any).agent || {}),
      status: agentOutcome.status,
      status_report: agentOutcome.statusReport,
      blocker_reason: agentOutcome.blockerReason,
      unblock_requirements: agentOutcome.unblockRequirements,
      status_note: statusNote,
      response: agentOutcome.status === 'done' ? agentResultText : null,
      updatedAt: Date.now(),
    };

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
      const alreadyStored = state.messages.some((msg: any) => {
        if (msg.role !== 'assistant') return false;
        // Match string content
        if (typeof msg.content === 'string' && msg.content.trim() === normalizedUserVisibleResult) return true;
        // Match text inside native content arrays (e.g. [{ type: 'text', text: '...' }, { type: 'tool_use', ... }])
        if (Array.isArray(msg.content)) {
          return msg.content.some((block: any) =>
            block?.type === 'text' && typeof block.text === 'string' && block.text.trim() === normalizedUserVisibleResult,
          );
        }
        return false;
      });

      if (normalizedUserVisibleResult && !alreadyStored) {
        state.messages.push({
          role: 'assistant',
          content: normalizedUserVisibleResult,
          metadata: {
            nodeId: this.id,
            nodeName: this.name,
            kind: 'agent_result',
            timestamp: Date.now(),
          },
        } as ChatMessage);
        this.bumpStateVersion(state);
      }
      await this.wsChatMessage(state, userVisibleResultText, 'assistant');
    }

    // ----------------------------------------------------------------
    // 3. LOG
    // ----------------------------------------------------------------
    const executionTimeMs = Date.now() - startTime;
    console.log(`[AgentNode] Complete — status: ${agentOutcome.status} in ${executionTimeMs}ms`);

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
        messageSource: 'graph',
        persistAssistantToGraph: true,
      };

      const chatResult = await this.chat(state, systemPrompt, {
        temperature: 0.2,
        nodeRunPolicy: policy,
      });

      return chatResult || null;
    } catch (error) {
      console.error('[AgentNode] Execution failed:', error);
      return null;
    }
  }

  // ======================================================================
  // LIVE DOM STREAM
  // ======================================================================

  private async startLiveDomStream(state: BaseThreadState): Promise<() => void> {
    try {
      const { hostBridgeRegistry } = await import('../scripts/injected/HostBridgeRegistry');

      if (hostBridgeRegistry.size() === 0) {
        return () => {};
      }

      const unsub = hostBridgeRegistry.onDomEvent((event) => {
        const content = event.message;
        if (!content) return;

        if (this.shouldAppendLiveDomEvent(state, content)) {
          this.appendLiveDomMessage(state, content, event);
        }

        console.log('[AgentNode] DOM event received:', {
          assetId: event.assetId,
          type: event.type,
          message: content.slice(0, 120),
        });
      });

      console.log('[AgentNode] Live DOM stream started for all assets');
      return unsub;
    } catch (error) {
      console.warn('[AgentNode] Unable to start live DOM stream:', error);
      return () => {};
    }
  }

  private shouldAppendLiveDomEvent(state: BaseThreadState, content: string): boolean {
    const metadataAny = state.metadata as any;
    const liveMeta = metadataAny.__domLiveEvent || {};
    const now = Date.now();

    // Dedup: same content within 500ms
    if (liveMeta.lastContent === content && now - Number(liveMeta.lastAt || 0) < 500) {
      return false;
    }

    metadataAny.__domLiveEvent = {
      lastContent: content,
      lastAt: now,
    };

    return true;
  }

  private appendLiveDomMessage(
    state: BaseThreadState,
    content: string,
    event: { assetId: string; type: string; timestamp: number },
  ): void {
    const message: ChatMessage = {
      role: 'assistant',
      content,
      metadata: {
        nodeId: this.id,
        nodeName: this.name,
        kind: 'agent_live_dom_event',
        source: 'dom_event_stream',
        transport: 'ipc',
        eventType: event.type,
        assetId: event.assetId,
        timestamp: event.timestamp,
      },
    };

    state.messages.push(message);
    this.bumpStateVersion(state);
  }

  // ======================================================================
  // OUTCOME EXTRACTION
  // ======================================================================

  private extractAgentOutcome(resultText: string): {
    status: 'done' | 'blocked' | 'continue' | 'in_progress';
    summary: string | null;
    statusReport: string | null;
    blockerReason: string | null;
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
        status: 'blocked',
        summary: blockerReason || fallbackSummary,
        statusReport: null,
        blockerReason,
        unblockRequirements,
      };
    }

    // Check DONE
    const doneMatch = AGENT_DONE_XML_REGEX.exec(resultText);
    if (doneMatch) {
      const doneBlock = String(doneMatch[1] || '').trim();
      const keyResultMatch = KEY_RESULT_XML_REGEX.exec(doneBlock);
      const summary = keyResultMatch
        ? String(keyResultMatch[1] || '').trim() || null
        : doneBlock.split('\n').map(l => l.trim()).find(Boolean) || null;

      return {
        status: 'done',
        summary,
        statusReport: null,
        blockerReason: null,
        unblockRequirements: null,
      };
    }

    // Check CONTINUE
    const continueMatch = AGENT_CONTINUE_XML_REGEX.exec(resultText);
    if (continueMatch) {
      const continueBlock = String(continueMatch[1] || '').trim();
      const statusReportMatch = STATUS_REPORT_XML_REGEX.exec(continueBlock);
      const statusMessageMatch = STATUS_MESSAGE_XML_REGEX.exec(continueBlock);
      const statusReport = statusReportMatch
        ? String(statusReportMatch[1] || '').trim() || null
        : statusMessageMatch
          ? String(statusMessageMatch[1] || '').trim() || null
        : continueBlock.split('\n').map(l => l.trim()).find(Boolean) || null;

      return {
        status: 'continue',
        summary: statusReport,
        statusReport,
        blockerReason: null,
        unblockRequirements: null,
      };
    }

    // No wrapper found — treat as in_progress (legacy fallback)
    return {
      status: 'in_progress',
      summary: null,
      statusReport: null,
      blockerReason: null,
      unblockRequirements: null,
    };
  }

  private toUserVisibleAgentMessage(
    rawResultText: string,
    outcome: {
      status: 'done' | 'blocked' | 'continue' | 'in_progress';
      summary: string | null;
      statusReport: string | null;
      blockerReason: string | null;
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
      const parts = [outcome.blockerReason, outcome.unblockRequirements]
        .filter((part): part is string => Boolean(part && part.trim()))
        .map(part => part.trim());
      if (parts.length > 0) {
        return parts.join('\n');
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
