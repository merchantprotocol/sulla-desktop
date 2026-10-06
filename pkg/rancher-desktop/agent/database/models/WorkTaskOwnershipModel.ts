import { postgresClient } from '../PostgresClient';

import type { PoolClient } from 'pg';

/**
 * Mechanical task ownership for agent jobs. An agent working a Projects task
 * owns it for the whole run: the task's assignee is that agent, and every
 * other writer (dispatcher, planning council, another session's job) sees the
 * owner and stays off. Ownership is taken under the same advisory lock the
 * dispatcher uses for admission, so a job and a dispatch can never both win.
 */
export interface TaskOwner {
  taskId: string;
  kind:   'dispatch' | 'stage_claim' | 'planning_council' | 'lane_automation' | 'agent_job';
  ref:    string;
}

interface OwnedAssignment {
  prior: string | null;
  owner: string;
}

export interface OwnershipClaimResult {
  claimed:   boolean;
  conflicts: TaskOwner[];
}

const ADMISSION_LOCK = "SELECT pg_advisory_xact_lock(hashtext('projects-agent-admission'))";

export class WorkTaskOwnershipModel {
  /** Every live owner of the given tasks, excluding one agent job if named. */
  static async findOwnersWithClient(client: PoolClient, taskIds: string[], excludeJobId?: string): Promise<TaskOwner[]> {
    if (taskIds.length === 0) return [];
    const rows = await client.query<{ task_id: string; kind: TaskOwner['kind']; ref: string }>(`
      SELECT task_id, 'dispatch' AS kind, id AS ref FROM work_task_dispatches
       WHERE status = 'running' AND task_id = ANY($1::text[])
      UNION ALL
      SELECT task_id, 'stage_claim', owner || ':' || id FROM work_task_stage_claims
       WHERE status = 'active' AND task_id = ANY($1::text[])
      UNION ALL
      SELECT task_id, 'planning_council', id FROM work_task_planning_runs
       WHERE status = 'active' AND task_id = ANY($1::text[])
      UNION ALL
      SELECT task_id, 'lane_automation', id FROM work_lane_entry_automations
       WHERE status = 'running' AND task_id = ANY($1::text[])
      UNION ALL
      SELECT owned.task_id, 'agent_job', job.job_id FROM agent_jobs job
       CROSS JOIN LATERAL unnest(job.project_task_ids) AS owned(task_id)
       WHERE job.status = 'running' AND owned.task_id = ANY($1::text[])
         AND ($2::text IS NULL OR job.job_id <> $2)
    `, [taskIds, excludeJobId ?? null]);
    return rows.rows.map(row => ({ taskId: row.task_id, kind: row.kind, ref: row.ref }));
  }

  /**
   * Take ownership of `assignees` (task id -> agent id) for a running job.
   * Tasks in `inherited` are already owned by the caller (a dispatcher worker
   * delegating its own task), so their existing owner is not a conflict.
   * On any conflict nothing is written and the conflicts are returned.
   */
  static async claimForJob(
    jobId: string,
    assignees: Record<string, string>,
    inherited: string[] = [],
  ): Promise<OwnershipClaimResult> {
    const taskIds = Object.keys(assignees);
    if (taskIds.length === 0) return { claimed: true, conflicts: [] };
    return postgresClient.transaction(async(client: PoolClient) => {
      await client.query(ADMISSION_LOCK);
      const contested = taskIds.filter(taskId => !inherited.includes(taskId));
      const conflicts = await WorkTaskOwnershipModel.findOwnersWithClient(client, contested, jobId);
      if (conflicts.length > 0) return { claimed: false, conflicts };

      const prior = await client.query<{ id: string; assignee: string | null }>(
        'SELECT id, assignee FROM work_tasks WHERE id = ANY($1::text[]) FOR UPDATE',
        [taskIds],
      );
      const missing = taskIds.filter(taskId => !prior.rows.some(row => row.id === taskId));
      if (missing.length > 0) {
        throw new Error(`Unknown Projects task id(s): ${ missing.join(', ') }`);
      }
      const priorAssignees: Record<string, OwnedAssignment> = Object.fromEntries(prior.rows.map(row => [
        row.id, { prior: row.assignee, owner: assignees[row.id] },
      ]));
      await client.query(`
        UPDATE agent_jobs
           SET project_task_ids = $2::text[], project_task_prior_assignees = $3::jsonb
         WHERE job_id = $1
      `, [jobId, taskIds, JSON.stringify(priorAssignees)]);
      for (const taskId of taskIds) {
        await client.query(`
          UPDATE work_tasks SET assignee = $2, updated_at = now(), last_activity_at = now()
           WHERE id = $1
        `, [taskId, assignees[taskId]]);
      }
      return { claimed: true, conflicts: [] };
    });
  }

  /**
   * Release a finished job's tasks: restore each task's prior assignee unless
   * someone reassigned it during the run. The job row's status change is what
   * actually frees the task for other writers.
   */
  static async releaseForJob(jobId: string): Promise<void> {
    await postgresClient.transaction(async(client: PoolClient) => {
      const job = await client.query<{ project_task_ids: string[]; project_task_prior_assignees: Record<string, OwnedAssignment> }>(
        'SELECT project_task_ids, project_task_prior_assignees FROM agent_jobs WHERE job_id = $1',
        [jobId],
      );
      const row = job.rows[0];
      if (!row || row.project_task_ids.length === 0) return;
      await WorkTaskOwnershipModel.restoreAssigneesWithClient(client, row.project_task_ids, row.project_task_prior_assignees);
    });
  }

  /** Restore assignees for jobs the boot sweep found dead. */
  static async releaseSweptJobs(jobIds: string[]): Promise<void> {
    for (const jobId of jobIds) {
      await WorkTaskOwnershipModel.releaseForJob(jobId).catch(err => console.warn(
        `[WorkTaskOwnership] Could not release tasks for swept job ${ jobId }:`, err,
      ));
    }
  }

  private static async restoreAssigneesWithClient(
    client: PoolClient,
    taskIds: string[],
    assignments: Record<string, OwnedAssignment>,
  ): Promise<void> {
    for (const taskId of taskIds) {
      const assignment = assignments[taskId];
      if (!assignment) continue;
      // Only undo our own assignment; a human or the task's own worker may have
      // handed it off deliberately before finishing.
      await client.query(`
        UPDATE work_tasks SET assignee = $2, updated_at = now()
         WHERE id = $1 AND assignee IS NOT DISTINCT FROM $3
      `, [taskId, assignment.prior ?? 'dispatcher', assignment.owner]);
    }
  }
}
