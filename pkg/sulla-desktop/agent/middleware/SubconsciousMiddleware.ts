// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * SubconsciousMiddleware — the work around the main agent's LLM call.
 *
 * PRE-TURN (awaited, no memory LLM calls):
 *   - v7 subject-memory recall (deterministic) -> brainMemoryContext
 *   - team, installed-skill and subagent-directory hints (table reads)
 *   - background Conversational Summarizer / Tool-Result Digester, applied
 *     at the next turn boundary
 *
 * POST-TURN (fire-and-forget, through the process-wide writer gate):
 *   - v7 memory: elephant draft -> goldfish review (once) -> elephant final.
 *     Two agents, at most three model calls per turn, single-flight per
 *     conversation. See memory/V7MemoryTurnPipeline.ts.
 *
 * The legacy observation/identity memory agents (observation writer, seven
 * identity observers, conversation writer and their per-domain recalls) are
 * gone; their tables stay for the scheduled dreamer and existing tools.
 */

import { getAgentOverrideService, getPrimaryService, getSubconsciousService } from '../languagemodels';
import { isCliManagedLoop } from '../languagemodels/BaseLanguageModel';
import { resolveModelSlot } from '../languagemodels/modelSlotRouting';
import { v7MemoryScheduler } from '../memory/V7MemoryAgents';
import { recallV7SubjectMemory } from '../memory/V7SubjectMemory';
import { GraphRegistry, type DigestibleToolResult } from '../services/GraphRegistry';
import { resolveAgentIdentity } from '../utils/agentIdentity';
import { latestUserText } from '../utils/latestUserText';
import { stripTurnContext } from '../prompts/turnContext';

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

/** New messages required before another background maintenance pass. */
const BACKGROUND_RETRIGGER_GROWTH = 10;

interface BackgroundResult {
  kind:         'summarizer' | 'digester';
  snapshotLen:  number;
  fingerprints: string[];
  messages:     any[] | null;
}

interface BackgroundThreadState {
  inFlight:       Promise<void> | null;
  pending:        BackgroundResult | null;
  growthSinceRun: number;
  lastObservedLen: number;
  hasRun:         boolean;
}

const backgroundByThread = new Map<unknown, BackgroundThreadState>();

function backgroundStateFor(state: BaseThreadState): BackgroundThreadState {
  const meta = state.metadata as any;
  const key = meta.threadId || meta.conversationId || state;
  let background = backgroundByThread.get(key);
  if (!background) {
    background = { inFlight: null, pending: null, growthSinceRun: 0, lastObservedLen: state.messages.length, hasRun: false };
    backgroundByThread.set(key, background);
  }
  return background;
}

function messageFingerprint(message: any): string {
  try {
    const normalized = JSON.parse(JSON.stringify(message));
    if (typeof normalized?.content === 'string') {
      normalized.content = stripTurnContext(normalized.content);
    } else if (Array.isArray(normalized?.content)) {
      normalized.content = normalized.content.map((block: any) =>
        block?.type === 'text' ? { ...block, text: stripTurnContext(block.text) } : block);
    }
    return JSON.stringify(normalized);
  } catch {
    return String(message);
  }
}

function stableMessages(messages: any[]): any[] {
  return messages.filter(message => message?.metadata?.source !== 'subconscious_context');
}

/** Apply completed work only at a pre-turn boundary, never during a provider call. */
function applyPendingBackground(state: BaseThreadState, background: BackgroundThreadState): void {
  background.growthSinceRun += Math.max(0, state.messages.length - background.lastObservedLen);
  background.lastObservedLen = state.messages.length;
  const pending = background.pending;
  if (!pending) return;
  background.pending = null;

  const stableLive = stableMessages(state.messages);
  const prefixUnchanged = stableLive.length >= pending.snapshotLen &&
    pending.fingerprints.every((fingerprint, index) => messageFingerprint(stableLive[index]) === fingerprint);
  if (prefixUnchanged && pending.messages) {
    const liveTail = stableLive.slice(pending.snapshotLen);
    state.messages.splice(0, state.messages.length, ...pending.messages, ...liveTail);
    if (pending.kind === 'summarizer') (state.metadata as any).v7LedgerSummarizedAt = Date.now();
    console.log(`[SubconsciousMiddleware:${ pending.kind }] Applied pending result at turn boundary | snapshot: ${ pending.snapshotLen }, live tail: ${ liveTail.length }, messages: ${ state.messages.length }`);
  } else if (!prefixUnchanged) {
    console.log(`[SubconsciousMiddleware:${ pending.kind }] Discarded pending result — snapshotted prefix changed`);
  }
  background.lastObservedLen = state.messages.length;
}

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

/**
 * Same provider resolution as BaseNode.resolveLoopProvider. A failed lookup
 * counts as not CLI-managed, which keeps Sulla's own context management on.
 */
async function isCliManagedThread(state: BaseThreadState): Promise<boolean> {
  try {
    const meta = state.metadata as any;
    const provider = await getAgentOverrideService(meta.agent) ??
      (resolveModelSlot(meta) === 'subconscious' ? await getSubconsciousService() : await getPrimaryService());
    return isCliManagedLoop(provider);
  } catch {
    return false;
  }
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
  const inputSource = String(meta.inputSource || '');
  const voiceTurn = inputSource === 'microphone' || inputSource === 'voice';
  if (meta.workflowNodeId || meta.activeWorkflow || meta.scopedWorkflowId) {
    console.log('[SubconsciousMiddleware] Skipped — running inside a workflow');
    return;
  }

  const conversationalistVoice = String(meta.agentId || meta.wsChannel || '') === 'conversationalist'
    && (inputSource === 'microphone' || inputSource === 'voice');
  // Conversationalist voice keeps memory/observation recall. It skips only
  // team, skill-catalog and subagent-roster hints; this is an explicit,
  // reversible latency trade-off for Jonathon to veto.

  const startTime = Date.now();
  for (const key of ['observationContext', 'userObservationContext', 'selfObservationContext', 'businessObservationContext', 'environmentObservationContext', 'projectsObservationContext', 'worldObservationContext', 'skillsObservationContext']) meta[key] = '';
  meta.teamDirectoryContext = '';
  meta.skillRecallContext = '';
  meta.subagentDirectoryContext = '';
  meta.brainMemoryContext = '';

  const launched: string[] = [];
  const skipped: string[] = [];
  const awaitedTasks: Promise<void>[] = [];
  const background = backgroundStateFor(state);
  applyPendingBackground(state, background);

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
      perf.log(`[SubconsciousTaskTiming] threadId=${ meta.threadId } task=${ name } durationMs=${ timings[name] }`);
      progress(`${ label } done (${ ((Date.now() - t0) / 1000).toFixed(1) }s)`);
    });
  };
  // Recall workers share a private snapshot; merge only after the complete
  // parallel fan-out finishes so none can race with the model hand-off.
  const recallState = { ...state, messages: [...state.messages], metadata: { ...meta } } as BaseThreadState;
  const recallMeta = recallState.metadata as any;

  // 1. Conversation maintenance is deliberately off the critical path. A
  // single per-thread worker snapshots the prefix, and its result is applied
  // at the next pre-turn boundary. Ten newly appended messages are required
  // before another run, preventing threshold-hovering threads from re-firing.
  // CLI-managed loops (Claude Code, Codex, other CLIs) own their session and
  // context window, so Sulla never summarizes or digests their history.
  const cliManagedLoop = await isCliManagedThread(state);
  const shouldSummarize = !cliManagedLoop && state.messages.length > TRIGGER_WINDOW_SIZE;

  // 1b. Tool-Result Digester — triggered by compactable TOKEN MASS, not
  //     message count (background: produces a pending batch). Only stale tool results
  //     outside the last DIGEST_PROTECTED_RECENT_TURNS assistant turns and
  //     not already digested count toward the trigger. See
  //     DIGEST_TRIGGER_TOKEN_MASS for why this fires in batches.
  const digestPlan = collectDigestibleToolResults(state);
  const backgroundKind = shouldSummarize ? 'summarizer' :
    !cliManagedLoop && digestPlan.estTokens >= DIGEST_TRIGGER_TOKEN_MASS ? 'digester' : null;
  const canLaunchBackground = !background.inFlight &&
    (!background.hasRun || background.growthSinceRun >= BACKGROUND_RETRIGGER_GROWTH);
  if (backgroundKind && canLaunchBackground) {
    launched.push(`${ backgroundKind }-background`);
    const snapshotMessages = stableMessages(state.messages);
    const snapshotLen = snapshotMessages.length;
    const fingerprints = snapshotMessages.map(messageFingerprint);
    const snapshotState = {
      ...state,
      messages: JSON.parse(JSON.stringify(snapshotMessages)),
      metadata: { ...(state.metadata as any) },
    } as BaseThreadState;
    background.hasRun = true;
    background.growthSinceRun = 0;
    const bgStart = Date.now();
    const task = (async() => {
      const messages = backgroundKind === 'summarizer'
        ? await runSummarizer(snapshotState)
        : await runToolResultDigester(snapshotState, collectDigestibleToolResults(snapshotState).eligible);
      background.pending = { kind: backgroundKind, snapshotLen, fingerprints, messages };
    })().catch(error => {
      console.error(`[SubconsciousMiddleware:${ backgroundKind }] Background task failed:`, error instanceof Error ? error.message : error);
    }).finally(() => {
      perf.log(`[SubconsciousBackground] threadId=${ (state.metadata as any).threadId } task=${ backgroundKind } durationMs=${ Date.now() - bgStart } snapshotMsgs=${ snapshotLen }`);
      background.inFlight = null;
    });
    background.inFlight = task;
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
  // PRE-TURN = RECALLS ONLY. Memory writers run POST-TURN in
  // runSubconsciousObservationWriters(), after the loop ends, so they observe
  // the COMPLETED exchange and never compete with the reply for the model.

  // Memory recall is v7 subject memory only: one deterministic lookup, no
  // LLM call. The legacy per-domain observation/identity recalls (and the
  // 'sql' / 'agent' / 'ranked' recall modes) were removed; any stored
  // subconsciousRecallMode value now behaves as v7.
  if (options.includeObservations && analyzable) {
    launched.push('v7-subject-memory');
    const threadId = String(meta.threadId || meta.conversationId || 'unknown');
    // A provider compaction or Sulla summary means the model no longer holds
    // the earlier injection, so clear this conversation's sent ledger.
    const reset = Boolean(meta.cliCompactedAt && meta.v7LedgerCompactedAt !== meta.cliCompactedAt) || Boolean(meta.v7LedgerSummarizedAt && meta.v7LedgerSummarizedAt !== meta.lastV7LedgerSummaryReset);
    awaitedTasks.push(timed('v7-subject-memory', 'Recalling subject memory', recallV7SubjectMemory(recentUserTexts(recallState, 3), threadId, reset).then(block => {
      recallMeta.observationContext = '';
      recallMeta.userObservationContext = '';
      recallMeta.selfObservationContext = '';
      recallMeta.businessObservationContext = '';
      recallMeta.environmentObservationContext = '';
      recallMeta.projectsObservationContext = '';
      recallMeta.worldObservationContext = '';
      recallMeta.skillsObservationContext = '';
      recallMeta.brainMemoryContext = block || '';
      if (reset) { recallMeta.v7LedgerCompactedAt = recallMeta.cliCompactedAt; recallMeta.lastV7LedgerSummaryReset = recallMeta.v7LedgerSummarizedAt }
    }).catch((error) => {
      // Never fall back silently to the previous turn's observation blocks.
      console.warn('[SubconsciousMiddleware] v7 subject-memory recall failed:', error instanceof Error ? error.message : error);
      recallMeta.observationContext = '';
      recallMeta.brainMemoryContext = '';
    })));
  }

  // R10. Team recall — lead agents (non-empty can_call) get a Team directory
  // ranked by the current situation (plus the shared "Calling your team"
  // section when their prompt lacks it), injected as <team_directory>.
  // Keyword ranking over one table read: no LLM call, bounded size. It
  // suggests; the lead agent decides.
  const teamAgentSlug = resolveAgentIdentity(state.metadata);
  if (teamAgentSlug && conversationalistVoice) skipped.push('team-recall');
  if (teamAgentSlug && !conversationalistVoice) {
    launched.push('team-recall');
    awaitedTasks.push(timed('team-recall', 'Recalling team', runTeamRecall(recallState, teamAgentSlug)));
  }

  // R12. Skill recall — installed skills (skill_definitions) whose title,
  // triggers, tags or description match the current turn, injected as
  // <installed_skills>. Keyword ranking over one table read: no LLM call.
  // It suggests; the agent decides whether to load one.
  if (options.includeObservations && analyzable && conversationalistVoice) skipped.push('skill-recall');
  if (options.includeObservations && analyzable && !conversationalistVoice) {
    launched.push('skill-recall');
    awaitedTasks.push(timed('skill-recall', 'Recalling skills', runSkillRecall(recallState)));
  }

  // R11. Subagent directory — any agent with children on this thread sees each
  // child (hidden or tab), its last check-in, stalls and unprocessed results,
  // injected as <subagent_directory>. Job-table read only: no LLM call.
  if (typeof meta.threadId === 'string' && meta.threadId && conversationalistVoice) skipped.push('subagent-directory');
  if (typeof meta.threadId === 'string' && meta.threadId && !conversationalistVoice) {
    launched.push('subagent-directory');
    awaitedTasks.push(timed('subagent-directory', 'Checking subagents', runSubagentDirectory(recallState)));
  }

  console.log(`[SubconsciousMiddleware] Launched (pre-turn recalls): ${ launched.join(', ') } | messages: ${ state.messages.length }`);

  // Recall is intentionally unbounded per Jonathon's standing rule. Wait for
  // every requested recall to finish; independent tasks still run in parallel.
  const settledResults = await Promise.allSettled(awaitedTasks);
  const contextKeys = ['observationContext', 'userObservationContext', 'selfObservationContext', 'businessObservationContext', 'environmentObservationContext', 'projectsObservationContext', 'worldObservationContext', 'skillsObservationContext', 'brainMemoryContext', 'teamDirectoryContext', 'skillRecallContext', 'subagentDirectoryContext', 'v7LedgerCompactedAt', 'lastV7LedgerSummaryReset'];
  for (const key of contextKeys) meta[key] = recallMeta[key];
  const failures = settledResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
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
  perf.log(`[SubconsciousTiming] threadId=${ (state.metadata as any).threadId } totalMs=${ elapsed } launched=[${ launched.join(', ') }] skipped=[${ skipped.join(', ') }] timings=[${ breakdown }] obsChars=${ obsRecallLen }`);
}

/**
 * POST-TURN memory. AgentNode / HeartbeatNode invoke this AFTER the loop ends,
 * so the writers observe the COMPLETED exchange. Fire-and-forget: the reply is
 * already out, so this adds zero turn latency and never touches state.messages.
 *
 * Per turn this launches at most:
 *   - the v7 memory sequence (elephant draft -> goldfish -> elephant final),
 *     single-flight per conversation and bounded by the writer gate.
 *
 * Skipped inside workflows (same gate as the pre-turn pass) and when the turn
 * carried no analyzable user message.
 */
export function runSubconsciousObservationWriters(
  state: BaseThreadState,
  options: { includeObservations: boolean },
): void {
  const meta = state.metadata as any;
  if (meta.workflowNodeId || meta.activeWorkflow || meta.scopedWorkflowId) {
    return; // inside a workflow — writers stay off, same as the recall pass
  }
  if (!hasAnalyzableUserMessage(state)) return;

  if (!options.includeObservations) return;

  const threadId = String(meta.threadId || meta.conversationId || '');
  if (!threadId) return;
  v7MemoryScheduler.submit(threadId, state, String(meta.turnId || `m${ state.messages.length }`));
}


// ============================================================================
// SUMMARIZER
// ============================================================================

async function runSummarizer(state: BaseThreadState): Promise<any[] | null> {
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

      console.log(`[SubconsciousMiddleware:Summarizer] Produced result in ${ Date.now() - startTime }ms | deleted: ${ deletedCount }, summarized: ${ summarizedCount }, messages: ${ messagesBefore } → ${ compressedMessages.length }`);
      return compressedMessages;
    } else {
      console.log(`[SubconsciousMiddleware:Summarizer] No changes in ${ Date.now() - startTime }ms`);
    }
  } catch (error) {
    console.error(`[SubconsciousMiddleware:Summarizer] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
  return null;
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
 * Runs against a private snapshot. The completed batch is applied at the next
 * pre-turn boundary so it can never rewrite the prompt under a provider call.
 *
 * Replacements are looked up by tool_use_id over the private snapshot (not
 * via references captured at collection time), then the entire batch becomes
 * one pending prefix replacement.
 *
 * NOTE (claude-code provider): when the primary agent runs through the
 * claude-code provider with --resume, conversation history lives inside the
 * Claude Code session, not in state.messages — there, this compaction only
 * takes effect when a session is re-seeded/rehydrated (intentionally NOT
 * implemented here). It still benefits the anthropic provider path
 * immediately and shrinks the BaseNode pre-flight token budget on every
 * provider.
 */
async function runToolResultDigester(state: BaseThreadState, eligible: DigestibleToolResult[]): Promise<any[] | null> {
  const startTime = Date.now();

  try {
    const { graph, state: subState, threadId } = await GraphRegistry.createToolResultDigester(state, eligible);
    console.log(`[SubconsciousMiddleware:Digester] Started | threadId: ${ threadId } | eligible: ${ eligible.length } tool results`);

    await graph.execute(subState, 'subconscious', { maxIterations: 1 });

    const digests = (subState.metadata as any).toolResultDigests as Map<string, string> | undefined;
    if (!digests || digests.size === 0) {
      console.log(`[SubconsciousMiddleware:Digester] No digests produced in ${ Date.now() - startTime }ms`);
      return null;
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
    return state.messages;
  } catch (error) {
    console.error(`[SubconsciousMiddleware:Digester] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
  return null;
}

/**
 * Recent real user texts, newest first (subconscious-injected turns skipped).
 * Recall terms come from these so a short follow-up ("continue", "do it")
 * still inherits the topic of the turns before it.
 */
function recentUserTexts(state: BaseThreadState, count: number): string[] {
  const out: string[] = [];

  for (let i = state.messages.length - 1; i >= 0 && out.length < count; i--) {
    const m: any = state.messages[i];

    if (m?.role !== 'user' || m?.metadata?.source === 'subconscious') continue;
    const c = m.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';

    if (text.trim()) out.push(text.trim());
  }

  return out;
}

/** Best effort: a query failure just means no team block this turn. */
async function runTeamRecall(state: BaseThreadState, agentSlug: string): Promise<void> {
  try {
    const [{ buildTeamRecallContext }, { IpcUseCaseSuggestionQuery }] = await Promise.all([
      import('../services/AgentTeamRecall'), import('../services/UseCaseSuggestionQueryClient'),
    ]);
    const { resolveAgentDepth } = await import('../tools/agents/jobRegistry');
    // Lazy: the renderer IPC bridge only exists inside the app, so loading this middleware must not require it.
    const { ipcRenderer } = await import('@pkg/utils/ipcRenderer');
    const meta = state.metadata as any;
    (state.metadata as any).teamDirectoryContext = await buildTeamRecallContext({
      agentSlug,
      text:  latestUserText(state.messages),
      depth: await resolveAgentDepth(meta.subAgentDepth, meta.threadId),
    }, new IpcUseCaseSuggestionQuery(ipcRenderer as any));
  } catch (err) {
    console.warn('[SubconsciousMiddleware] team recall failed:', err instanceof Error ? err.message : err);
  }
}

/** Best effort: a suggestion query failure just means no installed-skills block this turn. */
async function runSkillRecall(state: BaseThreadState): Promise<void> {
  try {
    const [{ SkillRecallService }, { IpcUseCaseSuggestionQuery }] = await Promise.all([
      import('../services/SkillRecall'), import('../services/UseCaseSuggestionQueryClient'),
    ]);
    const { ipcRenderer } = await import('@pkg/utils/ipcRenderer');
    (state.metadata as any).skillRecallContext = await new SkillRecallService(new IpcUseCaseSuggestionQuery(ipcRenderer as any))
      .buildContext(recentUserTexts(state, 2).join('\n'));
  } catch (err) {
    console.warn('[SubconsciousMiddleware] skill recall failed:', err instanceof Error ? err.message : err);
  }
}

/** Best effort: a job read failure just means no subagent block this turn. */
async function runSubagentDirectory(state: BaseThreadState): Promise<void> {
  try {
    const { buildSubagentDirectoryContext } = await import('../services/SubagentDirectory');
    (state.metadata as any).subagentDirectoryContext = await buildSubagentDirectoryContext((state.metadata as any).threadId);
  } catch (err) {
    console.warn('[SubconsciousMiddleware] subagent directory failed:', err instanceof Error ? err.message : err);
  }
}
