/**
 * SubconsciousMiddleware — pre-processing step before the main agent LLM call.
 *
 * Launches up to 4 parallel subconscious graphs:
 * 1. Conversational Summarizer — compresses/deletes old messages
 * 2. Observation Writer Agent — writes/archives observational memories (fire-and-forget)
 * 3. Observation Recall Agent — surfaces relevant observations for context injection
 * 4. Tool-Result Digester — compresses stale tool_result blocks into
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
import { formatDateOnly } from '../utils/formatDateOnly';

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
    if (m?.metadata?.source === 'subconscious') return false;
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
  // starting it late (Jonathon, 2026-07-06).
  //
  // 2026-08-19 subconscious prune (docs/user-observation-subsystem-PRD.md):
  // Environment Brief, Episodic Recall, Security Conscience, and Conversation
  // Recall were removed — they didn't perform reliably. The retained recall is
  // the general Observation Writer + Observation Recall below, plus the focused
  // domain observers (human first) dispatched alongside them.

  // PRE-TURN = RECALLS ONLY. The observation WRITERS (general writer + domain
  // domain identity observers) moved to a POST-TURN pass:
  // runSubconsciousObservationWriters(), which AgentNode invokes after the loop
  // ends. Two reasons: (1) a writer that runs before the turn can only see up to
  // the user's message — it misses the agent's response, the tools it ran, and
  // any mid-turn correction; running after the loop lets each writer observe the
  // COMPLETED exchange. (2) Writers no longer compete with recall for the shared
  // model during the latency-critical prelude. Recalls MUST stay here — they
  // inform the reply, so they run before it. Recalls run in parallel (awaited
  // together below), so adding domains costs ~max(), not sum().

  // R1. Observation Recall — awaited: surfaces relevant observations from the DB
  //     table into state.metadata.observationContext.
  if (options.includeObservations && analyzable) {
    launched.push('observation-recall');
    const obsRecallPromise = runObservationRecall(state);
    awaitedTasks.push(timed('observation-recall', 'Checking observations', obsRecallPromise.then(ctx => { (state.metadata as any).observationContext = ctx })));
  }

  // R2. Identity Observation Recall (human) — awaited: read-only recall of
  //     relevant human-domain rows, injected as <user_observations>. Avoids a
  //     fixed "last N" dump; relevance is turn-dependent.
  if (options.includeObservations && analyzable) {
    launched.push('identity-observation-recall');
    const idRecallPromise = runIdentityObservationRecall(state, 'human');
    awaitedTasks.push(timed('identity-observation-recall', 'Recalling who you are', idRecallPromise.then(ctx => { (state.metadata as any).userObservationContext = ctx })));
  }

  // R3. Self Observation Recall (agent) — awaited: relevant `agent`-domain rows,
  //     injected as <self_observations>.
  if (options.includeObservations && analyzable) {
    launched.push('self-observation-recall');
    const selfRecallPromise = runIdentityObservationRecall(state, 'agent');
    awaitedTasks.push(timed('self-observation-recall', 'Recalling how we work', selfRecallPromise.then(ctx => { (state.metadata as any).selfObservationContext = ctx })));
  }

  // R4. Business Observation Recall (business) — awaited: relevant
  //     `business`-domain rows, injected as <business_observations>.
  if (options.includeObservations && analyzable) {
    launched.push('business-observation-recall');
    const bizRecallPromise = runIdentityObservationRecall(state, 'business');
    awaitedTasks.push(timed('business-observation-recall', 'Recalling the business', bizRecallPromise.then(ctx => { (state.metadata as any).businessObservationContext = ctx })));
  }

  // R5. Environment Observation Recall (environment) — awaited: relevant
  //     `environment`-domain rows, injected as <environment_observations>.
  if (options.includeObservations && analyzable) {
    launched.push('environment-observation-recall');
    const envRecallPromise = runIdentityObservationRecall(state, 'environment');
    awaitedTasks.push(timed('environment-observation-recall', 'Recalling this environment', envRecallPromise.then(ctx => { (state.metadata as any).environmentObservationContext = ctx })));
  }

  // R6. Projects Observation Recall (projects) — awaited: relevant
  //     `projects`-domain rows, injected as <projects_observations>.
  if (options.includeObservations && analyzable) {
    launched.push('projects-observation-recall');
    const projRecallPromise = runIdentityObservationRecall(state, 'projects');
    awaitedTasks.push(timed('projects-observation-recall', 'Recalling the projects', projRecallPromise.then(ctx => { (state.metadata as any).projectsObservationContext = ctx })));
  }

  // R7. World Observation Recall (world) — awaited: relevant `world`-domain
  //     rows, injected as <world_observations>. Jonathon (2026-08-19): world
  //     context (external events touching the human / Sulla / the business) is
  //     important on every turn, so it recalls pre-turn like the other domains
  //     rather than being written-only.
  if (options.includeObservations && analyzable) {
    launched.push('world-observation-recall');
    const worldRecallPromise = runIdentityObservationRecall(state, 'world');
    awaitedTasks.push(timed('world-observation-recall', 'Recalling the world', worldRecallPromise.then(ctx => { (state.metadata as any).worldObservationContext = ctx })));
  }

  // R8. Conversation Reader — NOT YET dispatched here. runConversationReader()
  // (below) and its GraphRegistry.createConversationReader graph are built and
  // ready — surfacing relevant prior conversation content into
  // <conversation_context> the same way R1-R7 surface observations — but
  // registering it into this parallel fan-out (a `launched.push(...)` /
  // `awaitedTasks.push(timed(...))` pair setting
  // `state.metadata.conversationContext`) is deliberately deferred to Sulla
  // Projects task drqq ("Wire Conversation Writer + Reader into GraphRegistry
  // subconscious fan-out"), so it can be reviewed/landed as its own change.

  console.log(`[SubconsciousMiddleware] Launched (pre-turn recalls): ${ launched.join(', ') } | messages: ${ state.messages.length }`);

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

  const obsRecallLen = ((state.metadata as any).observationContext || '').length;
  console.log(`[SubconsciousMiddleware] Complete in ${ elapsed }ms | ${ settledResults.length - failures.length }/${ settledResults.length } succeeded | observationContext: ${ obsRecallLen } chars`);

  // Perf: total blocking prelude + per-sub-agent breakdown (which one dominates).
  const breakdown = Object.entries(timings).map(([n, ms]) => `${ n }=${ ms }ms`).join(', ');
  perf.log(`[SubconsciousTiming] threadId=${ (state.metadata as any).threadId } totalMs=${ elapsed } launched=[${ launched.join(', ') }] timings=[${ breakdown }] obsChars=${ obsRecallLen }`);
}

/**
 * POST-TURN observation WRITERS. AgentNode invokes this AFTER the loop ends, so
 * each writer observes the COMPLETED exchange (the user's message + the agent's
 * response + the tools it ran + any mid-turn correction) instead of the pre-turn
 * state. All fire-and-forget: the user-facing response has already been
 * dispatched, so these add zero turn latency, never touch state.messages, and no
 * longer compete with recall for the shared model during the prelude.
 *
 * Skipped inside workflows (same gate as the pre-turn recall pass) and when the
 * turn carried no analyzable user message. Six writers, each scoped to write
 * only its own domain:
 *   - general Observation Writer   → observation + Projects work-state rows
 *   - Identity Observer  human      → the human user
 *   - Self Observer      agent      → Sulla + how this pair works together
 *   - Business Observer  business   → the human's business/employment
 *   - World Observer      world     → external events relevant to us (gated)
 *   - Environment Observer environment → this install/host + repeatable processes
 */
export function runSubconsciousObservationWriters(
  state: BaseThreadState,
  options: { includeObservations: boolean },
): void {
  const meta = state.metadata as any;
  if (meta.workflowNodeId || meta.activeWorkflow || meta.scopedWorkflowId) {
    return; // inside a workflow — writers stay off, same as the recall pass
  }
  if (!options.includeObservations || !hasAnalyzableUserMessage(state)) return;

  const launch = (label: string, run: () => Promise<unknown>): void => {
    Promise.resolve().then(run).catch((error) => {
      console.error(`[SubconsciousMiddleware] Post-turn ${ label } failed (fire-and-forget):`, error instanceof Error ? error.message : error);
    });
  };

  launch('observation-writer', () => runObservationAgent(state));
  launch('identity-observer-human', () => runIdentityObserver(state, 'human'));
  launch('self-observer-agent', () => runIdentityObserver(state, 'agent'));
  launch('business-observer', () => runIdentityObserver(state, 'business'));
  launch('world-observer', () => runIdentityObserver(state, 'world'));
  launch('environment-observer', () => runIdentityObserver(state, 'environment'));
  launch('projects-observer', () => runIdentityObserver(state, 'projects'));
  launch('conversation-writer', () => runConversationWriter(state));

  console.log(`[SubconsciousMiddleware] Post-turn writers launched (observation + human/agent/business/world/environment/projects/conversation-keywords) | messages: ${ state.messages.length }`);
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
// OBSERVATION RECALL — DETERMINISTIC SQL FAST-PATH
// ============================================================================

/**
 * Max observation rows surfaced into <observation_context> per turn.
 * Observations are short, so a tight cap keeps the injection cheap while
 * still covering the handful the primary agent could plausibly need.
 */
const OBSERVATION_RECALL_MAX_ROWS = 8;

/**
 * Pull the text of the most recent REAL user message — the thing recall
 * exists to search against. Walks from the tail, skipping subconscious-
 * injected turns, and returns the joined text of the first user message
 * that carries any (string or text-block) content.
 */
function extractLatestUserText(state: BaseThreadState): string {
  const messages = state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (m?.metadata?.source === 'subconscious') continue;

    const c = m?.content;
    if (typeof c === 'string') {
      if (c.trim()) return c.trim();
      continue;
    }
    if (Array.isArray(c)) {
      const text = c
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * Observation recall used to spin up a full subconscious agent loop (up to
 * 10 LLM iterations) whose entire job was to keyword-search the observations
 * table and filter the hits. That cost 17-120s of BLOCKING prelude while the
 * underlying query runs in 3-17ms. The LLM added relevance filtering, but
 * observations are short and the primary agent is perfectly capable of
 * ignoring an off-topic line — so we trade a little precision for a ~1000x
 * latency win by querying the table directly.
 *
 * We tokenize the latest user message and run ObservationsModel.search
 * (word-level ILIKE, ranked phrase-hit → word-match count → recency),
 * formatting the top rows exactly as the old agent did:
 * `[id] priority date — content`. Returns null when nothing matches so no
 * <observation_context> block is injected.
 *
 * NOTE: this is not time-limited or fenced (per design) — a direct DB query
 * has no loop to cut short; it simply returns as fast as Postgres answers.
 * The old agent graph (GraphRegistry.createObservationRecall) and the
 * search_observations / list_observations tools remain in place for the
 * observation WRITER's dedup path; only the recall dispatch changed.
 */
async function runObservationRecall(state: BaseThreadState): Promise<string | null> {
  const startTime = Date.now();
  const threadId = (state.metadata as any).threadId;

  try {
    const query = extractLatestUserText(state);
    if (!query) {
      console.log('[SubconsciousMiddleware:ObservationRecall] No user text to search — skipped');
      return null;
    }

    const rows = await ObservationsModel.search(query, OBSERVATION_RECALL_MAX_ROWS, false);
    const elapsed = Date.now() - startTime;

    if (!rows || rows.length === 0) {
      perf.log(`[ObservationRecall] threadId=${ threadId } matched=0 ms=${ elapsed } path=sql-fast-path`);
      console.log(`[SubconsciousMiddleware:ObservationRecall] No matching observations in ${ elapsed }ms (sql-fast-path)`);
      return null;
    }

    const response = rows
      .map((r) => `[${ r.id }] ${ r.priority } ${ formatDateOnly(r.created_at) } — ${ r.content }`)
      .join('\n');

    perf.log(`[ObservationRecall] threadId=${ threadId } matched=${ rows.length } chars=${ response.length } ms=${ elapsed } path=sql-fast-path`);
    console.log(`[SubconsciousMiddleware:ObservationRecall] Returning ${ rows.length } observations (${ response.length } chars) in ${ elapsed }ms (sql-fast-path)`);
    return response;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:ObservationRecall] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// IDENTITY OBSERVER (domain-keyed — human first)
// ============================================================================

/**
 * Fire-and-forget writer for one identity domain. Same shape as
 * runObservationAgent: the agent applies its side effects via the
 * add/remove/search/list_identity_observation tools directly against the
 * identity_observations table — no state merge needed.
 */
async function runIdentityObserver(state: BaseThreadState, domain: string): Promise<void> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createIdentityObserver(state, domain);
    console.log(`[SubconsciousMiddleware:IdentityObserver:${ domain }] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 20 });

    const agentMeta = (subState.metadata as any).agent || {};
    const iterations = (subState.metadata as any).iterations || 0;
    console.log(`[SubconsciousMiddleware:IdentityObserver:${ domain }] Completed in ${ Date.now() - startTime }ms | iterations: ${ iterations }, status: ${ agentMeta.status }`);
  } catch (error) {
    console.error(`[SubconsciousMiddleware:IdentityObserver:${ domain }] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
}

/** Fire-and-forget post-episode keyword indexer. */
async function runConversationWriter(state: BaseThreadState): Promise<void> {
  const startTime = Date.now();
  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createConversationWriter(state);
    console.log(`[SubconsciousMiddleware:ConversationWriter] Started | threadId: ${ threadId }`);
    await graph.execute(subState, 'subconscious', { maxIterations: 3 });
    console.log(`[SubconsciousMiddleware:ConversationWriter] Completed in ${ Date.now() - startTime }ms | iterations: ${ (subState.metadata as any).iterations || 0 }`);
  } catch (error) {
    console.error('[SubconsciousMiddleware:ConversationWriter] Failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Read-only recall agent for one identity domain. It searches/listens through
 * identity observations and returns only rows relevant to the current turn.
 * The primary agent blocks on this because the selected rows are injected as
 * <user_observations> before the main response starts.
 */
async function runIdentityObservationRecall(state: BaseThreadState, domain: string): Promise<string | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createIdentityObservationRecall(state, domain);
    console.log(`[SubconsciousMiddleware:IdentityRecall:${ domain }] Started | threadId: ${ threadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 10 });

    const elapsed = Date.now() - startTime;
    const agentMeta = (subState.metadata as any).agent || {};
    const response = typeof agentMeta.response === 'string' ? agentMeta.response.trim() : '';

    if (!response) {
      perf.log(`[IdentityRecall] threadId=${ threadId } domain=${ domain } chars=0 ms=${ elapsed } path=agent`);
      console.log(`[SubconsciousMiddleware:IdentityRecall:${ domain }] No relevant rows in ${ elapsed }ms (agent)`);
      return null;
    }

    perf.log(`[IdentityRecall] threadId=${ threadId } domain=${ domain } chars=${ response.length } ms=${ elapsed } path=agent`);
    console.log(`[SubconsciousMiddleware:IdentityRecall:${ domain }] Returning ${ response.length } chars in ${ elapsed }ms (agent)`);
    return response;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:IdentityRecall:${ domain }] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// CONVERSATION READER
// ============================================================================

/**
 * Read-only recall agent for relevant PRIOR conversation content (as opposed
 * to the current thread's own observations/identity rows). Searches the
 * conversation_keywords DB index and, selectively, the log folder via
 * search_conversation_keywords / search_conversation_logs, then returns
 * compact content for <conversation_context> injection.
 *
 * Exported (rather than module-private like its sibling run* helpers) so it
 * is independently unit-testable and directly callable by the follow-up
 * fan-out registration.
 *
 * NOT YET dispatched from runSubconsciousMiddleware's pre-turn recall pass
 * (R1-R7 above). Wiring an R8 entry there — `launched.push('conversation-
 * reader')` / `awaitedTasks.push(timed('conversation-reader', ...,
 * runConversationReader(state).then(ctx => { state.metadata.conversation
 * Context = ctx })))` — plus adding the matching agent config to the live
 * fan-out is deliberately deferred to Sulla Projects task drqq ("Wire
 * Conversation Writer + Reader into GraphRegistry subconscious fan-out").
 * This function is complete and ready for that task to call.
 */
export async function runConversationReader(state: BaseThreadState): Promise<string | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createConversationReader(state);
    console.log(`[SubconsciousMiddleware:ConversationReader] Started | threadId: ${ threadId }`);

    // No maxIterations cap (default: Graph.execute's 1,000,000 safety
    // ceiling) — per the standing rule this agent must never hard-stop at N
    // iterations. Latency is governed instead by CONVERSATION_READER_PROMPT's
    // "time is of the essence" guidance: default to the cheap DB index,
    // batch searches, and stop as soon as it has enough.
    await graph.execute(subState, 'subconscious');

    const elapsed = Date.now() - startTime;
    const agentMeta = (subState.metadata as any).agent || {};
    const response = typeof agentMeta.response === 'string' ? agentMeta.response.trim() : '';

    if (!response) {
      perf.log(`[ConversationReader] threadId=${ threadId } chars=0 ms=${ elapsed }`);
      console.log(`[SubconsciousMiddleware:ConversationReader] No relevant prior content in ${ elapsed }ms`);
      return null;
    }

    perf.log(`[ConversationReader] threadId=${ threadId } chars=${ response.length } ms=${ elapsed }`);
    console.log(`[SubconsciousMiddleware:ConversationReader] Returning ${ response.length } chars in ${ elapsed }ms`);
    return response;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:ConversationReader] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
