// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { AgentJob, AgentJobResult, AgentJobTask } from '../../tools/agents/jobRegistry';
import { CompletionFormatter } from './CompletionFormatter';
import { CompletionIdleDispatcher, type CompletionDispatch } from './CompletionIdleDispatcher';
import { CompletionKey } from './CompletionKey';
import { CompletionRequeueBackoff } from './CompletionRequeueBackoff';



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
  noticeKind?: 'stall';
  stall?: { childThread: string; baseline: string; label?: string; hungTool?: string };
  dedupeKey?: string;
}

interface CompletionInbox {
  entries: PendingCompletion[];
  stopped: boolean;
}

/** Owns the per-thread, per-task completion queue with no fixed delivery delay. */
export class AgentCompletionInboxService extends Service {
  private static readonly ACKNOWLEDGED_KEY_LIMIT = 2048;
  private validateStall?: (channel: string, threadId: string, entry: PendingCompletion) => Promise<boolean>;
  private readonly inboxes = new Map<string, CompletionInbox>();
  private readonly claimedKeys = new Set<string>();
  private readonly acknowledgedKeys = new Set<string>();

  constructor(
    private readonly idleDispatcher: CompletionIdleDispatcher,
    private readonly formatter: CompletionFormatter,
    private readonly backoff: CompletionRequeueBackoff = new CompletionRequeueBackoff(),
  ) {
    super();
  }

  registerIdleDispatcher(dispatcher: CompletionDispatch): void {
    this.idleDispatcher.register(dispatcher);
  }

  registerStallValidator(validate: NonNullable<AgentCompletionInboxService['validateStall']>): void {
    this.validateStall = validate;
  }

  async currentEntries(channel: string, threadId: string, entries: PendingCompletion[]): Promise<PendingCompletion[]> {
    const keep = await Promise.all(entries.map(async entry => {
      if (entry.noticeKind !== 'stall') return true;
      if (await this.validateStall?.(channel, threadId, entry)) return true;
      this.releaseClaim(entry);
      return false;
    }));
    return entries.filter((_entry, index) => keep[index]);
  }

  enqueue(channel: string, threadId: string, completion: PendingCompletion): boolean {
    return this.enqueueInternal(channel, threadId, completion, true);
  }

  /** Queue an informational entry for the next real turn without dispatching or waking it. */
  enqueueQuietly(channel: string, threadId: string, completion: PendingCompletion): boolean {
    return this.enqueueInternal(channel, threadId, completion, false);
  }

  private enqueueInternal(channel: string, threadId: string, completion: PendingCompletion, dispatch: boolean): boolean {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key) ?? { entries: [], stopped: false };
    const entryKey = this.entryKey(completion);
    const duplicate = this.claimedKeys.has(entryKey) || this.acknowledgedKeys.has(entryKey) || this.backoff.isWaiting(entryKey) ||
      inbox.entries.some(entry => this.entryKey(entry) === entryKey);
    if (!duplicate) inbox.entries.push(completion);
    this.inboxes.set(key, inbox);
    if (dispatch && !inbox.stopped && !duplicate) this.idleDispatcher.dispatch(channel, threadId);
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
    const key = this.entryKey(entry);
    this.claimedKeys.delete(key);
    this.acknowledgedKeys.delete(key);
    this.acknowledgedKeys.add(key);
    while (this.acknowledgedKeys.size > AgentCompletionInboxService.ACKNOWLEDGED_KEY_LIMIT) {
      const oldest = this.acknowledgedKeys.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.acknowledgedKeys.delete(oldest);
    }
  }

  requeue(channel: string, threadId: string, entry: PendingCompletion): boolean {
    const key = this.entryKey(entry);
    this.claimedKeys.delete(key);
    this.acknowledgedKeys.delete(key);
    return this.enqueue(channel, threadId, entry);
  }

  /**
   * Hands a claimed completion back after its delivery FAILED. It returns to
   * the inbox (and wakes the idle dispatcher) only after an exponential,
   * capped delay, so a persistent failure cannot become a hot retry loop.
   * Returns the delay in ms, or -1 when a retry for it is already pending.
   */
  requeueAfterFailure(channel: string, threadId: string, entry: PendingCompletion): number {
    const key = this.entryKey(entry);
    this.claimedKeys.delete(key);
    this.acknowledgedKeys.delete(key);
    return this.backoff.schedule(key, () => this.enqueue(channel, threadId, entry));
  }

  /**
   * Hands a claimed completion back to a thread whose turn is still running,
   * without waking the dispatcher: that run's own end drains the inbox.
   */
  requeueQuietly(channel: string, threadId: string, entry: PendingCompletion): void {
    const key = this.entryKey(entry);
    this.claimedKeys.delete(key);
    this.acknowledgedKeys.delete(key);
    if (this.backoff.isWaiting(key)) return;
    const inboxKey = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(inboxKey) ?? { entries: [], stopped: false };
    if (!inbox.entries.some(existing => this.entryKey(existing) === key)) inbox.entries.push(entry);
    this.inboxes.set(inboxKey, inbox);
  }

  /** Drops this process's claim without redelivering; the durable record still holds it for recovery. */
  releaseClaim(entry: PendingCompletion): void {
    this.claimedKeys.delete(this.entryKey(entry));
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
    this.acknowledgedKeys.clear();
    this.backoff.clear();
    this.idleDispatcher.clear();
  }

  dispose(): void {
    this.stop();
    this.inboxes.clear();
    this.claimedKeys.clear();
    this.acknowledgedKeys.clear();
    this.backoff.clear();
    this.idleDispatcher.clear();
  }

  pendingCount(): number {
    return Array.from(this.inboxes.values()).reduce((count, inbox) => count + inbox.entries.length, 0);
  }

  private entryKey(entry: PendingCompletion): string {
    return CompletionKey.of(entry);
  }

  private keyFor(channel: string, threadId: string): string {
    return `${ channel }|${ threadId }`;
  }
}
