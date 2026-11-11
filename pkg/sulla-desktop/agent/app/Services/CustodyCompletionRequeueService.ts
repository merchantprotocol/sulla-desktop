// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PendingCompletion } from './AgentCompletionInboxService';
import type { JobCustodyPort } from './JobCustodyTypes';

export interface CompletionRequeueInbox {
  requeue(channel: string, threadId: string, entry: PendingCompletion): boolean;
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
    if (!this.custody || entry.taskIndex < 0) return this.inbox.requeue(channel, threadId, entry);
    const routed = await this.custody.withOwner(entry.jobId, entry.taskIndex, async(_client, owner) => this.inbox.requeue(owner.channel, owner.threadId, entry));
    return routed ?? this.inbox.requeue(channel, threadId, entry);
  }
}
