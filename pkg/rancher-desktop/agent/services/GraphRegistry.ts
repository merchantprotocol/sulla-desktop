import * as fs from 'fs';
import * as path from 'path';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getCurrentModel } from '../languagemodels';
import { Graph, createHeartbeatGraph, createAgentGraph, createSubconsciousGraph, BaseThreadState, AgentGraphState, GeneralGraphState } from '../nodes/Graph';
import { saveThreadState, loadThreadState } from '../nodes/ThreadStateStore';
import { toolRegistry } from '../tools/registry';
import { resolveSullaAgentsDir, resolveAllAgentsDirs, findAgentDir } from '../utils/sullaPaths';

// Side-effect: ensure tool manifests are registered before any graph runs
import '../tools/manifests';
// Back-compat re-export
export type { AgentGraphState as OverlordThreadState } from '../nodes/Graph';

const registry = new Map<string, {
  graph: Graph<any>;
  state: BaseThreadState;
}>();

// ============================================================================
// SUBCONSCIOUS MIDDLEWARE — TOOL ASSIGNMENTS
// ============================================================================

/** Summarizer: no tools — pure text analysis and XML output */
const SUMMARIZER_TOOLS: string[] = [];

/** Tool-Result Digester: no tools — pure text analysis and XML output */
const TOOL_RESULT_DIGESTER_TOOLS: string[] = [];

/** Observation Writer: write/archive observations and update identity files */
const OBSERVATION_AGENT_TOOLS: string[] = [
  'add_observational_memory',     // Insert or update an observation row
  'remove_observational_memory',  // Soft-archive a stale observation
  'search_observations',          // Check for existing similar observations before adding
  'list_observations',            // Browse active observations
  'file_search',                  // Search identity/observation files
  'read_file',                    // Read ledger/identity files before updating them
  'write_file',                   // Write updates to identity/observation/ledger files
];

/** Observation Recall: read-only — search and list observations for context injection */
const OBSERVATION_RECALL_TOOLS: string[] = [
  'search_observations',  // ILIKE search on observation content
  'list_observations',    // Priority-sorted list of active observations
];

/**
 * Heartbeat native toolset — the slim primary set MINUS the interactive
 * `ask_user_question` tool. The heartbeat runs autonomously on the `heartbeat`
 * channel with no human watching, so a blocking question card would render
 * nowhere and deadlock the loop. Pinning this as the heartbeat's
 * `allowedToolNames` routes it through BaseNode's strict tool path (no dynamic
 * injection of ask_user_question). Full capability is retained — every other
 * tool is still reached via `browse_tools` + `exec`.
 */
const HEARTBEAT_TOOLS: string[] = [
  'browse_tools',
  'exec',
  'read_file',
  'write_file',
];

// ============================================================================
// SUBCONSCIOUS MIDDLEWARE PROMPTS
// ============================================================================

const OBSERVATION_AGENT_PROMPT = `You are the observation WRITER process for an AI agent.

CRITICAL: You are NOT the primary agent. You do NOT execute tasks, answer
questions, browse websites, call APIs, create files, or do anything the user
asked for. Another agent handles that. You ONLY manage observational memory.

Your ONLY jobs:
1. Review the conversation for important facts, decisions, preferences, or
   commitments that should be remembered long-term for all conversations.

   BEFORE calling add_observational_memory for any new observation:
   - Call search_observations with the key topic/phrase to check for existing
     similar entries.
   - If a similar entry exists, UPDATE it via add_observational_memory using
     its existing id (to update in-place) rather than creating a duplicate.
   - Only INSERT a fresh entry when nothing similar is found.

2. Review current observations for anything stale or superseded. Use
   remove_observational_memory (soft-archive, never hard-delete) for entries
   that are no longer accurate or have been superseded by a newer one.

3. If something important should update an identity file at ~/sulla/identity/,
   read and update that specific file with write_file.

4. Maintain the WORKBOARD (Postgres project_projects / work_epics / work_tasks —
   the agent's single project-state store). From THIS conversation only, extract:
   - Commitments made ("I'll build X", "next step is Y") -> search_project_items
     first; update_task the existing row or create_task if none matches.
     Never invent a parallel markdown task list.
   - Outcomes shipped (something merged, pushed, filed, fixed, verified,
     decided) -> update_task status=done (or in_progress if partial) and
     add_task_comment: date — what shipped — what it changed.
   - A gate opening or closing (approval given, PR merged, decision made) ->
     update_task the matching row (blocked -> in_progress / done) and comment.
   ~/sulla/ledger/ is a historical archive — do not write LEDGER.md / OUTCOMES.md.
   Skip entirely when the conversation contains no commitment, outcome, or
   gate change — most turns need NO Projects write.

When saving new observations, include why certain decisions were made (not just what). Like:

"Google Maps loaded with roofers — scrolled 3x, collected 5 results"
"Twenty account ID: local_merchant_protocol — verified working 2m ago"

If nothing needs to change, finish immediately.

Do NOT:
- Try to complete the user's task
- Search for tools, APIs, or integrations
- Run curl commands or interact with services
- Do anything beyond managing observations and identity files

Priority levels:
- 🔴 Critical: identity, strong preferences/goals, promises, deal-breakers
- 🟡 Valuable: decisions, patterns, progress markers
- ⚪ Low: minor/transient items (use sparingly)`;

const OBSERVATION_RECALL_PROMPT = `You are the observation RECALL process for an AI agent.

CRITICAL: You are READ-ONLY. You NEVER write, insert, update, or delete observations.
You only search and list — then return a filtered, compact summary.

## Your job

Read the recent conversation context. Based on what the human is asking about
or what task is in progress, search the observations table for entries that
are relevant OR might be relevant to the current context.

Rules:
- Call search_observations with the key topic/phrase from the conversation.
- Optionally call list_observations to see high-priority entries.
- Return ONLY observations that are relevant or possibly relevant.
- Format each result as: \`[id] priority date — content\`
- If nothing is relevant, return an empty string — do NOT pad with filler.
- Do NOT narrate your process. Output only the filtered observation lines.

Speed: the primary agent BLOCKS until you finish. Tool calls in the SAME
response run in PARALLEL — issue every search you need (different phrasings,
plus list_observations) as ONE batch in your first response, then answer.
Do not search one term at a time across multiple rounds.

Be selective: a 5-entry relevant subset is better than 30 entries dumped verbatim.`;
// ── Observation Recall: cache constants ──────────────────────────────────

const SUMMARIZER_PROMPT = `You are the memory compression process for an AI agent. Talk through
what you're doing — which messages look irrelevant, which have useful facts
worth keeping, and what you're compressing. Then provide your decisions as XML.

Each message below has a unique message_id in its metadata. Your job is to
remove information that is completely irrelevant to accomplishing the current
goal. Either remove irrelevant messages or summarize them down to the
important contextual facts.

For each message, decide:
- DELETE: if the message is completely irrelevant to the current goal
- SUMMARIZE: if the message has some relevant facts but is too verbose — compress it
- KEEP: if the message is important as-is (do nothing, don't list it)

Return your decisions as XML. Reference messages by their unique message_id (NOT by index
position — positions change between loops).

<DELETE>
  <MESSAGE id="msg_1743500000000_1" />
  <MESSAGE id="msg_1743500000000_4" />
</DELETE>
<SUMMARIZE>
  <MESSAGE id="msg_1743500000000_2">The compressed essential facts from this message.</MESSAGE>
  <MESSAGE id="msg_1743500000000_5">Key decision: user chose option B for the auth flow.</MESSAGE>
</SUMMARIZE>

Rules:
- Only delete or summarize — never add new messages.
- Preserve the most recent messages (last 5-10) as they contain active context.
- Focus compression on older messages in the conversation.
- If nothing needs to change, return empty tags: <DELETE></DELETE><SUMMARIZE></SUMMARIZE>
- System messages should never be deleted or summarized.
- Always use the message_id attribute, never reference messages by position.`;

const TOOL_RESULT_DIGESTER_PROMPT = `You are the tool-result digestion process for an AI agent. Stale tool
results from earlier in the conversation are about to be compressed so the
primary agent re-reads trusted citations instead of verbatim dumps. Talk
through what each result contains and what's worth keeping, then provide
your digests as XML.

Each tool result below is tagged with a unique tool_result_id. For EVERY
result, write a digest in trusted-citation style:
- What was run (tool name + key inputs/parameters)
- Key findings: concrete values, file paths, ids, counts, error messages
- Where the full output came from (file path, URL, command) so the primary
  agent can re-fetch it if truly needed

Return your digests as XML. Reference results by their tool_result_id (NOT
by position — positions change between loops).

<DIGEST>
  <RESULT id="toolu_abc123">file_search "auth flow" → 3 matches: src/auth/login.ts, src/auth/session.ts, docs/auth.md. login.ts owns the OAuth redirect. Re-run file_search to refresh.</RESULT>
  <RESULT id="toolu_def456">exec \`kubectl get pods\` → 12 pods running, 1 CrashLoopBackOff (redis-7d4f, restarts=14). Full output re-obtainable by re-running the command.</RESULT>
</DIGEST>

Rules:
- Digest EVERY tool result you were given — do not skip any.
- Preserve exact values: paths, ids, numbers, hashes, error strings. Never
  round, rename, or paraphrase identifiers.
- Never invent information that isn't in the original output.
- 1-4 sentences per digest. Dense, factual, no filler.
- If a result is an error, keep the error message verbatim.
- If nothing was given, return empty tags: <DIGEST></DIGEST>`;

// XML parsing for summarizer response handler — uses message IDs (strings)
const DELETE_BLOCK_REGEX = /<DELETE>([\s\S]*?)<\/DELETE>/i;
const SUMMARIZE_BLOCK_REGEX = /<SUMMARIZE>([\s\S]*?)<\/SUMMARIZE>/i;
const DELETE_MESSAGE_REGEX = /<MESSAGE\s+id="([^"]+)"\s*\/>/gi;
const SUMMARIZE_MESSAGE_REGEX = /<MESSAGE\s+id="([^"]+)">([\s\S]*?)<\/MESSAGE>/gi;

function parseSummarizerXML(text: string): { deletions: Set<string>; summaries: Map<string, string> } {
  const deletions = new Set<string>();
  const summaries = new Map<string, string>();

  const deleteBlock = DELETE_BLOCK_REGEX.exec(text);
  if (deleteBlock) {
    let match;
    DELETE_MESSAGE_REGEX.lastIndex = 0;
    while ((match = DELETE_MESSAGE_REGEX.exec(deleteBlock[1])) !== null) {
      deletions.add(match[1]);
    }
  }

  const summarizeBlock = SUMMARIZE_BLOCK_REGEX.exec(text);
  if (summarizeBlock) {
    let match;
    SUMMARIZE_MESSAGE_REGEX.lastIndex = 0;
    while ((match = SUMMARIZE_MESSAGE_REGEX.exec(summarizeBlock[1])) !== null) {
      summaries.set(match[1], match[2].trim());
    }
  }

  return { deletions, summaries };
}

// XML parsing for tool-result digester response handler — uses tool_use_ids
const DIGEST_BLOCK_REGEX = /<DIGEST>([\s\S]*?)<\/DIGEST>/i;
const DIGEST_RESULT_REGEX = /<RESULT\s+id="([^"]+)">([\s\S]*?)<\/RESULT>/gi;

function parseDigesterXML(text: string): Map<string, string> {
  const digests = new Map<string, string>();

  const digestBlock = DIGEST_BLOCK_REGEX.exec(text);
  if (digestBlock) {
    let match;
    DIGEST_RESULT_REGEX.lastIndex = 0;
    while ((match = DIGEST_RESULT_REGEX.exec(digestBlock[1])) !== null) {
      const digest = match[2].trim();
      if (digest) {
        digests.set(match[1], digest);
      }
    }
  }

  return digests;
}

/**
 * A stale tool_result block eligible for digestion.
 * Built by SubconsciousMiddleware, consumed by createToolResultDigester.
 */
export interface DigestibleToolResult {
  /** tool_use_id of the tool_result block in state.messages */
  toolUseId: string;
  /** Tool name if known (from message metadata) */
  toolName:  string;
  /** Serialized character count of the original block content */
  charCount: number;
  /** Text rendering of the block content (image data omitted) */
  text:      string;
}

export const GraphRegistry = {
  /**
   * Get existing graph for thread, or create new if not found.
   */
  get(threadId: string): {
    graph: Graph<any>;
    state: BaseThreadState;
  } | null {
    return registry.get(threadId) ?? null;
  },

  /**
   * Create a brand new graph + state (always fresh threadId).
   * Use when user explicitly wants "New Conversation".
   */
  createNew: async function(wsChannel: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<{
    graph:    Graph<any>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const threadId = nextThreadId();
    const graph = createAgentGraph();
    const state = await buildAgentState(wsChannel, threadId, options);

    registry.set(threadId, { graph, state });
    return { graph, state, threadId };
  },

  /**
   * Get or create Heartbeat graph (formerly Overlord).
   */
  getOrCreateOverlordGraph: async function(wsChannel: string, prompt?: string): Promise<{
    graph: Graph<AgentGraphState>;
    state: AgentGraphState;
  }> {
    // One conversation per heartbeat cycle: never resume a cached thread.
    // A long-lived thread pins the system prompt to whatever was built when
    // the conversation started (prompt updates never reach the model) and
    // accumulates self-reinforcing history. Continuity lives in recall,
    // observations, and the bookkeeping files — not chat scrollback.
    const graph = createHeartbeatGraph();
    const state = await buildHeartbeatState(wsChannel, prompt ?? '');

    // Keep the latest entry for observability/recovery consumers.
    registry.set(wsChannel, { graph, state });
    return { graph, state };
  },

  /**
   * Get or create AgentGraph — the standard graph for all tasks.
   * @param options Optional graph options that configure prompt directives, tool blocking, etc.
   */
  getOrCreate: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<{
    graph: Graph<AgentGraphState>;
    state: AgentGraphState;
  }> {
    if (registry.has(threadId)) {
      console.log(`[GraphRegistry] getOrCreate() — cache HIT for threadId="${ threadId }"`);
      return Promise.resolve(registry.get(threadId)!);
    }

    // Try to restore from ThreadStateStore (Redis / in-memory fallback)
    const saved = await loadThreadState(threadId);
    if (saved) {
      console.log(`[GraphRegistry] getOrCreate() — restored from ThreadStateStore for threadId="${ threadId }", messages=${ saved.messages.length }`);
      const graph = createAgentGraph();
      // Ensure wsChannel is current (may have changed)
      saved.metadata.wsChannel = wsChannel;
      registry.set(threadId, { graph, state: saved });
      return { graph, state: saved as AgentGraphState };
    }

    console.log(`[GraphRegistry] getOrCreate() — cache MISS, creating new graph for agentId="${ wsChannel }", threadId="${ threadId }"`);
    const graph = createAgentGraph();
    console.log(`[GraphRegistry] getOrCreate() — agent graph created, building state...`);
    const state = await buildAgentState(wsChannel, threadId, options);
    console.log(`[GraphRegistry] getOrCreate() — state built: model="${ state.metadata.llmModel }", local=${ state.metadata.llmLocal }, agentName="${ state.metadata.agent?.name || '(none)' }"`);

    registry.set(threadId, { graph, state });
    return { graph, state };
  },

  // Aliases — all point to AgentGraph now
  getOrCreateSkillGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  getOrCreateAgentGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  getOrCreateGeneralGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  /**
   * Create a Subconscious graph — minimal multi-turn tool-calling loop.
   * Does not cache in registry (each invocation is ephemeral).
   */
  createSubconscious: async function(opts: {
    systemPrompt:           string;
    tools:                  string[];
    userMessage:            string;
    messages?:              any[];
    maxIterations?:         number;
    temperature?:           number;
    format?:                'json';
    maxTokens?:             number;
    responseHandler?:       (response: string, state: BaseThreadState) => void;
    parentAbortSignal?:     any;
    agentLabel?:            string;
    parentConversationId?:  string;
    parentWsChannel?:       string;
    workflowNodeId?:        string;
    workflowParentChannel?: string;
  }): Promise<{
      graph:    Graph<BaseThreadState>;
      state:    BaseThreadState;
      threadId: string;
    }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState(opts);
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create a Summarizer graph — single-pass conversation compression.
   * Uses a responseHandler to parse XML delete/summarize instructions
   * and apply them to the original messages stored on metadata.
   */
  createSummarizer: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    // Ensure every message has a unique ID for stable referencing across loops.
    // Store the ID on the ChatMessage.id field AND inject it visibly into the
    // content so the LLM can see and reference it in its XML response.
    const originalMessages = parentState.messages.map((msg: any) => {
      const id = msg.id || nextMessageId();
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return {
        ...msg,
        id,
        content:  `[message_id: ${ id }]\n${ content }`,
        metadata: { ...(msg.metadata || {}), message_id: id },
      };
    });

    return this.createSubconscious({
      systemPrompt:           SUMMARIZER_PROMPT,
      tools:                  SUMMARIZER_TOOLS,
      userMessage:            'Review the conversation above and determine which messages to delete or summarize.',
      messages:               originalMessages,
      agentLabel:             'summarizer',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      parentAbortSignal:    (parentState.metadata as any).options?.abort,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
      responseHandler(response: string, state: BaseThreadState) {
        let actions: { deletions: Set<string>; summaries: Map<string, string> };
        try {
          actions = parseSummarizerXML(response);
        } catch (err) {
          console.warn('[Summarizer] Failed to parse XML response:', err instanceof Error ? err.message : err);
          return;
        }
        if (actions.deletions.size === 0 && actions.summaries.size === 0) return;

        // Rebuild from the original parent messages (clean content, no
        // injected [message_id:] prefixes). originalMessages and
        // parentState.messages are 1:1 — use the tagged ID with the
        // clean parent message.
        const parentMessages = parentState.messages;
        const result: any[] = [];
        for (let i = 0; i < originalMessages.length; i++) {
          const msgId = originalMessages[i].id;
          const cleanMsg = parentMessages[i] || originalMessages[i];
          if (cleanMsg.role === 'system') { result.push({ ...cleanMsg, id: msgId }); continue }
          if (actions.deletions.has(msgId)) continue;
          if (actions.summaries.has(msgId)) {
            result.push({
              ...cleanMsg,
              id:       msgId,
              content:  actions.summaries.get(msgId),
              metadata: { ...(cleanMsg.metadata || {}), message_id: msgId, _summarized: true, timestamp: Date.now() },
            });
            continue;
          }
          result.push({ ...cleanMsg, id: msgId });
        }

        (state.metadata as any).compressedMessages = result;
        (state.metadata as any).deletedCount = actions.deletions.size;
        (state.metadata as any).summarizedCount = actions.summaries.size;
        console.log(`[Summarizer] Compressed: deleted ${ actions.deletions.size }, summarized ${ actions.summaries.size }, kept ${ result.length } of ${ originalMessages.length }`);
      },
    });
  },

  /**
   * Create a Tool-Result Digester graph — single-pass compression of stale
   * tool_result blocks into trusted-citation digests. Uses a responseHandler
   * to parse XML <DIGEST> instructions into a tool_use_id → digest map; the
   * caller (SubconsciousMiddleware) applies the replacements to the live
   * state in one batch.
   *
   * The eligible tool results are rendered directly into the user message
   * rather than passing the full conversation — the digester only needs the
   * stale outputs themselves plus the current goal for relevance.
   */
  createToolResultDigester: async function(parentState: BaseThreadState, eligible: DigestibleToolResult[]): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    // Current goal — the last real user message — so the digester knows
    // which values matter for the active task.
    const lastUserMsg = [...parentState.messages].reverse().find(
      (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim(),
    );
    const goalText = lastUserMsg ? String(lastUserMsg.content).slice(0, 600) : '(unknown)';

    const rendered = eligible
      .map(r => `[tool_result_id: ${ r.toolUseId } | tool: ${ r.toolName } | ~${ r.charCount } chars]\n${ r.text }`)
      .join('\n\n---\n\n');

    return this.createSubconscious({
      systemPrompt:           TOOL_RESULT_DIGESTER_PROMPT,
      tools:                  TOOL_RESULT_DIGESTER_TOOLS,
      userMessage:            `Current goal:\n${ goalText }\n\nStale tool results to digest:\n\n${ rendered }\n\nDigest every tool result above and return your <DIGEST> XML.`,
      agentLabel:             'tool-result-digester',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
      responseHandler(response: string, state: BaseThreadState) {
        let digests: Map<string, string>;
        try {
          digests = parseDigesterXML(response);
        } catch (err) {
          console.warn('[ToolResultDigester] Failed to parse XML response:', err instanceof Error ? err.message : err);
          return;
        }
        if (digests.size === 0) return;

        (state.metadata as any).toolResultDigests = digests;
        console.log(`[ToolResultDigester] Parsed ${ digests.size } digests for ${ eligible.length } eligible tool results`);
      },
    });
  },

  /**
   * Create an Observation Agent (writer) graph — reviews conversation for
   * important facts to save to the observations table. Deduplicates via
   * search_observations before inserting, and soft-archives stale entries.
   * The agent reads its own context from the DB — no pre-loaded blob needed.
   */
  createObservationAgent: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           OBSERVATION_AGENT_PROMPT,
      tools:                  OBSERVATION_AGENT_TOOLS,
      userMessage:            'Review this conversation. Search for existing observations before adding any new ones (update instead of duplicate). Soft-archive stale or superseded entries. Update identity files if warranted. Write any commitments/outcomes/gate-changes from this conversation to the outcome ledger (~/sulla/ledger/). If nothing needs to change, finish immediately.',
      messages:               [...parentState.messages],
      // Wider than recall — the writer mines the conversation for facts —
      // but still bounded; the summarizer compacts anything older anyway.
      contextWindow:          30,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             'observation',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create an Observation Recall graph — read-only search of the observations
   * table to surface entries relevant to the current conversation context.
   * Returns compact `[id] priority date — content` lines, or null when nothing
   * is relevant.
   */
  createObservationRecall: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           OBSERVATION_RECALL_PROMPT,
      tools:                  OBSERVATION_RECALL_TOOLS,
      userMessage:            'Read the recent conversation context and return only the observations that are relevant or possibly relevant to what the human is asking about. Return compact lines only — nothing if nothing is relevant.',
      messages:               [...parentState.messages],
      // Recent tail only: obs-recall reads the latest exchange, then searches the table.
      contextWindow:          20,
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             'observation-recall',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).threadId || (parentState.metadata as any).conversationId,
      workflowNodeId:         (parentState.metadata as any).workflowNodeId,
      workflowParentChannel:  (parentState.metadata as any).workflowParentChannel,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },


  delete(threadId: string): void {
    registry.delete(threadId);
  },

  clearAll(): void {
    registry.clear();
  },

  updateRuntimeFlags(threadId: string, flags: { n8nLiveEventsEnabled?: boolean }): boolean {
    const record = registry.get(threadId);
    if (!record) {
      return false;
    }

    if (typeof flags.n8nLiveEventsEnabled === 'boolean') {
      (record.state.metadata as any).n8nLiveEventsEnabled = flags.n8nLiveEventsEnabled;
    }

    return true;
  },

  updateRuntimeFlagsByStateThreadId(threadId: string, flags: { n8nLiveEventsEnabled?: boolean }): number {
    let updatedCount = 0;

    for (const record of registry.values()) {
      const stateThreadId = String((record.state.metadata as any)?.threadId || '').trim();
      if (!stateThreadId || stateThreadId !== threadId) {
        continue;
      }

      if (typeof flags.n8nLiveEventsEnabled === 'boolean') {
        (record.state.metadata as any).n8nLiveEventsEnabled = flags.n8nLiveEventsEnabled;
      }

      updatedCount += 1;
    }

    return updatedCount;
  },

  /**
   * Best-effort lookup of the live sulla-desktop chat the user is looking
   * at. Used by the interactive `ask_user_question` tool when it is invoked
   * outside a ToolExecutor context (CLI / HTTP) and needs a channel + thread
   * to render its card into.
   *
   * Prefers graphs whose wsChannel is `sulla-desktop` and that still look
   * "alive" (not waitingForUser with a completed cycle). Falls back to the
   * most recently registered sulla-desktop entry, then any agent graph.
   */
  findActiveChat(): { wsChannel: string; threadId: string; state: BaseThreadState } | null {
    const preferred: Array<{ wsChannel: string; threadId: string; state: BaseThreadState; score: number }> = [];
    for (const [key, record] of registry.entries()) {
      const state = record.state;
      const wsChannel = String(state?.metadata?.wsChannel || '').trim();
      const threadId = String(state?.metadata?.threadId || key || '').trim();
      if (!wsChannel || !threadId) continue;
      // Skip pure subconscious / heartbeat-only graphs — they are not the chat UI.
      if (wsChannel === 'heartbeat' || wsChannel.startsWith('subconscious')) continue;
      let score = 0;
      if (wsChannel === 'sulla-desktop') score += 100;
      if (!(state.metadata as any)?.cycleComplete) score += 10;
      if ((state.metadata as any)?.hadUserMessages) score += 5;
      // Prefer non-sub-agent primary graphs.
      if (!(state.metadata as any)?.isSubAgent) score += 20;
      preferred.push({ wsChannel, threadId, state, score });
    }
    if (preferred.length === 0) return null;
    preferred.sort((a, b) => b.score - a.score);
    const best = preferred[0];
    return { wsChannel: best.wsChannel, threadId: best.threadId, state: best.state };
  },
};

const DEFAULT_AGENT_FALLBACK = 'chat-controller';

/**
 * Resolve the default agent ID from settings, falling back to 'chat-controller'.
 */
export async function getDefaultAgentId(): Promise<string> {
  console.log(`[GraphRegistry] getDefaultAgentId() — resolving...`);
  const id = await SullaSettingsModel.get('defaultAgentId', 'sulla-desktop');
  if (id) {
    console.log(`[GraphRegistry] getDefaultAgentId() — found setting: "${ id }"`);
    return id;
  }

  // If no setting yet, check if chat-controller exists
  if (findAgentDir(DEFAULT_AGENT_FALLBACK)) {
    console.log(`[GraphRegistry] getDefaultAgentId() — no setting, using fallback dir: "${ DEFAULT_AGENT_FALLBACK }"`);
    return DEFAULT_AGENT_FALLBACK;
  }

  // Last resort: pick the first agent directory that exists
  for (const agentsRoot of resolveAllAgentsDirs()) {
    console.log(`[GraphRegistry] getDefaultAgentId() — scanning agents root: "${ agentsRoot }"`);
    if (fs.existsSync(agentsRoot)) {
      const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
      const firstAgent = entries.find(e => e.isDirectory());
      if (firstAgent) {
        console.log(`[GraphRegistry] getDefaultAgentId() — picked first agent dir: "${ firstAgent.name }"`);
        return firstAgent.name;
      }
    }
  }

  console.log(`[GraphRegistry] getDefaultAgentId() — no agents found, hard fallback: "${ DEFAULT_AGENT_FALLBACK }"`);
  return DEFAULT_AGENT_FALLBACK;
}

/**
 * Resolve the agent ID for a specific trigger type.
 * Checks triggerAgentMap first, then falls back to getDefaultAgentId().
 */
export async function getAgentIdForTrigger(triggerType: string): Promise<string> {
  const triggerMap: Record<string, string> = {
    'sulla-desktop': 'sulla-desktop',
    workbench:       'sulla-desktop',
    heartbeat:       'dreaming-protocol',
  };

  const assigned = triggerMap[triggerType];
  if (assigned) {
    const agentDir = findAgentDir(assigned);
    const exists = !!agentDir;
    console.log(`[GraphRegistry] getAgentIdForTrigger() — trigger "${ triggerType }" mapped to "${ assigned }", dir exists=${ exists }`);
    // Return the mapped ID whether or not the dir exists — buildAgentState
    // gracefully handles missing agent dirs (runs with default prompts/tools).
    return assigned;
  }

  console.log(`[GraphRegistry] getAgentIdForTrigger() — no mapping for "${ triggerType }", using triggerType as agentId`);
  return triggerType || 'sulla-desktop';
}

let threadCounter = 0;
let messageCounter = 0;

export function nextThreadId(): string {
  return `thread_${ Date.now() }_${ ++threadCounter }`;
}

export function nextMessageId(): string {
  return `msg_${ Date.now() }_${ ++messageCounter }`;
}

async function buildHeartbeatState(wsChannel: string, prompt: string): Promise<AgentGraphState> {
  const heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');

  // Resolve provider to model/local flags
  let llmModel: string;
  let llmLocal: boolean;

  if (heartbeatProvider === 'default' || heartbeatProvider === 'ollama') {
    llmModel = await getCurrentModel();
    llmLocal = false;
  } else {
    llmLocal = false;
    try {
      const { getIntegrationService } = await import('./IntegrationService');
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues(heartbeatProvider);
      const modelVal = values.find((v: { property: string; value: string }) => v.property === 'model');
      llmModel = modelVal?.value || '';
    } catch {
      llmModel = await SullaSettingsModel.get('remoteModel', '');
    }
  }

  const now = Date.now();
  const threadId = `heartbeat_${ now }`;

  // Load agent config for the heartbeat channel (dreaming-protocol)
  const agentConfig = await loadAgentConfig(wsChannel);

  // Pre-resolve the heartbeat's native tool schemas. Setting both `llmTools`
  // (top-level, read by normalizedChat) and `allowedToolNames` (metadata,
  // forwarded by AgentNode) routes the heartbeat through BaseNode's strict
  // tool path — it gets exactly HEARTBEAT_TOOLS and never the injected
  // interactive tools that can only deadlock on the unwatched channel.
  const llmTools = await Promise.all(
    HEARTBEAT_TOOLS.map(name => toolRegistry.convertToolToLLM(name)),
  );

  const state: AgentGraphState = {
    messages: [{
      role:     'user',
      content:  prompt,
      metadata: { source: 'heartbeat' },
    }],
    metadata: {
      action:               'use_tools',
      threadId,
      wsChannel,
      cycleComplete:        false,
      waitingForUser:       false,
      isSubAgent:           false,
      subAgentDepth:        0,
      llmModel,
      llmLocal,
      options:              {},
      currentNodeId:        'input_handler',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               {
        knowledgeBaseContext: '',
        chatSummariesContext: '',
      },
      subGraph: {
        state:    'completed',
        name:     'hierarchical',
        prompt:   '',
        response: '',
      },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      agent:          agentConfig,
      agentLoopCount: 0,
    },
  };

  // llmTools rides on the top-level state (read by normalizedChat as
  // `(state as any).llmTools`); allowedToolNames lives on metadata (forwarded
  // by AgentNode). Both are `as any` fields, matching buildSubconsciousState.
  (state as any).llmTools = llmTools;
  (state.metadata as any).allowedToolNames = HEARTBEAT_TOOLS;

  return state;
}

async function buildAgentState(wsChannel: string, threadId?: string, graphOpts?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<AgentGraphState> {
  const id = threadId ?? nextThreadId();

  console.log(`[GraphRegistry] buildAgentState() — wsChannel="${ wsChannel }", threadId="${ id }"`);

  const mode = await SullaSettingsModel.get('modelMode', 'remote');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  const agentConfig = await loadAgentConfig(wsChannel);
  console.log(`[GraphRegistry] buildAgentState() — agent config for "${ wsChannel }": name="${ agentConfig?.name || '(none)' }", hasPrompt=${ !!agentConfig?.prompt }, type="${ agentConfig?.type || '(none)' }"`);

  return {
    messages: [],
    metadata: {
      action:    'direct_answer',
      threadId:  id,
      wsChannel,

      cycleComplete:  false,
      waitingForUser: false,
      isSubAgent:     false,
      subAgentDepth:  0,

      llmModel,
      llmLocal,
      options:              { abort: undefined },
      currentNodeId:        'input_handler',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               {
        knowledgeBaseContext: '',
        chatSummariesContext: '',
      },
      subGraph: {
        state:    'completed',
        name:     'hierarchical',
        prompt:   '',
        response: '',
      },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      conversationId: id,

      isTrustedUser:      graphOpts?.isTrustedUser ?? 'trusted',
      userVisibleBrowser: graphOpts?.userVisibleBrowser ?? true,

      agent:          agentConfig,
      agentLoopCount: 0,
    },
  };
}

/**
 * Load agent configuration from ~/sulla/agents/{agentId}/
 * Reads config.yaml for config and compiles all .md files into a single prompt.
 * Returns undefined if agent directory doesn't exist.
 */
async function loadAgentConfig(agentId: string): Promise<AgentGraphState['metadata']['agent']> {
  console.log(`[GraphRegistry] loadAgentConfig() — agentId="${ agentId }"`);
  if (!agentId) {
    console.log(`[GraphRegistry] loadAgentConfig() — empty agentId, returning undefined`);
    return undefined;
  }

  const agentDir = findAgentDir(agentId);
  if (!agentDir) {
    console.log(`[GraphRegistry] loadAgentConfig() — agent dir not found for: ${ agentId }`);
    return undefined;
  }

  const yamlPath = path.join(agentDir, 'config.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.log(`[GraphRegistry] loadAgentConfig() — config.yaml not found: ${ yamlPath }`);
    return undefined;
  }
  console.log(`[GraphRegistry] loadAgentConfig() — found agent at ${ agentDir }`);

  try {
    const yaml = await import('yaml');
    const parsed = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));

    // Compile all .md files into a single prompt (no variable substitution)
    const entries = fs.readdirSync(agentDir, { withFileTypes: true });
    const mdFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'environment.md')
      .sort((a, b) => {
        // soul.md first, then alphabetical
        const order = (name: string) => name === 'soul.md' ? 0 : 1;
        return order(a.name) - order(b.name) || a.name.localeCompare(b.name);
      });

    const sections: string[] = [];
    for (const file of mdFiles) {
      const content = fs.readFileSync(path.join(agentDir, file.name), 'utf-8').trim();
      if (content) {
        sections.push(content);
      }
    }

    return {
      name:         parsed.name || agentId,
      description:  parsed.description || '',
      type:         parsed.type || 'worker',
      skills:       parsed.skills || [],
      tools:        parsed.tools || [],
      integrations: parsed.integrations || [],
      prompt:       sections.length > 0 ? sections.join('\n\n') : undefined,
      excludeSoul:  parsed.excludeSoul === true,
      model:        typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined,
      provider:     typeof parsed.provider === 'string' && parsed.provider.trim() ? parsed.provider.trim() : undefined,
    };
  } catch (err) {
    console.error(`[GraphRegistry] Failed to load agent config for ${ agentId }:`, err);
    return undefined;
  }
}

/**
 * Cap the conversation context handed to a subconscious agent: keep only the
 * most recent `windowSize` messages and truncate oversized text/tool_result
 * blocks. Recall/observation agents analyze the RECENT conversation and then
 * work through their search tools — handing them the whole thread (with
 * multi-KB tool dumps) just inflates every one of their LLM round-trips.
 * This is an INPUT diet, not a time limit: the agents still run for as long
 * as their job takes. Parent message objects are never mutated — truncated
 * messages are shallow clones.
 */
function windowedContext(messages: any[], windowSize: number, maxBlockChars: number): any[] {
  const marker = '\n…[earlier content truncated for subconscious context — use your search tools for full detail]';

  return messages.slice(-windowSize).map((m) => {
    const c = m?.content;

    if (typeof c === 'string') {
      return c.length > maxBlockChars ? { ...m, content: c.slice(0, maxBlockChars) + marker } : m;
    }
    if (Array.isArray(c)) {
      let changed = false;
      const blocks = c.map((b) => {
        if (b?.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');

          if (text.length > maxBlockChars) {
            changed = true;

            return { ...b, content: text.slice(0, maxBlockChars) + marker };
          }
        }
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > maxBlockChars) {
          changed = true;

          return { ...b, text: b.text.slice(0, maxBlockChars) + marker };
        }

        return b;
      });

      return changed ? { ...m, content: blocks } : m;
    }

    return m;
  });
}

async function buildSubconsciousState(opts: {
  systemPrompt:          string;
  tools:                 string[];
  userMessage:           string;
  messages?:             any[];
  /** Keep only the last N conversation messages as agent context (see windowedContext) */
  contextWindow?:        number;
  /** Per-block truncation size used with contextWindow; default 4000 chars */
  maxContextBlockChars?: number;
  maxIterations?:        number;
  temperature?:          number;
  format?:               'json';
  maxTokens?:            number;
  responseHandler?:      (response: string, state: BaseThreadState) => void;
  parentAbortSignal?:    any;
  /** Label for logging — identifies which subconscious agent this is */
  agentLabel?:           string;
  /** Parent conversation ID for log tracing */
  parentConversationId?: string;
  /** Parent's WebSocket channel — subconscious agents push thinking messages here */
  parentWsChannel?:      string;
  /** When invoked inside a workflow run, these route the subagent's
      BaseNode.wsChatMessage emits into the workflow's live stream so the
      user can see subconscious work progressing (otherwise a long memory-
      recall looks like a total stall on the canvas). */
  workflowNodeId?:       string;
  workflowParentChannel?: string;
}): Promise<BaseThreadState> {
  const threadId = `subconscious_${ Date.now() }_${ ++threadCounter }`;

  const mode = await SullaSettingsModel.get('modelMode', 'remote');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  // Pre-resolve tool schemas for the LLM
  const llmTools = await Promise.all(
    opts.tools.map(name => toolRegistry.convertToolToLLM(name)),
  );

  // Build messages: use provided messages array + append user message, or just user message.
  // When contextWindow is set, the agent gets the conversation TAIL with long
  // blocks truncated instead of the full thread — see windowedContext().
  const context: any[] = opts.messages
    ? (opts.contextWindow ? windowedContext(opts.messages, opts.contextWindow, opts.maxContextBlockChars ?? 4_000) : [...opts.messages])
    : [];
  const messages: any[] = [...context, { role: 'user', content: opts.userMessage, metadata: { source: 'subconscious' } }];

  return {
    messages,
    // llmTools must be on the top-level state object — normalizedChat()
    // reads (state as any).llmTools, NOT state.metadata.llmTools
    llmTools,
    metadata: {
      action:               'use_tools',
      threadId,
      conversationId:       threadId,
      parentConversationId: opts.parentConversationId,
      parentWsChannel:      opts.parentWsChannel,
      agentLabel:           opts.agentLabel,
      wsChannel:            opts.agentLabel ? `subconscious:${ opts.agentLabel }` : 'subconscious',
      cycleComplete:        false,
      waitingForUser:       false,
      isSubAgent:           true,
      subAgentDepth:        0,
      llmModel,
      llmLocal,
      options:              { abort: opts.parentAbortSignal },
      currentNodeId:        'subconscious',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               { knowledgeBaseContext: '', chatSummariesContext: '' },
      subGraph:             { state: 'completed', name: '', prompt: '', response: '' },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      // Subconscious-specific fields
      systemPrompt:     opts.systemPrompt,
      allowedToolNames: opts.tools,
      temperature:      opts.temperature,
      format:           opts.format,
      maxTokens:        opts.maxTokens,
      responseHandler:  opts.responseHandler,

      // Workflow routing — when set, BaseNode.wsChatMessage will emit
      // `node_thinking` events into the workflow's live stream so the
      // user sees subconscious progress instead of a dead canvas during
      // long recall/observation phases. The `agentLabel` prefix is what
      // the frontend uses to attribute the thought to the subconscious
      // rather than the orchestrator node itself.
      workflowNodeId:        opts.workflowNodeId,
      workflowParentChannel: opts.workflowParentChannel,
      workflowThinkingLabel: opts.agentLabel,
    },
  } as any;
}
