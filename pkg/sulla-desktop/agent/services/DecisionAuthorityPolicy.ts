// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionAuthority, DecisionRecord } from '@pkg/shared/decisions';

export type DecisionAgentAction = 'answer' | 'approve' | 'deny' | 'pass';

/** The record-level authority rules shared by decision creation and later agent actions. */
export class DecisionAuthorityPolicy {
  classify(record: Pick<DecisionRecord, 'kind' | 'questions' | 'payload'>): DecisionAuthority {
    if (record.kind === 'approval') return 'human';
    if (record.payload?.decisionAuthority === 'human' || record.questions?.some(question => question.task)) return 'human';
    return 'any';
  }

  allows(record: Pick<DecisionRecord, 'kind' | 'questions' | 'payload'>, action: DecisionAgentAction, actorKind: 'agent' | 'human'): boolean {
    if (actorKind === 'human') {
      return record.kind === 'approval' ? action === 'approve' || action === 'deny' : action === 'answer';
    }
    if (record.kind === 'approval') return action === 'deny' || action === 'pass';
    return action === 'answer' && this.classify(record) === 'any';
  }
}
