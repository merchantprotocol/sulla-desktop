// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PendingCompletion } from './AgentCompletionInboxService';
import type { JobCustodyPort } from './JobCustodyTypes';

export interface CompletionRequeueInbox {
  requeue(channel: string, threadId: string, entry: PendingCompletion): boolean;
  requeueAfterFailure(channel: string, threadId: string, entry: PendingCompletion): number;
  requeueQuietly(channel: string, threadId: string, entry: PendingCompletion): void;
}

/**
 * Puts a claimed-but-unconsumed completion back after an aborted turn. A
 * custody move can land while the old owner's turn holds the claim; the entry
 * then goes to the current owner (under the producer lock), never back to the
 * stale one. Entries without a task scope keep their original thread.
 */
export class CustodyCompletionRequeueService {
  constructor(private readonly inbox: CompletionRequeueInbox, private readonly custody?: Pick<JobCustodyPort, 'withOwner'>) {}

  async requeue(channel: string, threadId: string, entry: PendingCompletion): Promise<boolean> {
    return this.route(channel, threadId, entry, (ownerChannel, ownerThread) => this.inbox.requeue(ownerChannel, ownerThread, entry));
  }

  async requeueAfterFailure(channel: string, threadId: string, entry: PendingCompletion): Promise<number> {
    return this.route(channel, threadId, entry, (ownerChannel, ownerThread) => this.inbox.requeueAfterFailure(ownerChannel, ownerThread, entry));
  }

  async requeueQuietly(channel: string, threadId: string, entry: PendingCompletion): Promise<void> {
    await this.route(channel, threadId, entry, (ownerChannel, ownerThread) => this.inbox.requeueQuietly(ownerChannel, ownerThread, entry));
  }

  private async route<T>(channel: string, threadId: string, entry: PendingCompletion, operation: (ownerChannel: string, ownerThread: string) => T): Promise<T> {
    if (!this.custody || entry.taskIndex < 0) return operation(channel, threadId);
    const routed = await this.custody.withOwner(entry.jobId, entry.taskIndex, async(_client, owner) => operation(owner.channel, owner.threadId));
    return routed ?? operation(channel, threadId);
  }
}
