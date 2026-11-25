// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type DecisionAuthority = 'human' | 'any';
export type DecisionActor = { kind: 'human' } | { kind: 'agent'; agentId?: string; label?: string; threadId?: string; note?: string };
export type DecisionRouteEntry = {
  threadId: string;
  channel: string;
  agentId: string;
  label?: string;
  jobId?: string;
  taskIndex?: number;
  kind: 'agent' | 'human';
};
export type DecisionRouteHistoryEntry = {
  threadId: string;
  agentId: string;
  action: 'answered' | 'passed' | 'denied' | 'approved' | 'deferred' | 'timeout' | 'unavailable';
  at: number;
  note?: string;
};
export interface DecisionRoute {
  authority: DecisionAuthority;
  chain: DecisionRouteEntry[];
  holderIndex: number;
  holderSince: number;
  holderDeadline?: number | null;
  deliveredAt?: number | null;
  history: DecisionRouteHistoryEntry[];
}

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
  answerDelivery?:         'queued' | 'processing' | 'delivered' | 'interrupted' | 'unavailable';
  answerAttempt?:          string;
  /** Presentation-only link to a newer answered copy; never settles another request. */
  supersededBy?:           string;
  /** Exact durable ancestry; kept after completed worker jobs are pruned. */
  relatedConversationIds?: string[];
  /** Durable identity of an agent that requested an approval from a delegated thread. */
  requestedBy?: { agentId?: string; label?: string; jobId?: string; taskIndex?: number };
  /** Trusted card copy persisted with the decision, never recovered from transcript text. */
  approvalPresentation?: { reason: string; command: string; origin: { kind: string } };
  /** Parent-first authority snapshot and current holder; omitted by legacy records. */
  route?: DecisionRoute;
  /** Persisted identity of the actor who completed the decision; omitted by legacy records. */
  answeredBy?: DecisionActor;
  questions?:              { question: string; header?: string; multiSelect?: boolean; task?: boolean; command?: string; options: { label: string; description?: string }[] }[];
  /** What the user chose, kept so an answer survives even if delivering it fails. */
  answers?:                { question: string; selected: string[] }[];
  /** Opaque, local-only action data consumed by the Desktop main process. */
  payload?:                Record<string, string>;
}
export interface DecisionResponse {
  id:             string;
  conversationId: string;
  action:         'approved' | 'denied' | 'answered' | 'deferred' | 'passed';
  answers?:       { question: string; selected: string[] }[];
  note?:          string;
}
export interface DecisionOutcome {
  status:  DecisionRecord['status'];
  answers: { question: string; selected: string[] }[];
  answeredBy?: DecisionActor;
  note?: string;
}
