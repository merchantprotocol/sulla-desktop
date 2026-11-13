// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The post-turn memory pipeline (the only post-turn memory writer):
 *
 *   elephant DRAFT  →  goldfish REVIEW (exactly one pass)  →  elephant COMPLETE  →  one append
 *
 * The elephant stores episodic + semantic memory. The goldfish never writes;
 * it reads the transcript and the draft once and returns gaps (missing
 * episodes, vague items, missed durable rules, supersedes, evidence links).
 * The elephant then rewrites the draft into the full memory. When the
 * goldfish finds no gaps the draft is already complete and the third model
 * call is skipped. Exactly one validated append happens per run; if the
 * completed output is rejected by validation the draft is appended instead
 * (a rejected append writes nothing, so this is still a single write).
 *
 * Scheduling (single-flight per conversation, coalescing, bounded queue) is
 * the caller's job: see SubconsciousWriterGate.
 */

import type { ElephantAppendResult } from './V7SubjectMemoryWriter';
import type { MemoryRunLog } from './MemoryRunLog';
import type { BaseThreadState } from '../nodes/Graph';

export type GoldfishGapKind = 'missing_episode' | 'vague' | 'missed_rule' | 'supersede' | 'evidence' | 'other';

export interface GoldfishGap {
  kind:   GoldfishGapKind;
  detail: string;
}

const GAP_KINDS = new Set<GoldfishGapKind>(['missing_episode', 'vague', 'missed_rule', 'supersede', 'evidence', 'other']);
const MAX_GAPS = 20;
const MAX_GAP_DETAIL = 600;

/** The goldfish's one-pass review, parsed defensively from model text. */
export class GoldfishFeedback {
  private constructor(readonly gaps: GoldfishGap[]) {}

  static parse(response: string | null | undefined): GoldfishFeedback | null {
    if (typeof response !== 'string' || !response.trim()) return null;
    const trimmed = response.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    let raw: any;
    try {
      raw = JSON.parse(fenced?.[1] ?? trimmed);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.gaps)) return null;
    const gaps: GoldfishGap[] = [];
    for (const gap of raw.gaps.slice(0, MAX_GAPS)) {
      const detail = typeof gap?.detail === 'string' ? gap.detail.trim().slice(0, MAX_GAP_DETAIL) : '';
      if (!detail) continue;
      const kind = GAP_KINDS.has(gap?.kind) ? gap.kind as GoldfishGapKind : 'other';
      gaps.push({ kind, detail });
    }
    return new GoldfishFeedback(gaps);
  }

  /** Text block handed to the elephant's completion pass. */
  render(): string {
    return this.gaps.map((gap, index) => `${ index + 1 }. [${ gap.kind }] ${ gap.detail }`).join('\n');
  }
}

/** The three model calls. Implementations own their own session cleanup. */
export interface MemoryAgentRunner {
  elephantDraft(state: BaseThreadState): Promise<string | null>;
  goldfishReview(state: BaseThreadState, draft: string): Promise<string | null>;
  elephantComplete(state: BaseThreadState, draft: string, feedback: string): Promise<string | null>;
}

export interface MemoryWriteSink {
  append(output: string): Promise<ElephantAppendResult>;
}

export class MemoryTurnPipeline {
  constructor(
    private readonly agents: MemoryAgentRunner,
    private readonly sink: MemoryWriteSink,
    private readonly log: MemoryRunLog,
    private readonly now: () => number = Date.now,
  ) {}

  async run(state: BaseThreadState): Promise<void> {
    const meta = state.metadata as any;
    const thread = String(meta.threadId || meta.conversationId || '');

    const draft = await this.timed('elephant', 'draft', thread, () => this.agents.elephantDraft(state),
      output => output ? 'drafted' : 'no-output');
    if (!draft) return;

    const feedback = GoldfishFeedback.parse(await this.timed('goldfish', 'review', thread,
      () => this.agents.goldfishReview(state, draft),
      output => {
        const parsed = GoldfishFeedback.parse(output);
        return parsed ? `gaps:${ parsed.gaps.length }` : 'invalid';
      }));

    let final = draft;
    if (feedback && feedback.gaps.length > 0) {
      const completed = await this.timed('elephant', 'complete', thread,
        () => this.agents.elephantComplete(state, draft, feedback.render()),
        output => output ? 'completed' : 'no-output');
      if (completed) final = completed;
    }

    const started = this.now();
    let result = await this.sink.append(final);
    let wrote: 'final' | 'draft' = final === draft ? 'draft' : 'final';
    let completeRejected: string | undefined;
    if (!result.accepted && final !== draft) {
      completeRejected = result.reason || 'rejected';
      result = await this.sink.append(draft);
      wrote = 'draft';
    }
    this.log.record({
      agent:    'elephant',
      phase:    'write',
      thread,
      ms:       this.now() - started,
      outcome:  result.accepted ? 'accepted' : 'rejected',
      wrote,
      episodes: result.episodes,
      items:    result.items,
      evidence: result.evidence,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(completeRejected ? { completeRejected } : {}),
    });
  }

  private async timed(
    agent: 'elephant' | 'goldfish',
    phase: string,
    thread: string,
    call: () => Promise<string | null>,
    describe: (output: string | null) => string,
  ): Promise<string | null> {
    const started = this.now();
    try {
      const output = await call();
      const clean = typeof output === 'string' && output.trim() ? output : null;
      this.log.record({ agent, phase, thread, ms: this.now() - started, outcome: describe(clean) });
      return clean;
    } catch (error) {
      this.log.record({
        agent, phase, thread, ms: this.now() - started, outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
