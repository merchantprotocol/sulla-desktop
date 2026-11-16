// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { CompletionKey } from '../app/Services/CompletionKey';
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
   * A completion whose carrying message is followed by a genuine model reply
   * was consumed: a model call that included it already succeeded. Such an
   * entry stays acknowledged even if a later step of the same turn fails;
   * releasing it would hand the parent the same result again. Assistant-role
   * messages the harness injects (subconscious context, summaries, error
   * notices) are not replies: counting them kept unseen results acknowledged.
   */
  confirmAnswered(messages: readonly any[]): void {
    let answered = false;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (this.isModelReply(message)) {
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
    return CompletionKey.of(entry);
  }

  private isModelReply(message: any): boolean {
    if (message?.role !== 'assistant') return false;
    const metadata = message.metadata ?? {};
    if (metadata._synthetic === true || metadata._conversationSummary === true) return false;
    if (metadata.source === 'subconscious_context') return false;
    return metadata.kind !== 'agent_error';
  }
}
