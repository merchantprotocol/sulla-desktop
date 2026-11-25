// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';

/** Isolates the indexed child-work lookup from the broad AgentJobRepository. */
export class AgentJobChildrenQuery {
  constructor(private readonly connection: PostgresConnection) {}

  async hasRunningChildren(jobId: string, taskIndex: number): Promise<boolean> {
    const rows = await this.connection.select(`SELECT EXISTS (
      SELECT 1 FROM agent_jobs child
      WHERE child.parent_job_id = $1 AND child.parent_task_index = $2
        AND child.status IN ('running', 'parked')
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(child.tasks) AS child_task(value)
          WHERE child_task.value->>'status' IN ('queued', 'running', 'parked')
            -- An open blocker is still live work the parent is waiting on (AgentStateService.isOpenBlocker).
            OR (child_task.value->>'status' = 'blocked'
              AND child_task.value->>'returnedAt' IS NULL AND child_task.value->>'finishedAt' IS NULL)
        )
    ) AS has_running_children`, [jobId, taskIndex]);
    return rows[0]?.has_running_children === true;
  }
}
