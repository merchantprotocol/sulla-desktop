// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobTask } from '../../tools/agents/jobRegistry';
import { LiveTaskStatusProjector } from './LiveTaskStatusProjector';

export interface UnresolvedBlockerInput {
  task: AgentJobTask;
  /** Latest check-in of the task, if any. Only its blockers matter; older blockers were superseded. */
  checkin: { createdAt: number; blockers?: string[] } | null;
  /** Latest time an orchestrator message was delivered to this task (the parent's answer). */
  answeredAt: number | null;
  startedAt: number;
  /** When present, the durable blocker decision is authoritative over check-in telemetry. */
  openDecision?: boolean;
}

/**
 * New blocker state follows the durable decision inbox. The legacy check-in rule
 * remains only for projections that do not provide that reader.
 */
export class UnresolvedBlockerPolicy {
  constructor(private readonly liveness: LiveTaskStatusProjector = new LiveTaskStatusProjector()) {}

  /** Number of unresolved blockers this task currently holds (0 when resolved). */
  unresolvedCount(input: UnresolvedBlockerInput): number {
    if (input.openDecision !== undefined) return input.openDecision ? 1 : 0;
    if (!this.liveness.isLive(input.task)) return 0;
    const reported = input.checkin?.blockers?.length ?? 0;
    if (reported === 0 && (input.checkin || input.task.status !== 'blocked')) return 0;
    const raisedAt = input.checkin?.createdAt ?? input.startedAt;
    if ((input.answeredAt ?? 0) > raisedAt) return 0;
    return Math.max(reported, 1);
  }
}
