// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ParentNoticeInbox } from './BlockerEscalationService';

interface ParentLink { parentThreadId?: string; parentChannel?: string }

/** Route a nonterminal blocker through the existing inbox, never as a child result. */
export class DelegatedWakeRepairNotice {
  constructor(private readonly parentOf: (thread: string) => Promise<ParentLink | undefined>, private readonly inbox: ParentNoticeInbox) {}

  async send(jobId: string, taskIndex: number, threadId: string, deadline: number, stillMissing: () => boolean): Promise<'enqueued' | 'present' | 'obsolete'> {
    const visited = new Set<string>([threadId]);
    let link = await this.parentOf(threadId);
    while (link?.parentThreadId && !visited.has(link.parentThreadId)) {
      const target = link.parentThreadId;
      visited.add(target);
      const parent = await this.parentOf(target);
      if (!parent) {
        if (!stillMissing()) return 'obsolete';
        const inserted = this.inbox.enqueue(link.parentChannel || 'sulla-desktop', target, {
 jobId,
taskIndex,
results: [],
          dedupeKey: `blocker:wake-repair:${ threadId }:${ deadline }`,
          notice: `Wake input is missing for ${ jobId } task ${ taskIndex }. Still parked; send a job message by ${ new Date(deadline).toISOString() }.`,
});
        // CompletionInboxStore returns false only for an existing/claimed/acknowledged key.
        return inserted ? 'enqueued' : 'present';
      }
      link = parent;
    }
    throw new Error('Wake repair root is unavailable');
  }
}
