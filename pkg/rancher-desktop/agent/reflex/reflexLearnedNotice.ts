/**
 * Visible learning — when Reflex gains a training example from a live
 * conversation (the post-turn Reflex Trainer, reflex_teach, reflex_correct),
 * drop a small notice into that conversation:
 *
 *   ⚡ Learned: "pull up the PM system" → Open Projects   [Undo]
 *
 * Undo archives exactly the examples the notice announced (reflex:forget IPC
 * → ReflexModel.forget). Seed and bulk imports never announce: the seeder
 * bypasses teachExample entirely, and import-like sources or large batches
 * are filtered here.
 *
 * The notice rides the `subconscious_message` wire type so a post-turn
 * writer can post it after the turn finished without reopening the run in
 * the UI (MessageDispatcher only flips graphRunning for other types).
 */

import type { ReflexExampleRow } from '../database/models/ReflexModel';

import { REFLEX_NONE } from './ReflexEngine';
import { reflexActionLabel } from './reflexLabels';

/** The trainer teaches the human's words plus up to 3 paraphrases; anything bigger is an import. */
export const MAX_ANNOUNCED_BATCH = 5;

const SILENT_SOURCE_RE = /seed|import|bulk|augment|export|backfill|migrat/i;

export interface ReflexNoticeTarget {
  wsChannel: string;
  threadId:  string;
}

export interface ReflexLearnedPayload {
  utterance:  string;
  toolName:   string;
  params:     Record<string, unknown>;
  positive:   boolean;
  /** Human label for the action, e.g. "Open Projects". */
  label:      string;
  /** Every example this notice announces — Undo archives all of them. */
  exampleIds: string[];
  /** How many of those are extra phrasings of the same action. */
  extraPhrasings: number;
  source:     string;
}

/** Whether a write of `batchSize` examples from `source` should be announced. */
export function shouldAnnounceReflexLearning(source: string, batchSize: number): boolean {
  if (SILENT_SOURCE_RE.test(source)) return false;
  return batchSize > 0 && batchSize <= MAX_ANNOUNCED_BATCH;
}

/**
 * The conversation a tool call belongs to. Subconscious writers (the Reflex
 * Trainer) run on their own thread but carry their parent's channel/thread;
 * primary-agent calls (CLI with a tool session) carry their own.
 */
export function reflexNoticeTarget(state: unknown): ReflexNoticeTarget | null {
  const meta = (state as any)?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const wsChannel = String(meta.parentWsChannel || meta.wsChannel || '').trim();
  const threadId = String(meta.parentConversationId || meta.threadId || '').trim();
  return wsChannel && threadId ? { wsChannel, threadId } : null;
}

/**
 * Build the notice for the examples one call actually created (rows that
 * were "already known" are not news). The first created positive row is the
 * headline; a correction that only recorded a counter-example still
 * announces it as "won't run".
 */
export function buildReflexLearnedPayload(created: ReflexExampleRow[], source: string): ReflexLearnedPayload | null {
  if (!created.length) return null;
  const head = created.find(r => r.positive && r.tool_name !== REFLEX_NONE) ?? created[0];
  const sameAction = created.filter(r => r.id !== head.id && r.tool_name === head.tool_name && r.positive === head.positive);
  const params = head.params ?? {};
  const label = head.tool_name === REFLEX_NONE
    ? 'do nothing'
    : head.positive ? reflexActionLabel(head.tool_name, params) : `won't run ${ reflexActionLabel(head.tool_name, params) }`;
  return {
    utterance:      head.utterance,
    toolName:       head.tool_name,
    params,
    positive:       head.positive,
    label,
    exampleIds:     created.map(r => r.id),
    extraPhrasings: sameAction.length,
    source,
  };
}

export function formatReflexLearned(p: ReflexLearnedPayload): string {
  const quoted = p.utterance.length > 80 ? `${ p.utterance.slice(0, 77) }…` : p.utterance;
  const extra = p.extraPhrasings > 0 ? ` (+${ p.extraPhrasings } phrasing${ p.extraPhrasings === 1 ? '' : 's' })` : '';
  return `⚡ Learned: "${ quoted }" → ${ p.label }${ extra }`;
}

/**
 * Post the notice to the originating conversation. Best-effort and never
 * throws — a missing notice must never fail the training write.
 */
export async function announceReflexLearned(
  state: unknown,
  created: ReflexExampleRow[],
  meta: { source: string; batchSize: number },
): Promise<boolean> {
  try {
    if (!shouldAnnounceReflexLearning(meta.source, meta.batchSize)) return false;
    const target = reflexNoticeTarget(state);
    const payload = buildReflexLearnedPayload(created, meta.source);
    if (!target || !payload) return false;

    const { getWebSocketClientService } = await import('../services/WebSocketClientService');
    return await getWebSocketClientService().send(target.wsChannel, {
      type: 'subconscious_message',
      data: {
        content:       formatReflexLearned(payload),
        role:          'assistant',
        kind:          'reflex_learned',
        thread_id:     target.threadId,
        timestamp:     Date.now(),
        isSubconscious: true,
        reflexLearned: payload,
      },
    });
  } catch (err) {
    console.warn('[Reflex] learned notice failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
