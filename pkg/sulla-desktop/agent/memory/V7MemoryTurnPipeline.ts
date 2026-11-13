// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Per-turn v7 memory: exactly two agents, at most three model calls.
 *
 *   1. elephant-draft  — the elephant reads the completed transcript and drafts
 *                        {episodes, items, evidence}. Desktop validates it and
 *                        holds it IN MEMORY (nothing is written yet).
 *   2. goldfish        — reviews that draft against the transcript ONCE (single
 *                        call, no tools, JSON only) and returns feedback.
 *   3. elephant-final  — the elephant rewrites the complete memory using the
 *                        feedback. Only this final is appended.
 *
 * Memory is never lost: if goldfish or elephant-final fails, times out or
 * returns invalid data, the validated draft is appended instead. Goldfish is
 * skipped for empty or trivial drafts, and elephant-final is skipped when
 * goldfish raises no issues (the draft IS the final then).
 *
 * V7MemoryScheduler keeps at most one sequence in flight per conversation.
 * Turns that finish meanwhile coalesce into one pending run that reads the
 * LATEST transcript with a window widened to every message since the last
 * successful run (capped), so coalescing does not skip turns.
 */

import { latestUserText } from '../utils/latestUserText';

import type { ElephantAppendResult, ElephantWrite, V7ElephantValidation } from './V7SubjectMemoryWriter';

export type V7MemoryAgent = 'elephant-draft' | 'goldfish' | 'elephant-final';

export interface V7MemoryTurnInput {
  /** Live parent state: the run reads its messages when it starts (latest wins). */
  state:          { messages: any[]; metadata: any };
  threadId:       string;
  turnId:         string;
  /** How many trailing messages the agents see (see V7MemoryScheduler.windowFor). */
  contextWindow:  number;
  /** How many completed turns this run covers (>1 when turns coalesced). */
  coalescedTurns: number;
}

/** Model-facing calls. Each resolves to the raw response text, or null when the model produced none. */
export interface V7MemoryAgents {
  elephantDraft(input: V7MemoryTurnInput, abort: AbortController): Promise<string | null>;
  goldfish(input: V7MemoryTurnInput, draftJson: string, abort: AbortController): Promise<string | null>;
  elephantFinal(input: V7MemoryTurnInput, draftJson: string, feedbackJson: string, abort: AbortController): Promise<string | null>;
}

export interface V7MemoryStore {
  validate(response: string): Promise<V7ElephantValidation>;
  append(write: ElephantWrite): Promise<ElephantAppendResult>;
}

export interface V7MemoryLogEntry {
  agent:   V7MemoryAgent | 'sequence' | 'scheduler';
  thread:  string;
  turn:    string;
  ms:      number;
  outcome: string;
  [key: string]: unknown;
}

/** One structured line per agent run: `[V7Memory] {"agent":…,"thread":…,"turn":…,"ms":…,"outcome":…}`. */
export class V7MemoryRunLog {
  constructor(private readonly sink: (line: string) => void = line => console.log(line)) {}

  write(entry: V7MemoryLogEntry): void {
    try { this.sink(`[V7Memory] ${ JSON.stringify(entry) }`) } catch { /* logging never breaks memory */ }
  }
}

export const GOLDFISH_ISSUE_KINDS = [
  'missing_episode', 'missing_item', 'unsupported_item', 'wrong_item', 'vague_text',
  'missing_keys', 'missing_refs', 'missing_evidence', 'contradiction', 'other',
] as const;

export interface GoldfishIssue {
  kind:   typeof GOLDFISH_ISSUE_KINDS[number];
  target: string | null;
  note:   string;
}

export interface GoldfishFeedback {
  issues: GoldfishIssue[];
}

/** Strict parser for goldfish's JSON. Returns null when the output is not usable feedback. */
export class GoldfishFeedbackParser {
  static readonly MAX_ISSUES = 30;

  parse(response: string | null): GoldfishFeedback | null {
    if (!response) return null;
    let raw: unknown;
    try {
      const trimmed = response.trim();
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      raw = JSON.parse(fenced?.[1] ?? trimmed);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).issues)) return null;
    const kinds = new Set<string>(GOLDFISH_ISSUE_KINDS);
    const issues: GoldfishIssue[] = [];
    for (const value of (raw as any).issues.slice(0, GoldfishFeedbackParser.MAX_ISSUES)) {
      if (!value || typeof value !== 'object') continue;
      const note = typeof value.note === 'string' ? value.note.trim().slice(0, 1000) : '';
      if (!note) continue;
      issues.push({
        kind:   kinds.has(value.kind) ? value.kind : 'other',
        target: typeof value.target === 'string' && value.target.trim() ? value.target.trim().slice(0, 80) : null,
        note,
      });
    }
    return { issues };
  }
}

export type V7MemorySequenceOutcome =
  | 'final'            // elephant-final appended
  | 'draft'            // draft appended as final (trivial, or goldfish found no issues)
  | 'draft-fallback'   // goldfish/elephant-final failed; validated draft appended
  | 'empty'            // nothing to remember
  | 'rejected'         // no valid output at all
  | 'failed';          // the append itself failed

export interface V7MemorySequenceResult {
  outcome: V7MemorySequenceOutcome;
  calls:   number;
  /** True when the transcript span is covered (written, or legitimately empty). */
  covered: boolean;
}

export interface V7MemoryTurnPipelineOptions {
  draftTimeoutMs?:    number;
  goldfishTimeoutMs?: number;
  finalTimeoutMs?:    number;
  /** Latest human text shorter than this, with no items drafted, skips goldfish. */
  trivialTextChars?:  number;
  now?:               () => number;
}

interface StageResult {
  value:   string | null;
  outcome: 'ok' | 'empty' | 'timeout' | 'error';
  ms:      number;
  reason?: string;
}

export class V7MemoryTurnPipeline {
  private readonly draftTimeoutMs: number;
  private readonly goldfishTimeoutMs: number;
  private readonly finalTimeoutMs: number;
  private readonly trivialTextChars: number;
  private readonly now: () => number;
  private readonly feedbackParser = new GoldfishFeedbackParser();

  constructor(
    private readonly agents: V7MemoryAgents,
    private readonly store: V7MemoryStore,
    private readonly log: V7MemoryRunLog,
    options: V7MemoryTurnPipelineOptions = {},
  ) {
    this.draftTimeoutMs = options.draftTimeoutMs ?? 180_000;
    this.goldfishTimeoutMs = options.goldfishTimeoutMs ?? 90_000;
    this.finalTimeoutMs = options.finalTimeoutMs ?? 180_000;
    this.trivialTextChars = options.trivialTextChars ?? 24;
    this.now = options.now ?? Date.now;
  }

  async run(input: V7MemoryTurnInput): Promise<V7MemorySequenceResult> {
    const started = this.now();
    const result = await this.sequence(input);
    this.log.write({ agent: 'sequence', thread: input.threadId, turn: input.turnId, ms: this.now() - started, outcome: result.outcome, calls: result.calls, coalescedTurns: input.coalescedTurns, window: input.contextWindow });
    return result;
  }

  private async sequence(input: V7MemoryTurnInput): Promise<V7MemorySequenceResult> {
    let calls = 1;
    const draft = await this.stage('elephant-draft', input, this.draftTimeoutMs, abort => this.agents.elephantDraft(input, abort));
    if (!draft.value) {
      this.logStage('elephant-draft', input, draft);
      return { outcome: 'rejected', calls, covered: false };
    }

    const draftValidation = await this.store.validate(draft.value);
    if (!draftValidation.ok) {
      this.logStage('elephant-draft', input, { ...draft, outcome: 'error', reason: `invalid: ${ draftValidation.reason }` });
      // Repair once: the elephant rewrites its own draft from the validator's
      // reason. Goldfish has nothing valid to review, so it is not called.
      calls++;
      const repairFeedback = JSON.stringify({ issues: [{ kind: 'other', target: null, note: `Desktop rejected the draft: ${ draftValidation.reason }` }] });
      const repaired = await this.final(input, draft.value, repairFeedback);
      if (!repaired) return { outcome: 'rejected', calls, covered: false };
      return this.append(input, repaired, 'final', calls);
    }
    this.logStage('elephant-draft', input, draft, this.counts(draftValidation.write));

    const write = draftValidation.write;
    if (this.isEmpty(write)) return { outcome: 'empty', calls, covered: true };
    if (this.isTrivial(write, input)) {
      this.log.write({ agent: 'goldfish', thread: input.threadId, turn: input.turnId, ms: 0, outcome: 'skipped', reason: 'trivial draft' });
      return this.append(input, write, 'draft', calls);
    }

    calls++;
    const draftJson = JSON.stringify(write);
    const review = await this.stage('goldfish', input, this.goldfishTimeoutMs, abort => this.agents.goldfish(input, draftJson, abort));
    const feedback = review.outcome === 'ok' ? this.feedbackParser.parse(review.value) : null;
    if (!feedback) {
      this.logStage('goldfish', input, review.outcome === 'ok' ? { ...review, outcome: 'error', reason: 'invalid feedback JSON' } : review);
      return this.append(input, write, 'draft-fallback', calls);
    }
    this.logStage('goldfish', input, review, { issues: feedback.issues.length });
    if (!feedback.issues.length) return this.append(input, write, 'draft', calls);

    calls++;
    const finalWrite = await this.final(input, draftJson, JSON.stringify(feedback));
    if (!finalWrite || this.isEmpty(finalWrite)) return this.append(input, write, 'draft-fallback', calls);
    return this.append(input, finalWrite, 'final', calls);
  }

  /** elephant-final: one call, validated; null on any failure so the caller falls back. */
  private async final(input: V7MemoryTurnInput, draftJson: string, feedbackJson: string): Promise<ElephantWrite | null> {
    const stage = await this.stage('elephant-final', input, this.finalTimeoutMs, abort => this.agents.elephantFinal(input, draftJson, feedbackJson, abort));
    if (!stage.value) {
      this.logStage('elephant-final', input, stage);
      return null;
    }
    const validation = await this.store.validate(stage.value);
    if (!validation.ok) {
      this.logStage('elephant-final', input, { ...stage, outcome: 'error', reason: `invalid: ${ validation.reason }` });
      return null;
    }
    this.logStage('elephant-final', input, stage, this.counts(validation.write));
    return validation.write;
  }

  private async append(input: V7MemoryTurnInput, write: ElephantWrite, outcome: V7MemorySequenceOutcome, calls: number): Promise<V7MemorySequenceResult> {
    try {
      const appended = await this.store.append(write);
      if (!appended.accepted) {
        this.log.write({ agent: 'sequence', thread: input.threadId, turn: input.turnId, ms: 0, outcome: 'append-rejected', reason: appended.reason || '' });
        return { outcome: 'failed', calls, covered: false };
      }
      return { outcome, calls, covered: true };
    } catch (error) {
      this.log.write({ agent: 'sequence', thread: input.threadId, turn: input.turnId, ms: 0, outcome: 'append-failed', reason: error instanceof Error ? error.message : String(error) });
      return { outcome: 'failed', calls, covered: false };
    }
  }

  /** Runs one model call with a hard timeout that aborts the underlying graph. */
  private async stage(agent: V7MemoryAgent, input: V7MemoryTurnInput, timeoutMs: number, call: (abort: AbortController) => Promise<string | null>): Promise<StageResult> {
    const started = this.now();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) });
    try {
      const value = await Promise.race([call(abort), timeout]);
      if (value === 'timeout') {
        abort.abort();
        return { value: null, outcome: 'timeout', ms: this.now() - started, reason: `${ agent } exceeded ${ timeoutMs }ms` };
      }
      const text = typeof value === 'string' && value.trim() ? value : null;
      return { value: text, outcome: text ? 'ok' : 'empty', ms: this.now() - started };
    } catch (error) {
      return { value: null, outcome: 'error', ms: this.now() - started, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private logStage(agent: V7MemoryAgent, input: V7MemoryTurnInput, stage: StageResult, extra: Record<string, unknown> = {}): void {
    this.log.write({ agent, thread: input.threadId, turn: input.turnId, ms: stage.ms, outcome: stage.outcome, ...extra, ...(stage.reason ? { reason: stage.reason } : {}) });
  }

  private counts(write: ElephantWrite): Record<string, number> {
    return { episodes: write.episodes.length, items: write.items.length, evidence: write.evidence.length };
  }

  private isEmpty(write: ElephantWrite): boolean {
    return write.episodes.length === 0 && write.items.length === 0;
  }

  /** No rule drafted and the human only said something short ("ok", "continue"). */
  private isTrivial(write: ElephantWrite, input: V7MemoryTurnInput): boolean {
    if (write.items.length > 0 || input.coalescedTurns > 1) return false;
    return latestUserText(input.state.messages).length < this.trivialTextChars;
  }
}

export interface V7MemoryGate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export interface V7MemorySchedulerOptions {
  baseWindow?:     number;
  maxWindow?:      number;
  maxTrackedThreads?: number;
  now?:            () => number;
}

interface PendingTurn {
  state:          V7MemoryTurnInput['state'];
  turnId:         string;
  coalescedTurns: number;
}

interface ConversationSlot {
  running:          boolean;
  pending:          PendingTurn | null;
  /** state.messages.length at the start of the last run that covered its span. */
  rememberedThrough: number | null;
}

/**
 * Single-flight per conversation, bounded process-wide through the gate.
 *
 * Coalescing is lossless up to maxWindow: a run reads the live transcript
 * when it STARTS, and its window covers every message appended since the
 * last covered run (rememberedThrough). A failed, dropped or expired run does
 * not advance rememberedThrough, so the next run re-covers its span.
 */
export class V7MemoryScheduler {
  private readonly slots = new Map<string, ConversationSlot>();
  private readonly baseWindow: number;
  private readonly maxWindow: number;
  private readonly maxTrackedThreads: number;
  private readonly now: () => number;

  constructor(
    private readonly pipeline: Pick<V7MemoryTurnPipeline, 'run'>,
    private readonly gate: V7MemoryGate,
    private readonly log: V7MemoryRunLog,
    options: V7MemorySchedulerOptions = {},
  ) {
    this.baseWindow = options.baseWindow ?? 30;
    this.maxWindow = Math.max(this.baseWindow, options.maxWindow ?? 120);
    this.maxTrackedThreads = options.maxTrackedThreads ?? 500;
    this.now = options.now ?? Date.now;
  }

  /** Messages the next run must see so no turn since the last covered run is skipped. */
  windowFor(currentLength: number, rememberedThrough: number | null): number {
    if (rememberedThrough === null || currentLength <= rememberedThrough) return this.baseWindow;
    // +2 keeps the exchange just before the new span for context.
    return Math.min(this.maxWindow, Math.max(this.baseWindow, currentLength - rememberedThrough + 2));
  }

  /** Called once per completed turn. Never throws; never blocks the caller. */
  submit(threadId: string, state: V7MemoryTurnInput['state'], turnId: string): void {
    const slot = this.slotFor(threadId);
    if (slot.running) {
      const coalescedTurns = (slot.pending?.coalescedTurns ?? 0) + 1;
      slot.pending = { state, turnId, coalescedTurns };
      this.log.write({ agent: 'scheduler', thread: threadId, turn: turnId, ms: 0, outcome: 'coalesced', pendingTurns: coalescedTurns });
      return;
    }
    this.start(threadId, slot, { state, turnId, coalescedTurns: 1 });
  }

  /** Test/inspection hook. */
  snapshot(threadId: string): { running: boolean; pendingTurns: number; rememberedThrough: number | null } | null {
    const slot = this.slots.get(threadId);
    return slot ? { running: slot.running, pendingTurns: slot.pending?.coalescedTurns ?? 0, rememberedThrough: slot.rememberedThrough } : null;
  }

  private start(threadId: string, slot: ConversationSlot, turn: PendingTurn): void {
    slot.running = true;
    const queuedAt = this.now();
    let startLength = 0;
    let truncated = false;
    this.gate.run(() => {
      // Read the transcript only once a slot is free: latest wins.
      startLength = turn.state.messages.length;
      const contextWindow = this.windowFor(startLength, slot.rememberedThrough);
      truncated = slot.rememberedThrough !== null && startLength - slot.rememberedThrough + 2 > contextWindow;
      if (truncated) this.log.write({ agent: 'scheduler', thread: threadId, turn: turn.turnId, ms: 0, outcome: 'window-capped', uncovered: startLength - (slot.rememberedThrough as number) + 2 - contextWindow });
      return this.pipeline.run({ state: turn.state, threadId, turnId: turn.turnId, contextWindow, coalescedTurns: turn.coalescedTurns });
    }).then((result) => {
      if (result.covered) slot.rememberedThrough = startLength;
    }).catch((error) => {
      const reason = (error as any)?.reason;
      this.log.write({ agent: 'scheduler', thread: threadId, turn: turn.turnId, ms: this.now() - queuedAt, outcome: reason === 'dropped' || reason === 'expired' ? reason : 'failed', reason: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      slot.running = false;
      const next = slot.pending;
      slot.pending = null;
      if (next) this.start(threadId, slot, next);
    });
  }

  private slotFor(threadId: string): ConversationSlot {
    let slot = this.slots.get(threadId);
    if (slot) {
      // Refresh insertion order so eviction removes the least recently used thread.
      this.slots.delete(threadId);
      this.slots.set(threadId, slot);
      return slot;
    }
    slot = { running: false, pending: null, rememberedThrough: null };
    this.slots.set(threadId, slot);
    if (this.slots.size > this.maxTrackedThreads) {
      for (const [key, candidate] of this.slots) {
        if (this.slots.size <= this.maxTrackedThreads) break;
        if (!candidate.running && !candidate.pending) this.slots.delete(key);
      }
    }
    return slot;
  }
}
