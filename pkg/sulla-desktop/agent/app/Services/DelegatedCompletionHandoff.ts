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
  constructor(
    private readonly inbox: DelegatedCompletionInbox,
    private readonly lifecycle: DelegatedRunLifecycle,
    private readonly marks: DelegatedCompletionDeliveryMarks,
    private readonly inject: (state: DelegatedThreadState, message: any) => void,
    private readonly nextId: () => string,
    private readonly clock: () => number = Date.now,
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
    const entries = claimed.some(entry => entry.noticeKind === 'stall')
      ? await this.inbox.currentEntries?.(channel, threadId, claimed) ?? claimed.filter(entry => entry.noticeKind !== 'stall')
      : claimed;
    if (!entries.length) return true;
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
    for (const entry of entries) {
      if (CompletionKey.isTaskCompletion(entry)) await this.marks.firstDelivered(entry);
      await this.marks.acknowledge(entry);
    }
    this.lifecycle.wake(threadId);
    return true;
  }
}
