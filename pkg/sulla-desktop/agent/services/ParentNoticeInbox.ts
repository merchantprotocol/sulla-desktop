// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PendingCompletion } from '../app/Services/AgentCompletionInboxService';

/** Common completion-inbox boundary for non-decision notices. */
export interface ParentNoticeInbox {
  enqueue(channel: string, threadId: string, notice: {
    jobId: string;
    taskIndex: number;
    results: [];
    dedupeKey: string;
  } & (
    | { notice: string; noticeKind?: never; stall?: never }
    | Required<Pick<PendingCompletion, 'noticeKind' | 'stall'>> & { notice?: never }
  )): boolean;
}
