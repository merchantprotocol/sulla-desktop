/**
 * EpisodicScribe — the WRITE side of episodic memory (#518).
 *
 * Fires fire-and-forget when a conversation (episode) completes — from the
 * Graph.ts completion hook, covering all three sources (heartbeat cycles,
 * sub-agents, human desktop chats). Reads the whole episode and encodes it into
 * knowledge-graph nodes/aliases/links so the Recall agent has something to land
 * on. Mirrors the observation-writer lifecycle: fire-and-forget, soft-archive
 * only, never blocks the turn.
 *
 * Gating lives here (and at the hook) so chit-chat mints nothing:
 *   - Skip subconscious threads entirely (no recursion — the Scribe must never
 *     fire on Scribe/Recall/summarizer runs).
 *   - Work floor: only encode episodes with real work (≥1 tool call OR
 *     ≥ MIN_MESSAGES messages).
 */

import { GraphRegistry } from '../services/GraphRegistry';

import type { BaseThreadState } from '../nodes/Graph';

/** Below this message count AND with no tool calls, an episode is chit-chat. */
const MIN_MESSAGES = 4;

/** A subconscious thread never triggers the Scribe (matches issue #518). */
export function isSubconsciousThread(threadId: unknown): boolean {
  return typeof threadId === 'string' && threadId.startsWith('subconscious_');
}

/** True when the episode carries enough real work to be worth encoding. */
export function meetsEpisodeWorkFloor(state: BaseThreadState): boolean {
  const messages = (state.messages ?? []) as any[];

  let realMessages = 0;
  let toolCalls = 0;
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    if ((m?.metadata as any)?.source === 'subconscious') continue;
    realMessages++;
    if (Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use')) toolCalls++;
  }

  return toolCalls >= 1 || realMessages >= MIN_MESSAGES;
}

/**
 * Run the Scribe over a completed episode. Fire-and-forget — callers must NOT
 * await this on the turn's critical path; it writes to the graph via tools and
 * never mutates the parent state.
 */
export async function runEpisodicScribe(state: BaseThreadState): Promise<void> {
  const startTime = Date.now();
  const threadId = (state.metadata as any)?.threadId;

  // Guard 1: never recurse on subconscious runs.
  if (isSubconsciousThread(threadId)) return;

  // Guard 2: work floor — chit-chat mints nothing.
  if (!meetsEpisodeWorkFloor(state)) {
    console.log(`[EpisodicScribe] Skipped — below work floor | threadId: ${ threadId }`);
    return;
  }

  try {
    const { graph, state: subState, threadId: scribeThreadId } = await GraphRegistry.createEpisodicScribe(state);
    console.log(`[EpisodicScribe] Started | episode: ${ threadId } | scribe: ${ scribeThreadId }`);

    await graph.execute(subState, 'subconscious', { maxIterations: 10 });

    const agentMeta = (subState.metadata as any).agent || {};
    const toolCalls = subState.messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'tool_use'),
    ).length;
    console.log(`[EpisodicScribe] Completed in ${ Date.now() - startTime }ms | tool_calls: ${ toolCalls }, status: ${ agentMeta.status }`);
  } catch (error) {
    console.error(`[EpisodicScribe] Failed in ${ Date.now() - startTime }ms:`, error instanceof Error ? error.message : error);
  }
}
