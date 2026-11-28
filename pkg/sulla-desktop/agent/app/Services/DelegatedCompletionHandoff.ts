// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DeferredStallInput } from './DeferredStallInput';
import { CompletionKey } from './CompletionKey';
import type { PendingCompletion } from './AgentCompletionInboxService';
import { ParentInputWaitRecorder } from '../../services/ParentInputWaitRecorder';

export interface DelegatedThreadState { messages: any[]; metadata?: Record<string, any> }
export interface DelegatedCompletionInbox {
  take(channel: string, threadId: string): PendingCompletion[];
  currentEntries?(channel: string, threadId: string, entries: PendingCompletion[]): Promise<PendingCompletion[]>;
  format(entries: PendingCompletion[]): string;
}
export interface DelegatedRunLifecycle {
  hasLiveWaiter(threadId: string): boolean;
  /** Releases a parked runner, or latches the wake for its next waitForWake(). */
  wake(threadId: string): boolean;
}
export interface DelegatedCompletionDeliveryMarks {
  firstDelivered(entry: PendingCompletion): Promise<void>;
  acknowledge(entry: PendingCompletion): Promise<void>;
}

/**
 * Hands a child's completion to a parent that is itself a delegated manager
 * driven in-process by its spawn_agent runner. The runner owns that thread's
 * turns, so the batch is injected into the live state as one steer and the
 * runner is woken: released if parked, latched if it is mid-turn so its next
 * park returns at once. Leaving the entry in the inbox while the manager is
 * mid-turn strands it: nothing re-notifies the inbox when the runner parks.
 */
export class DelegatedCompletionHandoff {
  private static readonly pendingWakes = new WeakMap<DelegatedThreadState, PendingCompletion[]>();

  /** Claim only inputs handed off since the previous fresh turn, never transcript history. */
  static takeWakeEntries(state: DelegatedThreadState): PendingCompletion[] {
    const entries = this.pendingWakes.get(state) ?? [];
    this.pendingWakes.delete(state);
    return entries;
  }

  static recordWakeEntries(state: DelegatedThreadState, entries: PendingCompletion[]): void {
    this.pendingWakes.set(state, [...(this.pendingWakes.get(state) ?? []), ...entries]);
  }

  constructor(
    private readonly inbox: DelegatedCompletionInbox,
    private readonly lifecycle: DelegatedRunLifecycle,
    private readonly marks: DelegatedCompletionDeliveryMarks,
    private readonly inject: (state: DelegatedThreadState, message: any, options?: { onConsumed?: () => Promise<void> | void; recorder?: ParentInputWaitRecorder }) => void,
    private readonly nextId: () => string,
    private readonly clock: () => number = Date.now,
    private readonly waitRecorder = new ParentInputWaitRecorder(),
    private readonly completionConsumed: (channel: string, threadId: string, entries: PendingCompletion[]) => void = () => undefined,
  ) {}

  /** True when this thread is owned by a live in-process runner (the caller must not dispatch a new turn). */
  owns(state: DelegatedThreadState | undefined, threadId: string): boolean {
    return this.lifecycle.hasLiveWaiter(threadId) || Boolean(state?.metadata?.delegatedRunActive);
  }

  /** Delivers queued completions to a runner-owned thread. Returns false when the thread is not runner-owned. */
  async deliver(channel: string, threadId: string, state: DelegatedThreadState | undefined): Promise<boolean> {
    if (!this.owns(state, threadId)) return false;
    if (!state) {
      // A live waiter without graph state: release it so the runner cannot
      // stay blocked; the entries stay queued for the next dispatch.
      this.lifecycle.wake(threadId);
      return true;
    }
    const claimed = this.inbox.take(channel, threadId);
    const regular = claimed.filter(entry => !CompletionKey.isStall(entry));
    const stalls = claimed.filter(entry => CompletionKey.isStall(entry));
    // Inject real results before waiting on advisory stall validation. A
    // later completion must not overtake this batch while that lookup waits.
    if (regular.length) this.deliverRegular(channel, threadId, state, regular);
    const currentStalls = stalls.length
      ? await this.inbox.currentEntries?.(channel, threadId, stalls) ?? []
      : [];
    if (currentStalls.length) await this.deliverStalls(channel, threadId, state, currentStalls);
    if (!regular.length && !currentStalls.length) return true;
    this.lifecycle.wake(threadId);
    return true;
  }

  private deliverRegular(channel: string, threadId: string, state: DelegatedThreadState, regular: PendingCompletion[]): void {
    DelegatedCompletionHandoff.recordWakeEntries(state, regular);
    const deliveredAtMs = this.clock();
    const runId = typeof state.metadata?.runId === 'string' ? state.metadata.runId : undefined;
    const parentInputWait = regular.map(entry => this.waitRecorder.deferred({
      kind: 'completion', threadId, inputId: CompletionKey.of(entry),
      queuedAtMs: entry.queuedAtMs ?? deliveredAtMs, deferredAtMs: deliveredAtMs,
      ...(runId ? { runId } : {}),
    }));
    this.inject(state, {
      id:        this.nextId(),
      role:      'user',
      content:   this.inbox.format(regular),
      timestamp: deliveredAtMs,
      metadata:  { source: 'sub_agent_completion', inputSource: 'system', completionEntries: regular, parentInputWait },
    }, { onConsumed: async() => {
      for (const entry of regular) {
        if (CompletionKey.isTaskCompletion(entry)) await this.marks.firstDelivered(entry);
        await this.marks.acknowledge(entry);
      }
      this.completionConsumed(channel, threadId, regular);
    }, recorder: this.waitRecorder });
    for (const wait of parentInputWait) this.waitRecorder.injected(wait, deliveredAtMs);
  }

  private async deliverStalls(channel: string, threadId: string, state: DelegatedThreadState, stalls: PendingCompletion[]): Promise<void> {
    DelegatedCompletionHandoff.recordWakeEntries(state, stalls);
    this.inject(state, {
      id: this.nextId(), role: 'user', content: '', timestamp: this.clock(),
      metadata: DeferredStallInput.metadata(channel, threadId, stalls),
    });
    // Stall notices retain their existing validation/acknowledgement policy;
    // they are advisory records rather than a helper completion payload.
    for (const entry of stalls) await this.marks.acknowledge(entry);
  }
}
