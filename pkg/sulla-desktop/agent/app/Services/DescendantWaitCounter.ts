// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';
import { LiveTaskStatusProjector } from './LiveTaskStatusProjector';

/** Lineage read for one snapshot: every job launched beneath a parent thread, at any depth. */
export interface AgentDescendantLineageReader {
  descendants(parentThreadId: string): AgentJob[];
}

/** Counts live tasks beneath one task's thread, so a parked manager reports its grandchildren as waiting. */
export class DescendantWaitCounter {
  constructor(
    private readonly lineage: AgentDescendantLineageReader,
    private readonly liveness: LiveTaskStatusProjector = new LiveTaskStatusProjector(),
  ) {}

  runningDescendantsOf(task: Pick<AgentJobTask, 'threadId'>): number {
    if (!task.threadId) return 0;
    return this.lineage.descendants(task.threadId)
      .reduce((sum, job) => sum + job.tasks.filter(item => this.liveness.isLive(item)).length, 0);
  }
}
