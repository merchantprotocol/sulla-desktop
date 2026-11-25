// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionAuthority, DecisionRecord } from '@pkg/shared/decisions';

export type DecisionAgentAction = 'answer' | 'pass';
export type DecisionAction = DecisionAgentAction | 'approve' | 'deny';

/** The record-level authority rules shared by decision creation and later agent actions. */
export class DecisionAuthorityPolicy {
  classify(record: Pick<DecisionRecord, 'kind' | 'questions' | 'payload'> & Partial<Pick<DecisionRecord, 'route'>>): DecisionAuthority {
    if (record.kind === 'approval') return 'human';
    if (record.payload?.decisionAuthority === 'human' || record.questions?.some(question => question.task)) return 'human';
    if (record.route?.authority === 'human') return 'human';
    return 'any';
  }

  allows(record: Pick<DecisionRecord, 'kind' | 'questions' | 'payload'> & Partial<Pick<DecisionRecord, 'route'>>,
    action: DecisionAction, actorKind: 'agent' | 'human'): boolean {
    if (actorKind === 'human') {
      return record.kind === 'approval' ? action === 'approve' || action === 'deny' : action === 'answer';
    }
    if (record.kind === 'approval') return false;
    return (action === 'answer' || action === 'pass') && this.classify(record) === 'any';
  }
}
