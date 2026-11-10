// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobTask } from '../../tools/agents/jobRegistry';

const LIVE_TASK_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'parked', 'blocked']);

/** Decides whether one task is still doing work, from that task's own lifecycle only (never its job's status). */
export class LiveTaskStatusProjector {
  isLive(task: Pick<AgentJobTask, 'status' | 'returnedAt' | 'finishedAt'>): boolean {
    return LIVE_TASK_STATUSES.has(task.status) && !task.returnedAt && !task.finishedAt;
  }
}
