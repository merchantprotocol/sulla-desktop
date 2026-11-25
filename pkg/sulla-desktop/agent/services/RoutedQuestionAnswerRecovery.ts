// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { LateDecisionAnswerHandler } from './LateDecisionAnswerHandler';

export interface RoutedQuestionRecoveryRepository {
  answeredRoutedQuestionsWithoutDelivery?(): Promise<DecisionRecord[]>;
  findById?(id: string): Promise<DecisionRecord | undefined>;
}

/** Requeues the crash window between an agent-held answer CAS and mailbox insertion. */
export class RoutedQuestionAnswerRecovery {
  constructor(
    private readonly records: RoutedQuestionRecoveryRepository,
    private readonly answerHandler: Pick<LateDecisionAnswerHandler, 'handle'>,
    private readonly changed: (record: DecisionRecord) => void,
  ) {}

  async reconcile(): Promise<void> {
    for (const record of await this.records.answeredRoutedQuestionsWithoutDelivery?.() ?? []) {
      try {
        const receipt = await this.answerHandler.handle(record, {
          id: record.id,
          conversationId: record.conversationId,
          action: 'answered',
          answers: record.answers ?? [],
        });
        if (!receipt.settled) continue;
        const current = await this.records.findById?.(record.id);
        if (current) this.changed(current);
      } catch (error) {
        console.warn(`[RoutedQuestionAnswerRecovery] Could not recover answer delivery for decision ${ record.id }:`, (error as Error).message);
      }
    }
  }
}
