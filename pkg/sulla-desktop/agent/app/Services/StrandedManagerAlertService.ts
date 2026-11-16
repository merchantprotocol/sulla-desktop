// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ParentNoticeInbox } from '../../services/BlockerEscalationService';
import type { StrandedManagerCandidate } from './StrandedManagerDetector';
import type { JobCustodyPort } from './JobCustodyTypes';

export interface StrandedAlertDispatcher { alert(candidate: StrandedManagerCandidate): Promise<boolean> }

/**
 * Routes a durable pending episode through the turn-safe completion inbox, to
 * the manager task's current custody owner (after reassign/adopt/replace_lead)
 * under the shared custody/inbox producer lock.
 */
export class StrandedManagerAlertService implements StrandedAlertDispatcher {
  constructor(private readonly inbox: ParentNoticeInbox, private readonly custody?: Pick<JobCustodyPort, 'withOwner'>) {}
  async alert(candidate: StrandedManagerCandidate): Promise<boolean> {
    const send = (channel: string, threadId: string) => this.inbox.enqueue(channel, threadId, {
      jobId: candidate.managerJobId, taskIndex: candidate.managerTaskIndex, results: [],
      notice: `stranded manager ${ candidate.label } (job ${ candidate.managerJobId } task ${ candidate.managerTaskIndex }): ${ candidate.reason } — message it, stop it, or relaunch`,
      dedupeKey: candidate.stateKey,
    });
    const routed = await this.custody?.withOwner(candidate.managerJobId, candidate.managerTaskIndex, async(_client, owner) => send(owner.channel, owner.threadId));
    return routed ?? send(candidate.parentChannel, candidate.parentThreadId);
  }
}
