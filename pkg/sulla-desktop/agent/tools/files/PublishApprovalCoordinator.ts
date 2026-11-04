// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';

type DecisionSource = { subscribe(listener: (record: DecisionRecord) => void): () => void };
type Notifier = (message: string) => Promise<boolean>;

/** Coordinates one-shot publish notifications for an application/session scope. */
export class PublishApprovalCoordinator {
  private readonly pending = new Set<string>();
  private readonly notify = new Map<string, Notifier>();
  private readonly delivered = new Set<string>();
  private unsubscribe?: () => void;

  constructor(private readonly decisions: DecisionSource) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.decisions.subscribe(record => { void this.handle(record) });
  }

  register(requestId: string, notifier: Notifier): void {
    if (!this.delivered.has(requestId)) this.notify.set(requestId, notifier);
  }

  private async handle(record: DecisionRecord): Promise<void> {
    const payload = record.payload;
    if (!payload?.filesPublishRequestId || record.kind !== 'approval' || record.status === 'pending' || record.status === 'deferred') return;
    if (this.pending.has(record.id) || this.delivered.has(record.id)) return;
    this.pending.add(record.id);
    try {
      const send = this.notify.get(record.id);
      if (send) await send(record.status === 'approved' ? 'File version publish approved.' : `File version publish request ${ record.status }.`);
      this.delivered.add(record.id);
    } finally {
      this.pending.delete(record.id);
      this.notify.delete(record.id);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending.clear();
    this.notify.clear();
    this.delivered.clear();
  }
}
