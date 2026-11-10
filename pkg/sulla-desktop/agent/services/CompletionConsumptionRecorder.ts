// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PendingCompletion } from './AgentCompletionInbox';

/** Tracks completions injected into one turn until its first model response succeeds. */
export class CompletionConsumptionRecorder {
  private readonly entries = new Map<string, PendingCompletion>();
  private confirmed = false;

  recordInjected(entries: PendingCompletion[]): void {
    for (const entry of entries) this.entries.set(entry.dedupeKey ?? `completion:${ entry.jobId }:${ entry.taskIndex }`, entry);
  }

  confirmSeen(): void {
    this.confirmed = true;
    this.entries.clear();
  }

  async releaseOnAbort(release: (entry: PendingCompletion) => Promise<void> | void): Promise<void> {
    if (this.confirmed) return;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) await release(entry);
  }
}
