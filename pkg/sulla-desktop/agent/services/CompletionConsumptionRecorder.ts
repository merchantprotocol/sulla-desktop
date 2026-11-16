// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PendingCompletion } from './AgentCompletionInbox';

/** Tracks completions injected into one turn until the model has answered them. */
export class CompletionConsumptionRecorder {
  private readonly entries = new Map<string, PendingCompletion>();
  private confirmed = false;

  recordInjected(entries: PendingCompletion[]): void {
    for (const entry of entries) this.entries.set(this.keyOf(entry), entry);
  }

  confirmSeen(): void {
    this.confirmed = true;
    this.entries.clear();
  }

  /**
   * A completion whose carrying message is followed by an assistant message
   * was consumed: a model call that included it already succeeded. Such an
   * entry stays acknowledged even if a later step of the same turn fails;
   * releasing it would hand the parent the same result again.
   */
  confirmAnswered(messages: readonly any[]): void {
    let answered = false;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === 'assistant') {
        answered = true;
        continue;
      }
      const carried = message?.metadata?.completionEntries;
      if (answered && Array.isArray(carried)) for (const entry of carried) this.entries.delete(this.keyOf(entry));
    }
  }

  async releaseOnAbort(release: (entry: PendingCompletion) => Promise<void> | void): Promise<void> {
    if (this.confirmed) return;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) await release(entry);
  }

  private keyOf(entry: PendingCompletion): string {
    return entry.dedupeKey ?? `completion:${ entry.jobId }:${ entry.taskIndex }`;
  }
}
