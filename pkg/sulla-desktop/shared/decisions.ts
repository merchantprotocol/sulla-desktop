// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface DecisionRecord {
  id:                      string;
  conversationId:          string;
  channel:                 string;
  title:                   string;
  kind:                    'approval' | 'question';
  status:                  'pending' | 'deferred' | 'approved' | 'denied' | 'answered' | 'expired';
  createdAt:               number;
  expiresAt:               number;
  toolName?:               string;
  /** Inbox lifetime is independent of the execution wait/approval lease. */
  attention?:              'active' | 'dismissed' | 'answered';
  answerDelivery?:         'queued' | 'processing' | 'delivered' | 'interrupted';
  answerAttempt?:          string;
  /** Presentation-only link to a newer answered copy; never settles another request. */
  supersededBy?:           string;
  /** Exact durable ancestry; kept after completed worker jobs are pruned. */
  relatedConversationIds?: string[];
  /** The one chat allowed to present this request as actionable. Answer delivery still targets conversationId. */
  presentationConversationId?: string;
  questions?:              { question: string; header?: string; multiSelect?: boolean; task?: boolean; command?: string; options: { label: string; description?: string }[] }[];
  /** What the user chose, kept so an answer survives even if delivering it fails. */
  answers?:                { question: string; selected: string[] }[];
  /** Opaque, local-only action data consumed by the Desktop main process. */
  payload?:                Record<string, string>;
}
export interface DecisionResponse {
  id:             string;
  conversationId: string;
  action:         'approved' | 'denied' | 'answered' | 'deferred';
  answers?:       { question: string; selected: string[] }[];
}
export interface DecisionOutcome {
  status:  DecisionRecord['status'];
  answers: { question: string; selected: string[] }[];
}
