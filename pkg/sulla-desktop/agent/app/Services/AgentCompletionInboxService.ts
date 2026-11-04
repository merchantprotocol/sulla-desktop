// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { AgentJobResult } from '../../tools/agents/jobRegistry';
import { CompletionFormatter } from './CompletionFormatter';
import { CompletionIdleDispatcher, type CompletionDispatch } from './CompletionIdleDispatcher';
import type { CompletionTimer, CompletionTimerHandle } from './CompletionTimer';

export interface PendingCompletion {
  jobId: string;
  results: AgentJobResult[];
  failureReason?: string;
}

interface CompletionInbox {
  entries: PendingCompletion[];
  timer?: CompletionTimerHandle;
  stopped: boolean;
}

export class AgentCompletionInboxService extends Service {
  private readonly inboxes = new Map<string, CompletionInbox>();

  constructor(
    private readonly timer: CompletionTimer,
    private readonly idleDispatcher: CompletionIdleDispatcher,
    private readonly formatter: CompletionFormatter,
    private readonly coalesceMs: number,
  ) {
    super();
  }

  registerIdleDispatcher(dispatcher: CompletionDispatch): void {
    this.idleDispatcher.register(dispatcher);
  }

  enqueue(channel: string, threadId: string, completion: PendingCompletion): boolean {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key) ?? { entries: [], stopped: false };
    if (!inbox.entries.some(entry => entry.jobId === completion.jobId)) {
      inbox.entries.push(completion);
    }
    this.inboxes.set(key, inbox);
    if (!inbox.stopped && !inbox.timer) {
      inbox.timer = this.timer.schedule(() => this.dispatch(channel, threadId, inbox), this.coalesceMs);
      inbox.timer.unref();
    }
    return true;
  }

  setStopped(channel: string, threadId: string, stopped: boolean): void {
    const inbox = this.inboxes.get(this.keyFor(channel, threadId));
    if (inbox) inbox.stopped = stopped;
  }

  take(channel: string, threadId: string): PendingCompletion[] {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key);
    if (!inbox?.entries.length) return [];
    if (inbox.timer) this.timer.cancel(inbox.timer);
    const entries = inbox.entries.splice(0);
    inbox.timer = undefined;
    inbox.stopped = false;
    this.inboxes.delete(key);
    return entries;
  }

  format(entries: PendingCompletion[]): string {
    return this.formatter.format(entries);
  }

  stop(): void {
    for (const inbox of this.inboxes.values()) {
      if (inbox.timer) this.timer.cancel(inbox.timer);
      inbox.timer = undefined;
      inbox.stopped = true;
    }
  }

  dispose(): void {
    this.stop();
    this.inboxes.clear();
    this.idleDispatcher.clear();
  }

  pendingCount(): number {
    return Array.from(this.inboxes.values()).reduce((count, inbox) => count + inbox.entries.length, 0);
  }

  private dispatch(channel: string, threadId: string, inbox: CompletionInbox): void {
    inbox.timer = undefined;
    if (!inbox.stopped && inbox.entries.length) this.idleDispatcher.dispatch(channel, threadId);
  }

  private keyFor(channel: string, threadId: string): string {
    return `${ channel }|${ threadId }`;
  }
}
