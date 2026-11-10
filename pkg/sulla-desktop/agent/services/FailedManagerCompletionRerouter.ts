// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PendingCompletion } from '../app/Services/AgentCompletionInboxService';
import { enqueueAgentCompletion } from './AgentCompletionInbox';
import type { AgentJob } from '../tools/agents/jobRegistry';

export interface FailedManagerCompletionQueue {
  enqueue(channel: string, threadId: string, completion: PendingCompletion): boolean;
}

/** Salvages settled child completions that a terminal manager wake did not consume. */
export class FailedManagerCompletionRerouter {
  constructor(private readonly queue: FailedManagerCompletionQueue = { enqueue: enqueueAgentCompletion }) {}

  async route(manager: AgentJob, taskIndex: number, failureReason: string, entries: PendingCompletion[]): Promise<void> {
    if (!manager.parentThreadId) return;
    const channel = manager.parentChannel || 'sulla-desktop';
    const header = `orphaned from failed manager ${ manager.jobId }#${ taskIndex }: ${ failureReason }`;
    for (const entry of entries) {
      const results = entry.results.map(result => ({ ...result, output: `[${ header }]\n\n${ result.output }` }));
      this.queue.enqueue(channel, manager.parentThreadId, {
        ...entry,
        results,
        failureReason: undefined,
        dedupeKey: `orphaned:${ manager.jobId }#${ taskIndex }:${ entry.jobId }#${ entry.taskIndex }`,
      });
    }
  }
}
