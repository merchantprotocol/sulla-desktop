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
    // Subconscious tools are independent read-only searches — run a batch of
    // tool calls concurrently so batch latency is max(tool), not sum(tools).
    this.parallelToolCalls = true;
  }

  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> {
    // Build system prompt: caller's prompt + completion wrappers
    const callerPrompt = (state.metadata as any).systemPrompt || '';
    const systemPrompt = callerPrompt + COMPLETION_WRAPPER_PROMPT;

    // LLM call options from metadata
    const meta = state.metadata as any;
    const allowedToolNames: string[] | undefined = meta.allowedToolNames;

    // An explicitly empty allowlist (summarizer / digester are pure-text) means
    // NO tools — disable them outright rather than letting the empty array fall
    // through to dynamic discovery, which would hand these background agents the
    // slim native set (including the interactive tools they can never resolve on
    // the subconscious channel).
    const disableTools = Array.isArray(allowedToolNames) && allowedToolNames.length === 0;

    // Call LLM with tools
    const reply = await this.normalizedChat(state, systemPrompt, {
      temperature:      meta.temperature ?? 0,
      allowedToolNames,
      disableTools,
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
    // Every tool actually granted to a subconscious agent (GraphRegistry.ts
    // *_TOOLS lists + conversationReaderPolicy/conversationWriterPolicy)
    // renders as thinking, not a card — the subconscious is never supposed to
    // surface visible tool cards in the parent chat. Keep this set in sync
    // with those grants; a name missing here silently leaks a tool card.
    const THINKING_TOOLS = new Set([
      'file_search', 'read_file',
      // Observation Writer / Observation Recall
      'add_observational_memory', 'remove_observational_memory',
      'search_observations', 'list_observations',
      // Identity Observer (writer) / Identity Observation Recall — all 6 domains
      'add_identity_observation', 'remove_identity_observation',
      'search_identity_observations', 'list_identity_observations',
      // Conversation Reader / Conversation Writer
      'search_conversation_keywords', 'search_conversation_logs',
      'upsert_conversation_keywords',
      'vault_list', 'vault_is_enabled', 'search_conversations',
      'recall_index_lookup', 'recall_index_store',
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

    // Mark cycle complete when done — and close any open thinking bubble
    // on the parent channel so the UI stops showing "Synthesizing" once
    // this sub-agent is finished narrating. Without this, the bubble stays
    // in the Synthesizing state until another sub-agent happens to close it.
    if (outcome.status === 'done') {
      state.metadata.cycleComplete = true;
      await this.emitThinkingComplete(state);
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

    const agentLabel = (state.metadata as any).agentLabel || 'subconscious';
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
   * Fully silent sub-agents suppress ALL parent-channel thinking emissions.
   * Post-turn observation WRITERS (the general observation writer + the
   * per-domain identity observers) are fire-and-forget: they run AFTER the
   * primary loop already emitted graph_execution_complete, so any thinking
   * bubble they push lands on a closed run and spins forever until the user
   * hits Stop. They set `subconsciousSilent` (see GraphRegistry
   * buildSubconsciousState) so they narrate nothing — they just run and write
   * to the DB. Recall agents run BEFORE the reply and stay non-silent so their
   * progress is still visible.
   *
   * The legacy `agentLabel === 'observation'` check is kept as a
   * belt-and-suspenders fallback for any caller that hasn't set the flag.
   */
  private isSilentAgent(state: BaseThreadState): boolean {
    const meta = state.metadata as any;
    return meta.subconsciousSilent === true || meta.agentLabel === 'observation';
  }

  private async emitThinking(state: BaseThreadState, content: string): Promise<void> {
    if (this.isSilentAgent(state)) return;
    const parentState = this.buildParentState(state);
    if (!parentState) return;

    // Emit on the `subconscious_message` wire type so the frontend dispatcher
    // routes this through a handler that renders the thinking bubble but
    // does NOT touch graphRunning. Run-state is owned exclusively by the
    // primary orchestration loop's `assistant_message` emissions.
    await this.wsChatMessage(parentState, content, 'assistant', 'thinking', { isSubconscious: true }, 'subconscious_message');
  }

  /**
   * Signal the frontend to close the current thinking bubble.
   * The next thinking text will start a fresh bubble.
   */
  private async emitThinkingComplete(state: BaseThreadState): Promise<void> {
    if (this.isSilentAgent(state)) return;
    if ((state.metadata as any).deferParentThinkingComplete === true) return;
    const parentState = this.buildParentState(state);
    if (!parentState) return;

    // Same `subconscious_message` wire type for the close-bubble sentinel.
    await this.wsChatMessage(parentState, '...', 'assistant', 'thinking_complete', { isSubconscious: true }, 'subconscious_message');
  }
}
