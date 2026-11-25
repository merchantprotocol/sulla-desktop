// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { PublishApprovalOutcomeSender } from './PublishApprovalOutcomeDelivery';
import type { PublishApprovalOutcomeMessage } from './PublishApprovalOutcomeMessage';

type DecisionSource = { subscribe(listener: (record: DecisionRecord) => void): () => void };

/** Routes terminal publish decisions using requester and conversation identity stored on the decision record. */
export class PublishApprovalCoordinator {
  private static readonly MAX_DELIVERED_IDS = 500;
  private readonly pending = new Set<string>();
  private readonly delivered = new Set<string>();
  private unsubscribe?: () => void;

  constructor(
    private readonly decisions: DecisionSource,
    private readonly outcomes: PublishApprovalOutcomeSender,
    private readonly wording: Pick<PublishApprovalOutcomeMessage, 'for'>,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.decisions.subscribe(record => { void this.handle(record) });
  }

  private async handle(record: DecisionRecord): Promise<void> {
    if (!record.payload?.filesPublishRequestId || record.kind !== 'approval' || !['approved', 'denied', 'expired'].includes(record.status)) return;
    if (this.pending.has(record.id) || this.delivered.has(record.id)) return;
    this.pending.add(record.id);
    try {
      const delivered = await this.outcomes.deliver(record, await this.wording.for(record));
      if (delivered) this.rememberDelivered(record.id);
    } finally {
      this.pending.delete(record.id);
    }
  }

  private rememberDelivered(decisionId: string): void {
    this.delivered.add(decisionId);
    while (this.delivered.size > PublishApprovalCoordinator.MAX_DELIVERED_IDS) {
      const oldest = this.delivered.values().next().value;
      if (oldest === undefined) return;
      this.delivered.delete(oldest);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending.clear();
    this.delivered.clear();
  }
}
