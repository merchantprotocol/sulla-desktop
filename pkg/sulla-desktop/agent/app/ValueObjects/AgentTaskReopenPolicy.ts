// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobTaskStatus } from '../../tools/agents/jobRegistry';

export type AgentTaskReopenRefusalReason = 'active_lease' | 'failed' | 'limit_reached' | 'not_finished' | 'stopped';
export type AgentTaskReopenDecision = { allowed: true } | { allowed: false; reason: AgentTaskReopenRefusalReason };

/** Pure policy for deciding whether a settled task may start another generation. */
export class AgentTaskReopenPolicy {
  static readonly MAX_REOPENS = 5;

  constructor(private readonly maxReopens = AgentTaskReopenPolicy.MAX_REOPENS) {}

  decide(status: AgentJobTaskStatus, reopenCount: number, hasActiveLease: boolean): AgentTaskReopenDecision {
    if (hasActiveLease) return { allowed: false, reason: 'active_lease' };
    if (status === 'stopped') return { allowed: false, reason: 'stopped' };
    if (status === 'error') return { allowed: false, reason: 'failed' };
    if (!['completed', 'blocked'].includes(status)) return { allowed: false, reason: 'not_finished' };
    if (reopenCount >= this.maxReopens) return { allowed: false, reason: 'limit_reached' };
    return { allowed: true };
  }
}
