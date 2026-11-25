// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DeferredStallInput } from './DeferredStallInput';
import { CompletionKey } from './CompletionKey';
import type { PendingCompletion } from './AgentCompletionInboxService';

export interface DelegatedThreadState { messages: any[]; metadata?: Record<string, any> }
export interface DelegatedCompletionInbox {
  take(channel: string, threadId: string): PendingCompletion[];
  currentEntries?(channel: string, threadId: string, entries: PendingCompletion[]): Promise<PendingCompletion[]>;
  requeueQuietly?(channel: string, threadId: string, entry: PendingCompletion): void;
  format(entries: PendingCompletion[]): string;
}
export interface DelegatedRunLifecycle {
  liveState?(threadId: string): DelegatedThreadState | undefined;
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

  static hasWakeEntries(state: DelegatedThreadState): boolean {
    return !!this.pendingWakes.get(state)?.length;
  }

  static recordWakeEntries(state: DelegatedThreadState, entries: PendingCompletion[]): void {
    this.pendingWakes.set(state, [...(this.pendingWakes.get(state) ?? []), ...entries]);
  }

  constructor(
    private readonly inbox: DelegatedCompletionInbox,
    private readonly lifecycle: DelegatedRunLifecycle,
    private readonly marks: DelegatedCompletionDeliveryMarks,
    private readonly inject: (state: DelegatedThreadState, message: any) => void,
    private readonly nextId: () => string,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Resolve ownership only after any asynchronous stall validation. */
  async deliver(channel: string, threadId: string, fallback: DelegatedThreadState | undefined | (() => DelegatedThreadState | undefined)): Promise<boolean> {
    const claimed = this.inbox.take(channel, threadId);
    const entries = claimed.some(entry => entry.noticeKind === 'stall')
      ? await this.inbox.currentEntries?.(channel, threadId, claimed) ?? claimed.filter(entry => entry.noticeKind !== 'stall')
      : claimed;
    const live = this.lifecycle.liveState?.(threadId);
    const state = live ?? (typeof fallback === 'function' ? fallback() : fallback);
    if (!state || (!live && !this.lifecycle.hasLiveWaiter(threadId) && !state.metadata?.delegatedRunActive)) {
      for (const entry of entries) this.inbox.requeueQuietly!(channel, threadId, entry);
      return false;
    }
    if (!entries.length) return true;
    DelegatedCompletionHandoff.recordWakeEntries(state, entries);
    const stalls = entries.filter(entry => CompletionKey.isStall(entry));
    const regular = entries.filter(entry => !CompletionKey.isStall(entry));
    if (stalls.length) this.inject(state, {
      id: this.nextId(), role: 'user', content: '', timestamp: this.clock(),
      metadata: DeferredStallInput.metadata(channel, threadId, stalls),
    });
    if (regular.length) this.inject(state, {
      id:        this.nextId(),
      role:      'user',
      content:   this.inbox.format(regular),
      timestamp: this.clock(),
      metadata:  { source: 'sub_agent_completion', inputSource: 'system', completionEntries: regular },
    });
    this.lifecycle.wake(threadId);
    for (const entry of entries) {
      if (CompletionKey.isTaskCompletion(entry)) await this.marks.firstDelivered(entry);
      await this.marks.acknowledge(entry);
    }
    return true;
  }
}
