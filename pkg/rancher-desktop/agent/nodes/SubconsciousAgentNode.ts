import { BaseNode } from './BaseNode';
import { type BaseThreadState, type NodeResult, nextMessageId } from './Graph';
import { throwIfAborted } from '../services/AbortService';
import { stripProtocolTags } from '../utils/stripProtocolTags';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Callback invoked after each LLM response. Use this to parse custom XML
 * contracts from the response and apply mutations to state.
 *
 * @param response - The raw LLM response text
 * @param state    - The live state object (mutate directly)
 */
export type SubconsciousResponseHandler = (response: string, state: BaseThreadState) => void;

// ============================================================================
// COMPLETION WRAPPER PROMPT
// ============================================================================

const COMPLETION_WRAPPER_PROMPT = `

## How to Respond

Format all output as **markdown**. Your output is displayed as the agent's
thinking process in a markdown-rendered panel.

Narrate what you're doing as you work. Use short paragraphs, bullet points,
and \`inline code\` for tool names and file paths. Keep each thought concise.

When you're done, end your response with:
<AGENT_DONE>
[your final deliverable]
</AGENT_DONE>

If you need to keep working after making tool calls, just say what you're doing
next — no special wrapper needed. If there is nothing relevant to contribute,
finish immediately with an empty AGENT_DONE.`;

// ============================================================================
// XML PARSING
// ============================================================================

const AGENT_DONE_XML_REGEX = /<AGENT_DONE>([\s\S]*?)<\/AGENT_DONE>/i;
const AGENT_CONTINUE_XML_REGEX = /<AGENT_CONTINUE>([\s\S]*?)<\/AGENT_CONTINUE>/i;
const STATUS_REPORT_XML_REGEX = /<STATUS_REPORT>([\s\S]*?)<\/STATUS_REPORT>/i;

interface SubconsciousOutcome {
  status:       'done' | 'continue' | 'in_progress';
  summary:      string | null;
  statusReport: string | null;
}

function extractOutcome(text: string, hadToolCalls: boolean): SubconsciousOutcome {
  const doneMatch = AGENT_DONE_XML_REGEX.exec(text);
  if (doneMatch) {
    return {
      status:       'done',
      summary:      doneMatch[1].trim(),
      statusReport: null,
    };
  }

  const continueMatch = AGENT_CONTINUE_XML_REGEX.exec(text);
  if (continueMatch) {
    const statusMatch = STATUS_REPORT_XML_REGEX.exec(continueMatch[1]);
    return {
      status:       'continue',
      summary:      null,
      statusReport: statusMatch ? statusMatch[1].trim() : continueMatch[1].trim(),
    };
  }

  // No wrapper — infer from tool calls
  return {
    status:       hadToolCalls ? 'in_progress' : 'done',
    summary:      hadToolCalls ? null : text.trim() || null,
    statusReport: null,
  };
}

// ============================================================================
// SUBCONSCIOUS AGENT NODE
// ============================================================================

/**
 * SubconsciousAgentNode — minimal multi-turn tool-calling node.
 *
 * Extends BaseNode to reuse normalizedChat() and processPendingToolCalls(),
 * but strips away all agent infrastructure: no enrichment, no soul files,
 * no observations, no WebSocket communication, no DOM streaming, no
 * ChatController modes, no training data logging.
 *
 * The caller provides the system prompt and allowed tools via state.metadata.
 * The node appends a minimal completion wrapper instruction and loops until
 * the LLM signals AGENT_DONE or runs out of tool calls.
 *
 * Optionally, the caller can provide a `responseHandler` callback on
 * state.metadata that receives each LLM response and the state. Use this
 * to define custom XML contracts — the handler parses the XML and mutates
 * the state directly.
 *
 * When `parentWsChannel` is set on state.metadata, all activity (LLM
 * responses, tool calls) is pushed as `<thinking>` messages on the parent
 * agent's WebSocket channel — making the subconscious visible in the UI.
 */
export class SubconsciousAgentNode extends BaseNode {
  constructor() {
    super('subconscious', 'Subconscious');
  }

  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> {
    // Build system prompt: caller's prompt + completion wrappers
    const callerPrompt = (state.metadata as any).systemPrompt || '';
    const systemPrompt = callerPrompt + COMPLETION_WRAPPER_PROMPT;

    // LLM call options from metadata
    const meta = state.metadata as any;
    const allowedToolNames: string[] | undefined = meta.allowedToolNames;
    const agentLabel = meta.agentLabel || 'subconscious';

    // Call LLM with tools
    const reply = await this.normalizedChat(state, systemPrompt, {
      temperature:      meta.temperature ?? 0,
      allowedToolNames,
      format:           meta.format,
      maxTokens:        meta.maxTokens,
    });

    throwIfAborted(state, 'Subconscious execution aborted');

    if (!reply) {
      // Empty response — treat as done
      (state.metadata as any).agent = {
        ...((state.metadata as any).agent || {}),
        status:    'done',
        response:  null,
        updatedAt: Date.now(),
      };
      state.metadata.cycleComplete = true;
      await this.emitThinking(state, '_no response from LLM_');
      return { state, decision: { type: 'next' } };
    }

    // Push LLM response as thinking (strip protocol tags, keep narration)
    if (reply.content?.trim()) {
      const cleaned = stripProtocolTags(reply.content);
      if (cleaned) {
        await this.emitThinking(state, cleaned);
      }
    }

    // Close thinking bubble before tool cards so thinking appears between them.
    // file_search, read_file, and memory tools render as thinking (not cards), so skip those.
    const THINKING_TOOLS = new Set([
      'file_search', 'read_file',
      'add_observational_memory', 'remove_observational_memory',
      'vault_list', 'search_conversations',
      'search_history', 'github_read_file', 'get_human_presence', 'list_tabs',
      'check_agent_jobs', 'github_get_issue', 'github_get_issues',
      'github_list_branches', 'git_log',
    ]);
    const hasCardToolCalls = (reply.metadata.tool_calls || []).some((tc: any) => !THINKING_TOOLS.has(tc.name));
    if (hasCardToolCalls) {
      await this.emitThinkingComplete(state);
    }

    // Execute pending tool calls
    await this.processPendingToolCalls(state, reply);

    throwIfAborted(state, 'Subconscious execution aborted after tool calls');

    // Invoke the response handler if provided — lets callers parse custom
    // XML contracts and mutate state based on the LLM's structured output.
    const responseHandler = meta.responseHandler as SubconsciousResponseHandler | undefined;
    if (responseHandler && reply.content) {
      try {
        responseHandler(reply.content, state);
      } catch (error) {
        console.error('[SubconsciousAgentNode] responseHandler threw:', error instanceof Error ? error.message : error);
      }
    }

    // Parse outcome
    const hadToolCalls = !!(reply.metadata.tool_calls?.length);
    const outcome = extractOutcome(reply.content || '', hadToolCalls);

    // Accumulate all structured output (AGENT_DONE + AGENT_CONTINUE content)
    // across iterations. Everything outside these tags goes to thinking;
    // everything inside is the deliverable.
    const existingResponse = (state.metadata as any).agent?.response || '';
    const rawContent = reply.content || '';

    const doneInner = AGENT_DONE_XML_REGEX.exec(rawContent)?.[1]?.trim() || '';
    const continueInner = AGENT_CONTINUE_XML_REGEX.exec(rawContent)?.[1]?.trim() || '';
    const newContent = doneInner || continueInner;

    const accumulatedResponse = newContent
      ? (existingResponse ? existingResponse + '\n\n' + newContent : newContent)
      : existingResponse;

    (state.metadata as any).agent = {
      ...((state.metadata as any).agent || {}),
      status:        outcome.status,
      status_report: outcome.statusReport,
      response:      accumulatedResponse || null,
      updatedAt:     Date.now(),
    };

    // Mark cycle complete when done
    if (outcome.status === 'done') {
      state.metadata.cycleComplete = true;
    }

    // Append assistant message to thread (if not already stored by normalizedChat)
    const replyText = reply.content?.trim();
    if (replyText) {
      const alreadyStored = state.messages.some(
        (msg: any) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim() === replyText,
      );
      if (!alreadyStored) {
        state.messages.push({
          id:       nextMessageId(),
          role:     'assistant',
          content:  replyText,
          metadata: {
            nodeId:    this.id,
            nodeName:  this.name,
            kind:      'subconscious_result',
            timestamp: Date.now(),
          },
        } as any);
      }
    }

    console.log(`[SubconsciousAgentNode:${ agentLabel }] Complete — status: ${ outcome.status }`);

    return { state, decision: { type: 'next' } };
  }

  /**
   * Push a thinking message to the parent agent's WebSocket channel.
   * Everything the subconscious does is the main agent's thinking process.
   */
  /**
   * Build a lightweight state proxy that targets the parent's WebSocket
   * channel/thread without mutating the real state.metadata.  This avoids
   * a race where graph.execute() reads wsChannel while it's temporarily
   * swapped, sending the completion signal to the wrong channel.
   */
  private buildParentState(state: BaseThreadState): BaseThreadState | null {
    const parentChannel = (state.metadata as any).parentWsChannel;
    if (!parentChannel) return null;

    const parentThreadId = (state.metadata as any).parentConversationId || state.metadata.threadId;

    return {
      ...state,
      metadata: { ...state.metadata, wsChannel: parentChannel, threadId: parentThreadId },
    } as BaseThreadState;
  }

  /**
   * Some subconscious agents (e.g. observation) are pure side-effects — they
   * modify storage via tool calls but have no narration worth showing the
   * user. Returning true here suppresses `emitThinking` / `emitThinkingComplete`
   * for those agents so the main chat doesn't fill with "Reading files..."
   * "Memory updated..." bubbles after every reply.
   */
  private isSilentAgent(state: BaseThreadState): boolean {
    const label = (state.metadata as any).agentLabel as string | undefined;
    // Observation is explicitly fire-and-forget; its thoughts are not for the user.
    return label === 'observation';
  }

  private async emitThinking(state: BaseThreadState, content: string): Promise<void> {
    if (this.isSilentAgent(state)) return;
    const parentState = this.buildParentState(state);
    if (!parentState) return;

    await this.wsChatMessage(parentState, content, 'assistant', 'thinking');
  }

  /**
   * Signal the frontend to close the current thinking bubble.
   * The next thinking text will start a fresh bubble.
   */
  private async emitThinkingComplete(state: BaseThreadState): Promise<void> {
    if (this.isSilentAgent(state)) return;
    const parentState = this.buildParentState(state);
    if (!parentState) return;

    await this.wsChatMessage(parentState, '...', 'assistant', 'thinking_complete');
  }
}
