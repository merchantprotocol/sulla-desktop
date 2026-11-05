// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ParentNoticeInbox } from '../../services/BlockerEscalationService';
import type { StrandedManagerCandidate } from './StrandedManagerDetector';

export interface StrandedAlertDispatcher { alert(candidate: StrandedManagerCandidate): Promise<boolean> }

/** Routes a durable pending episode through the turn-safe completion inbox. */
export class StrandedManagerAlertService implements StrandedAlertDispatcher {
  constructor(private readonly inbox: ParentNoticeInbox) {}
  async alert(candidate: StrandedManagerCandidate): Promise<boolean> {
    return this.inbox.enqueue(candidate.parentChannel, candidate.parentThreadId, {
      jobId: candidate.managerJobId, taskIndex: candidate.managerTaskIndex, results: [],
      notice: `stranded manager ${ candidate.label } (job ${ candidate.managerJobId } task ${ candidate.managerTaskIndex }): ${ candidate.reason } — message it, stop it, or relaunch`,
      dedupeKey: candidate.stateKey,
    });
  }
}
