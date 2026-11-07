// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { AgentJob, AgentJobResult, AgentJobTask } from '../../tools/agents/jobRegistry';
import { CompletionFormatter } from './CompletionFormatter';
import { CompletionIdleDispatcher, type CompletionDispatch } from './CompletionIdleDispatcher';

export interface AgentTerminalNotice {
  status: 'stopped' | 'failed';
  reason: string;
  stoppedBy?: AgentJob['stoppedBy'] | AgentJobTask['stoppedBy'];
}

export interface PendingCompletion {
  jobId: string;
  taskIndex: number;
  results: AgentJobResult[];
  failureReason?: string;
  terminal?: AgentTerminalNotice;
  notice?: string;
  dedupeKey?: string;
}

interface CompletionInbox {
  entries: PendingCompletion[];
  stopped: boolean;
}

/** Owns the per-thread, per-task completion queue with no fixed delivery delay. */
export class AgentCompletionInboxService extends Service {
  private readonly inboxes = new Map<string, CompletionInbox>();
  private readonly claimedKeys = new Set<string>();

  constructor(
    private readonly idleDispatcher: CompletionIdleDispatcher,
    private readonly formatter: CompletionFormatter,
  ) {
    super();
  }

  registerIdleDispatcher(dispatcher: CompletionDispatch): void {
    this.idleDispatcher.register(dispatcher);
  }

  enqueue(channel: string, threadId: string, completion: PendingCompletion): boolean {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key) ?? { entries: [], stopped: false };
    const entryKey = completion.dedupeKey ?? `completion:${ completion.jobId }:${ completion.taskIndex }`;
    const duplicate = this.claimedKeys.has(entryKey) || inbox.entries.some(entry =>
      (entry.dedupeKey ?? `completion:${ entry.jobId }:${ entry.taskIndex }`) === entryKey);
    if (!duplicate) inbox.entries.push(completion);
    this.inboxes.set(key, inbox);
    if (!inbox.stopped && !duplicate) this.idleDispatcher.dispatch(channel, threadId);
    return !duplicate;
  }

  notifyReady(channel: string, threadId: string): void {
    const inbox = this.inboxes.get(this.keyFor(channel, threadId));
    if (!inbox?.stopped && inbox?.entries.length) this.idleDispatcher.dispatch(channel, threadId);
  }

  setStopped(channel: string, threadId: string, stopped: boolean): void {
    const inbox = this.inboxes.get(this.keyFor(channel, threadId));
    if (inbox) inbox.stopped = stopped;
  }

  take(channel: string, threadId: string): PendingCompletion[] {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key);
    if (!inbox?.entries.length) return [];
    const entries = inbox.entries.splice(0);
    for (const entry of entries) this.claimedKeys.add(this.entryKey(entry));
    inbox.stopped = false;
    this.inboxes.delete(key);
    return entries;
  }

  acknowledge(entry: PendingCompletion): void {
    this.claimedKeys.delete(this.entryKey(entry));
  }

  requeue(channel: string, threadId: string, entry: PendingCompletion): boolean {
    this.acknowledge(entry);
    return this.enqueue(channel, threadId, entry);
  }

  format(entries: PendingCompletion[]): string {
    return this.formatter.format(entries);
  }

  stop(): void {
    for (const inbox of this.inboxes.values()) inbox.stopped = true;
  }

  clear(): void {
    this.inboxes.clear();
    this.claimedKeys.clear();
    this.idleDispatcher.clear();
  }

  dispose(): void {
    this.stop();
    this.inboxes.clear();
    this.claimedKeys.clear();
    this.idleDispatcher.clear();
  }

  pendingCount(): number {
    return Array.from(this.inboxes.values()).reduce((count, inbox) => count + inbox.entries.length, 0);
  }

  private entryKey(entry: PendingCompletion): string {
    return entry.dedupeKey ?? `completion:${ entry.jobId }:${ entry.taskIndex }`;
  }

  private keyFor(channel: string, threadId: string): string {
    return `${ channel }|${ threadId }`;
  }
}
