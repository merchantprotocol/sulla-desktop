// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface DecisionRecord {
  id:             string;
  conversationId: string;
  channel:        string;
  title:          string;
  kind:           'approval' | 'question';
  status:         'pending' | 'deferred' | 'approved' | 'denied' | 'answered' | 'expired';
  createdAt:      number;
  expiresAt:      number;
  toolName?:      string;
  questions?:     { question: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
  /** Opaque, local-only action data consumed by the Desktop main process. */
  payload?:       Record<string, string>;
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
