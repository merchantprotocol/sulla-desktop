// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AGENT_JOB_TASK_STATUSES, type AgentJobTaskStatus } from '../tools/agents/jobRegistry';

/** Central classification for durable delegated-task lifecycle states. */
export class AgentJobTaskStatusPolicy {
  private readonly openStatuses: ReadonlySet<AgentJobTaskStatus>;
  private readonly terminalStatuses: ReadonlySet<AgentJobTaskStatus>;

  constructor(statuses: readonly AgentJobTaskStatus[] = AGENT_JOB_TASK_STATUSES) {
    this.openStatuses = new Set<AgentJobTaskStatus>(['queued', 'running', 'parked']);
    this.terminalStatuses = new Set(statuses.filter(status => !this.openStatuses.has(status)));
  }

  isOpen(status: AgentJobTaskStatus): boolean {
    return this.openStatuses.has(status);
  }

  isTerminal(status: AgentJobTaskStatus): boolean {
    return this.terminalStatuses.has(status);
  }
}
