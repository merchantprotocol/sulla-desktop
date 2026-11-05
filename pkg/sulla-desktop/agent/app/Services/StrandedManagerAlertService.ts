// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ParentNoticeInbox } from '../../services/BlockerEscalationService';
import type { StrandedManagerCandidate } from './StrandedManagerDetector';

/** Routes a claimed stranded episode through the same turn-safe inbox as blocker escalation. */
export class StrandedManagerAlertService {
  constructor(private readonly inbox: ParentNoticeInbox) {}
  alert(candidate: StrandedManagerCandidate): boolean {
    return this.inbox.enqueue(candidate.parentChannel, candidate.parentThreadId, {
      jobId: candidate.managerJobId, taskIndex: candidate.managerTaskIndex, results: [],
      notice: `stranded manager ${ candidate.label } (job ${ candidate.managerJobId } task ${ candidate.managerTaskIndex }): ${ candidate.reason } — message it, stop it, or relaunch`,
      dedupeKey: candidate.stateKey,
    });
  }
}
