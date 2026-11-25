// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PendingCompletion } from './AgentCompletionInboxService';

/** The minimum identity a settled child completion carries. */
export interface CompletionIdentity {
  jobId: string;
  taskIndex: number;
  dedupeKey?: string;
}

/** The single identity rule for a child completion across inbox, claims and consumption tracking. */
export class CompletionKey {
  static isStall(entry: PendingCompletion): boolean { return entry.noticeKind === 'stall' }

  static isTaskCompletion(entry: PendingCompletion): boolean {
    return !this.isStall(entry) && !entry.dedupeKey?.startsWith('stranded:') && !entry.dedupeKey?.startsWith('blocker:') && !entry.dedupeKey?.startsWith('decision:');
  }

  static of(entry: CompletionIdentity): string {
    return entry.dedupeKey ?? `completion:${ entry.jobId }:${ entry.taskIndex }`;
  }
}
