/**
 * SubconsciousMiddleware — pre-processing step before the main agent LLM call.
 *
 * Launches up to 5 parallel subconscious graphs:
 * 1. Conversational Summarizer — compresses/deletes old messages
 * 2. Memory Recall Agent — searches for relevant skills, tools, resources
 * 3. Observation Writer Agent — writes/archives observational memories (fire-and-forget)
 * 4. Observation Recall Agent — surfaces relevant observations for context injection
 * 5. Tool-Result Digester — compresses stale tool_result blocks into
 *    trusted-citation digests so the primary model re-reads citations
 *    instead of verbatim dumps
 *
 * Results are merged back into the live state before the main agent call.
 *
 * All agents are fully logged via the conversation logger (SullaLogger).
 * Each gets its own conversationId linked to the parent via parentConversationId.
 * Logs are written to ~/sulla/logs/ and can be inspected for debugging.
 */

import { ObservationsModel } from '../database/models/ObservationsModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { GraphRegistry, type DigestibleToolResult } from '../services/GraphRegistry';
import { parseJson } from '../services/JsonParseService';
import Logging from '@pkg/utils/logging';

import type { BaseThreadState } from '../nodes/Graph';

// Dedicated perf-timing log (perf.log). The existing console.log lines below
// never surfaced in any log file — the agent's raw console output isn't
// captured — so all timing goes through the Logging facility instead.
const perf = Logging.perf;

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Message count threshold before the summarizer runs. Was 45 — by the time
 * it woke, threads carried 45-50 messages of un-summarized history through
 * every turn. 30 wakes it a full wave earlier while staying comfortably
 * above the summarizer's own protected-recent window.
 */
const TRIGGER_WINDOW_SIZE = 30;

/**
 * Compactable tool-result token mass that triggers the digester.
 *
 * Cache-aware batching: Anthropic prompt caching is strict-prefix — editing
 * any past message invalidates the cache from that point on. So the digester
 * compacts in ONE batch only once enough stale mass has accumulated (one
 * cache rebuild on the smaller history, then ride the cheap cached prefix).
 * It must never trickle edits turn by turn.
 */
const DIGEST_TRIGGER_TOKEN_MASS = 20_000;

/**
 * Never digest tool results inside the last N assistant turns — they are
 * tool-chain-critical (the model may still be acting on them) and sit in
 * the hot cache region.
 */
const DIGEST_PROTECTED_RECENT_TURNS = 4;

/**
 * Marker prefix stamped onto digested tool_result content. Doubles as the
 * "already digested" flag so a block is never re-digested.
 */
const DIGESTED_MARKER_PREFIX = '[digested tool result';

/**
 * Token estimation heuristic — matches BaseNode's pre-flight trim
 * (~4 chars per token).
 */
const estimateTokensFromChars = (chars: number) => Math.ceil(Math.max(0, chars) / 4);

// ============================================================================
// MIDDLEWARE
// ============================================================================

export interface SubconsciousMiddlewareOptions {
  /** Whether observations should be managed (false for planning agents) */
  includeObservations: boolean;
  /** Optional recall variant — changes the recall prompt/tools for specific agents */
  recallVariant?:      'default' | 'heartbeat';
  /**
   * Live progress sink. The awaited subconscious phase blocks the primary
   * agent (recall is never time-limited by design), so without a signal the
   * UI — especially the mobile relay, whose only live indicator is the
   * activity line — shows a dead "Thinking…" for the whole wait. The caller
   * wires this to a thinking-kind chat emit; each launch/completion gets one
   * short line ("Recalling memories…", "Memory recall done (12.4s)").
   */
  onProgress?:         (message: string) => void;
}

/**
 * Run the subconscious middleware pipeline.
 * Launches applicable agents in parallel, then merges their results into state.
 */
/**
 * True when the state carries at least one real user text message — the
 * thing the recall/observation agents exist to analyze. Tool-result-only
 * user turns and messages injected by the subconscious itself don't count.
 */
function hasAnalyzableUserMessage(state: BaseThreadState): boolean {
  return state.messages.some((m: any) => {
    if (m?.role !== 'user') return false;
    if ((m?.metadata as any)?.source === 'subconscious') return false;
    const c = m?.content;

    if (typeof c === 'string') return c.trim().length > 0;
    if (Array.isArray(c)) {
      return c.some((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
    }

    return false;
  });
}

export async function runSubconsciousMiddleware(
  state: BaseThreadState,
  options: SubconsciousMiddlewareOptions,
): Promise<void> {
  // Workflow-bound agents skip the entire subconscious pipeline. A
  // running routine already has deterministic inputs (the workflow
  // definition + node prompts) and doesn't need memory-recall /
  // observation / summarization on every turn — those only slow the
  // run down and muddy the live event stream.
  //
  // Three signals all mean "inside a routine":
  //   - workflowNodeId        — set by PlaybookController per step
  //   - activeWorkflow        — set by activateWorkflowOnState the moment
  //                             a routine is primed, BEFORE the first
  //                             graph.execute returns. Critical for the
  //                             direct-launch path in executeRoutine,
  //                             which calls graph.execute before
  //                             PlaybookController has stamped a nodeId.
  //   - scopedWorkflowId      — set by executeRoutine as a belt-and-suspenders
  //                             marker in case activeWorkflow hasn't
  //                             landed yet.
  const meta = state.metadata as any;
  if (meta.workflowNodeId || meta.activeWorkflow || meta.scopedWorkflowId) {
    console.log('[SubconsciousMiddleware] Skipped — running inside a workflow');
    return;
  }

  const startTime = Date.now();
  const launched: string[] = [];
  const awaitedTasks: Promise<void>[] = [];

  const progress = (message: string) => {
    try { options.onProgress?.(message) } catch { /* progress must never break the pipeline */ }
  };

  // Per-sub-agent timing — records how long each awaited subconscious task
  // takes so we can see WHICH one (recall, obs-recall, summarizer, digester)
  // dominates the blocking prelude. Settles even on rejection.
  const timings: Record<string, number> = {};
  const timed = (name: string, label: string, p: Promise<void>): Promise<void> => {
    const t0 = Date.now();
    progress(`${ label }…`);
    return p.finally(() => {
      timings[name] = Date.now() - t0;
      progress(`${ label } done (${ ((Date.now() - t0) / 1000).toFixed(1) }s)`);
    });
  };

  // 1. Summarizer — only when conversation is long (awaited: modifies messages)
  const shouldSummarize = state.messages.length > TRIGGER_WINDOW_SIZE;
  if (shouldSummarize) {
    launched.push('summarizer');
    awaitedTasks.push(timed('summarizer', 'Summarizing older conversation', runSummarizer(state)));
  }

  // 1b. Tool-Result Digester — triggered by compactable TOKEN MASS, not
  //     message count (awaited: modifies messages). Only stale tool results
  //     outside the last DIGEST_PROTECTED_RECENT_TURNS assistant turns and
  //     not already digested count toward the trigger. See
  //     DIGEST_TRIGGER_TOKEN_MASS for why this fires in batches.
  const digestPlan = collectDigestibleToolResults(state);
  if (digestPlan.estTokens >= DIGEST_TRIGGER_TOKEN_MASS) {
    launched.push('tool-result-digester');
    awaitedTasks.push(timed('digester', 'Compacting stale tool results', runToolResultDigester(state, digestPlan.eligible)));
  }

  // The recall/observation agents analyze the conversation's user messages.
  // When a cycle carries none (channel-join pings, system-triggered turns),
  // dispatching them sends only the bare instruction text — the agent
  // correctly returns nothing, but a whole subconscious LLM round-trip is
  // burned per agent, per occurrence. Heartbeat recall is exempt: its prompt
  // loads active projects and doesn't depend on a latest user message.
  const analyzable = hasAnalyzableUserMessage(state);

  // Recall is NEVER time-limited — the primary agent waits as long as recall
  // needs, because starting a turn without the right context is worse than
  // starting it late (Jonathon, 2026-07-06). Recall latency is addressed by
  // making its TOOLS fast (the file_search sidecar fix took its searches
  // from 20-30s degraded scans to sub-second indexed queries) and by not
  // dispatching at all when a turn carries nothing to analyze — not by
  // cutting the agents off mid-job.

  // 2. Recall — awaited. Normal user turns use the fast episodic graph
  //    recall lane. Heartbeat keeps its legacy recall variant because that
  //    prompt gathers active project files, human presence, and sub-agent jobs
  //    that the episodic graph does not represent.
  if (options.recallVariant === 'heartbeat' || analyzable) {
    if (options.recallVariant === 'heartbeat') {
      launched.push('memory-recall');
      const recallPromise = runMemoryRecall(state, options.recallVariant);
      awaitedTasks.push(timed('memory-recall', 'Recalling memories', recallPromise.then(ctx => { (state.metadata as any).recallContext = ctx })));
    } else {
      launched.push('episodic-recall');
      const recallPromise = runEpisodicRecall(state);
      awaitedTasks.push(timed('episodic-recall', 'Recalling graph memories', recallPromise.then(ctx => { (state.metadata as any).episodicContext = ctx })));
    }
  } else {
    console.log('[SubconsciousMiddleware] Recall skipped — no user message in state to analyze');
  }

  // 2c. Conversation Recall — awaited: searches PAST conversations (titles,
  //     summaries, transcripts) and writes state.metadata.conversationRecallContext.
  //     Runs in PARALLEL with the recall lane above (all awaitedTasks are
  //     Promise.allSettled'd together), so it only adds wall-clock if it is
  //     slower than the slowest existing lane. Gated on an analyzable user turn
  //     for the same reason as the others — nothing to recall against otherwise.
  if (analyzable) {
    launched.push('conversation-recall');
    const convRecallPromise = runConversationRecall(state);
    awaitedTasks.push(timed('conversation-recall', 'Recalling past conversations', convRecallPromise.then(ctx => { (state.metadata as any).conversationRecallContext = ctx })));
  }

  // 3a. Observation Writer — fire-and-forget: writes/archives observation rows
  //     via DB tools. Never touches state.messages. No need to await.
  if (options.includeObservations && analyzable) {
    launched.push('observation-writer (fire-and-forget)');
    runObservationAgent(state).catch((error) => {
      console.error('[SubconsciousMiddleware] Observation Writer failed (fire-and-forget):', error instanceof Error ? error.message : error);
    });
  }

  // 3b. Observation Recall — awaited: surfaces relevant observations from the
  //     DB table and writes them to state.metadata.observationContext so the
  //     primary agent gets targeted observation context instead of the full blob.
  if (options.includeObservations && analyzable) {
    launched.push('observation-recall');
    const obsRecallPromise = runObservationRecall(state);
    awaitedTasks.push(timed('observation-recall', 'Checking observations', obsRecallPromise.then(ctx => { (state.metadata as any).observationContext = ctx })));
  }

  console.log(`[SubconsciousMiddleware] Launched: ${ launched.join(', ') } | messages: ${ state.messages.length }`);

  // Every task in awaitedTasks writes into the live turn state. The primary
  // agent must never start while one of these tasks can still mutate messages
  // or metadata underneath it.
  const settledResults = await Promise.allSettled(awaitedTasks);

  const failures = settledResults.filter(r => r.status === 'rejected');
  const elapsed = Date.now() - startTime;

  if (failures.length > 0) {
    for (const f of failures) {
      console.error('[SubconsciousMiddleware] Agent failed:', (f).reason?.message || (f).reason);
    }
  }

  const recallLen = ((state.metadata as any).recallContext || '').length;
  const episodicLen = ((state.metadata as any).episodicContext || '').length;
  const obsRecallLen = ((state.metadata as any).observationContext || '').length;
  const convRecallLen = ((state.metadata as any).conversationRecallContext || '').length;
  console.log(`[SubconsciousMiddleware] Complete in ${ elapsed }ms | ${ settledResults.length - failures.length }/${ settledResults.length } succeeded | recallContext: ${ recallLen } chars | episodicContext: ${ episodicLen } chars | observationContext: ${ obsRecallLen } chars | conversationRecallContext: ${ convRecallLen } chars`);

  // Perf: total blocking prelude + per-sub-agent breakdown (which one dominates).
  const breakdown = Object.entries(timings).map(([n, ms]) => `${ n }=${ ms }ms`).join(', ');
  perf.log(`[SubconsciousTiming] threadId=${ (state.metadata as any).threadId } totalMs=${ elapsed } launched=[${ launched.join(', ') }] timings=[${ breakdown }] recallChars=${ recallLen } episodicChars=${ episodicLen } obsChars=${ obsRecallLen } convChars=${ convRecallLen }`);
}

// ============================================================================
// SUMMARIZER
// ============================================================================

async function runSummarizer(state: BaseThreadState): Promise<void> {
  const startTime = Date.now();
  const messagesBefore = state.messages.length;

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createSummarizer(state);
    console.log(`[SubconsciousMiddleware:Summarizer] Started | threadId: ${ threadId } | messages: ${ messagesBefore }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 1 });

    // Apply compressed messages if the summarizer produced them
    const compressedMessages = (subState.metadata as any).compressedMessages;
    if (compressedMessages && Array.isArray(compressedMessages)) {
      const deletedCount = (subState.metadata as any).deletedCount || 0;
      const summarizedCount = (subState.metadata as any).summarizedCount || 0;

      // Replace the live state's messages with the compressed version
      state.messages.splice(0, state.messages.length, ...compressedMessages);

      console.log(`[SubconsciousMiddleware:Summarizer] Applied in ${ Date.now() - startTime }ms | deleted: ${ deletedCount }, summarized: ${ summarizedCount }, messages: ${ messagesBefore } → ${ state.messages.length }`);
    } else {
      console.log(`[SubconsciousMiddleware:Summarizer] No changes in ${ Date.now() - startTime }ms`);
    }
  } catch (error) {
    console.error(`[SubconsciousMiddleware:Summarizer] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// TOOL-RESULT DIGESTER
// ============================================================================

interface DigestPlan {
  eligible:  DigestibleToolResult[];
  estTokens: number;
}

/**
 * Render a tool_result block's content as plain text for the digester.
 * Image blocks are omitted (the digester is pure text analysis) but noted,
 * so digesting a stale screenshot result reclaims its base64 payload too.
 */
function renderToolResultText(content: any): { text: string; charCount: number } {
  if (typeof content === 'string') {
    return { text: content, charCount: content.length };
  }
  if (Array.isArray(content)) {
    const charCount = JSON.stringify(content).length;
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block?.type === 'image') {
        parts.push(`[screenshot image omitted — ~${ block?.source?.data?.length ?? 0 } chars base64]`);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    return { text: parts.join('\n'), charCount };
  }
  const serialized = JSON.stringify(content) ?? '';
  return { text: serialized, charCount: serialized.length };
}

/**
 * Collect tool_result blocks that are BOTH older than the last
 * DIGEST_PROTECTED_RECENT_TURNS assistant turns AND not already digested,
 * along with their estimated token mass (the trigger signal).
 */
function collectDigestibleToolResults(state: BaseThreadState): DigestPlan {
  const messages = state.messages as any[];

  // Protection boundary: the index of the Nth-from-last assistant message.
  // Everything at or after it is "recent" and never touched.
  let assistantSeen = 0;
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantSeen++;
      if (assistantSeen >= DIGEST_PROTECTED_RECENT_TURNS) {
        boundary = i;
        break;
      }
    }
  }
  if (boundary <= 0) {
    // Fewer than DIGEST_PROTECTED_RECENT_TURNS turns — everything is recent.
    return { eligible: [], estTokens: 0 };
  }

  const eligible: DigestibleToolResult[] = [];
  let estChars = 0;

  for (let i = 0; i < boundary; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      // Already digested — never re-digest
      if (typeof block.content === 'string' && block.content.startsWith(DIGESTED_MARKER_PREFIX)) continue;

      const { text, charCount } = renderToolResultText(block.content);
      eligible.push({
        toolUseId: block.tool_use_id,
        toolName:  msg.metadata?.toolName || 'unknown',
        charCount,
        text,
      });
      estChars += charCount;
    }
  }

  return { eligible, estTokens: estimateTokensFromChars(estChars) };
}

/**
 * Run the digester and apply its digests to the live state in ONE batch.
 *
 * Awaited (not fire-and-forget) for the same reason as the summarizer: it
 * mutates state.messages, and the primary agent must see a consistent
 * history before its LLM call. Applying results "next turn" would also mean
 * the rewrite races the prompt-cache prefix mid-turn.
 *
 * Replacements are looked up by tool_use_id over the LIVE message array at
 * apply time (not via references captured at collection time), so a
 * concurrent summarizer splice can't strand the edits.
 *
 * NOTE (claude-code provider): when the primary agent runs through the
 * claude-code provider with --resume, conversation history lives inside the
 * Claude Code session, not in state.messages — there, this compaction only
 * takes effect when a session is re-seeded/rehydrated (intentionally NOT
 * implemented here). It still benefits the anthropic provider path
 * immediately and shrinks the BaseNode pre-flight token budget on every
 * provider.
 */
async function runToolResultDigester(state: BaseThreadState, eligible: DigestibleToolResult[]): Promise<void> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createToolResultDigester(state, eligible);
    console.log(`[SubconsciousMiddleware:Digester] Started | threadId: ${ threadId } | eligible: ${ eligible.length } tool results`);

    await graph.execute(subState, 'subconscious', { maxIterations: 1 });

    const digests = (subState.metadata as any).toolResultDigests as Map<string, string> | undefined;
    if (!digests || digests.size === 0) {
      console.log(`[SubconsciousMiddleware:Digester] No digests produced in ${ Date.now() - startTime }ms`);
      return;
    }

    // Apply in ONE batch — every digested block rewritten in the same turn
    // so the prompt cache is invalidated once, not repeatedly.
    const charCounts = new Map(eligible.map(e => [e.toolUseId, e.charCount]));
    let applied = 0;
    let savedChars = 0;

    for (const msg of state.messages as any[]) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block?.type !== 'tool_result') continue;
        const digest = digests.get(block.tool_use_id);
        if (!digest) continue;
        if (typeof block.content === 'string' && block.content.startsWith(DIGESTED_MARKER_PREFIX)) continue;

        const originalChars = charCounts.get(block.tool_use_id) ??
          (typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length);

        // Only the tool_result content shrinks — ids/roles/structure preserved.
        block.content = `${ DIGESTED_MARKER_PREFIX } — original ~${ originalChars } chars] ${ digest }`;
        msg.metadata = { ...(msg.metadata || {}), _digestedToolResults: true };

        applied++;
        savedChars += Math.max(0, originalChars - block.content.length);
      }
    }

    console.log(`[SubconsciousMiddleware:Digester] Applied in ${ Date.now() - startTime }ms | digested: ${ applied }/${ eligible.length }, ~${ estimateTokensFromChars(savedChars) } tokens reclaimed`);
  } catch (error) {
    console.error(`[SubconsciousMiddleware:Digester] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// MEMORY RECALL
// ============================================================================

async function runMemoryRecall(state: BaseThreadState, variant?: 'default' | 'heartbeat'): Promise<string | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createMemoryRecall(state, variant);
    console.log(`[SubconsciousMiddleware:MemoryRecall] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 20 });

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;

    // Extract only the structured contract from AGENT_DONE.
    // Never fall back to raw assistant messages — those are narration for the
    // thinking bubble, not a contract for the primary agent.
    const response = agentMeta.response;

    if (response && typeof response === 'string' && response.trim()) {
      console.log(`[SubconsciousMiddleware:MemoryRecall] Returning ${ response.length } chars in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
      return response.trim();
    }

    console.log(`[SubconsciousMiddleware:MemoryRecall] No relevant context found in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
    return null;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:MemoryRecall] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function runEpisodicRecall(state: BaseThreadState): Promise<string | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createEpisodicRecall(state);
    console.log(`[SubconsciousMiddleware:EpisodicRecall] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious');

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;
    const response = agentMeta.response;

    if (response && typeof response === 'string' && response.trim()) {
      const normalized = stripEpisodicContextEnvelope(response);
      if (!normalized) {
        console.log(`[SubconsciousMiddleware:EpisodicRecall] Empty graph context in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
        return null;
      }
      console.log(`[SubconsciousMiddleware:EpisodicRecall] Returning ${ normalized.length } chars in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
      return normalized;
    }

    console.log(`[SubconsciousMiddleware:EpisodicRecall] No relevant graph context found in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
    return null;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:EpisodicRecall] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

function stripEpisodicContextEnvelope(response: string): string {
  const trimmed = response.trim();
  if (trimmed === '<episodic_context />') return '';
  const match = /<episodic_context>\s*([\s\S]*?)\s*<\/episodic_context>/i.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

// ============================================================================
// CONVERSATION RECALL
// ============================================================================

async function runConversationRecall(state: BaseThreadState): Promise<string | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createConversationRecall(state);
    console.log(`[SubconsciousMiddleware:ConversationRecall] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 10 });

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;
    const response = agentMeta.response;

    if (response && typeof response === 'string' && response.trim()) {
      const normalized = stripConversationContextEnvelope(response);
      if (!normalized) {
        console.log(`[SubconsciousMiddleware:ConversationRecall] Empty conversation context in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
        return null;
      }
      console.log(`[SubconsciousMiddleware:ConversationRecall] Returning ${ normalized.length } chars in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
      return normalized;
    }

    console.log(`[SubconsciousMiddleware:ConversationRecall] No relevant conversation context found in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
    return null;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:ConversationRecall] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

function stripConversationContextEnvelope(response: string): string {
  const trimmed = response.trim();
  if (/^<conversation_recall_context\s*\/>$/i.test(trimmed)) return '';
  const match = /<conversation_recall_context>\s*([\s\S]*?)\s*<\/conversation_recall_context>/i.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

// ============================================================================
// OBSERVATION WRITER AGENT
// ============================================================================

async function runObservationAgent(state: BaseThreadState): Promise<void> {
  const startTime = Date.now();

  try {
    // Load observation count from the DB table for logging.
    // The agent itself uses search_observations / list_observations tools —
    // we don't need to pre-load and pass the full blob anymore.
    let existingCount = 0;
    try {
      const rows = await ObservationsModel.listActive(undefined, 1000);
      existingCount = rows.length;
    } catch {
      // Table may not exist yet on first boot (migration pending). Proceed anyway;
      // the tools will surface the same error gracefully.
    }

    const { graph, state: subState, threadId } = await GraphRegistry.createObservationAgent(state);
    console.log(`[SubconsciousMiddleware:ObservationWriter] Started | threadId: ${ threadId } | active observations: ${ existingCount }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 20 });

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;

    // The writer agent applies side effects via add/remove tools that write
    // directly to the observations DB table. No state merge needed.
    console.log(`[SubconsciousMiddleware:ObservationWriter] Completed in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
  } catch (error) {
    console.error(`[SubconsciousMiddleware:ObservationWriter] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
}

// ============================================================================
// OBSERVATION RECALL AGENT
// ============================================================================

async function runObservationRecall(state: BaseThreadState): Promise<string | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createObservationRecall(state);
    console.log(`[SubconsciousMiddleware:ObservationRecall] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 10 });

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;

    // Extract the structured response from AGENT_DONE (same pattern as memory-recall).
    const response = agentMeta.response;

    if (response && typeof response === 'string' && response.trim()) {
      console.log(`[SubconsciousMiddleware:ObservationRecall] Returning ${ response.length } chars in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
      return response.trim();
    }

    console.log(`[SubconsciousMiddleware:ObservationRecall] No relevant observations in ${ Date.now() - startTime }ms | iterations: ${ iterations }, tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
    return null;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:ObservationRecall] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
