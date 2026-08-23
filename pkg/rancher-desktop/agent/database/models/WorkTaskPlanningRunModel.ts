import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

import type { WorkTaskRecord } from './WorkItemsModel';
import type { PoolClient } from 'pg';

export const PROJECT_TASK_PLANNING_WORKFLOW_ID = 'core-routine-plan-project-task';

export type WorkTaskPlanningRunStatus = 'active' | 'completed' | 'blocked' | 'failed' | 'stale';

export interface WorkTaskPlanningRunRecord {
  id:             string;
  task_id:        string;
  workflow_id:    string;
  execution_id:   string | null;
  status:         WorkTaskPlanningRunStatus;
  trigger_status: string;
  trigger_actor:  string | null;
  attempt:        number;
  error:          string | null;
  started_at:     string;
  heartbeat_at:   string;
  finished_at:    string | null;
}

export interface ClaimedPlanningRun {
  run:  WorkTaskPlanningRunRecord;
  task: WorkTaskRecord;
}

export class WorkTaskPlanningRunModel {
  /**
   * Atomically claims a planning council. A blocked task becomes planning in
   * the same transaction; an already-planning task is left untouched.
   */
  static async claim(
    taskId: string,
    triggerStatus: 'blocked' | 'planning',
    actor?: string,
  ): Promise<ClaimedPlanningRun | null> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const taskResult = await client.query<WorkTaskRecord>(`
        SELECT * FROM work_tasks
         WHERE id = $1 AND archived = false
         FOR UPDATE
      `, [taskId]);
      const task = taskResult.rows[0];
      if (!task || !['blocked', 'planning'].includes(task.status)) return null;

      const active = await client.query<{ id: string }>(`
        SELECT id FROM work_task_planning_runs
         WHERE task_id = $1 AND status = 'active'
         LIMIT 1
      `, [taskId]);
      if (active.rows[0]) return null;

      const attemptResult = await client.query<{ attempt: number }>(`
        SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
          FROM work_task_planning_runs
         WHERE task_id = $1
      `, [taskId]);
      const attempt = Number(attemptResult.rows[0]?.attempt ?? 1);
      const id = `planning-${ randomUUID() }`;
      const inserted = await client.query<WorkTaskPlanningRunRecord>(`
        INSERT INTO work_task_planning_runs
          (id, task_id, workflow_id, trigger_status, trigger_actor, attempt)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [id, taskId, PROJECT_TASK_PLANNING_WORKFLOW_ID, triggerStatus, actor ?? null, attempt]);

      let claimedTask = task;
      if (task.status === 'blocked') {
        const moved = await client.query<WorkTaskRecord>(`
          UPDATE work_tasks
             SET status = 'planning', assignee = 'planning-council',
                 updated_at = now(), last_moved_at = now(),
                 last_activity_at = now(), last_moved_by = 'planning-council'
           WHERE id = $1
           RETURNING *
        `, [taskId]);
        claimedTask = moved.rows[0] ?? task;
      }

      return { run: inserted.rows[0], task: claimedTask };
    });
  }

  static async attachExecution(id: string, executionId: string): Promise<void> {
    await postgresClient.query(`
      UPDATE work_task_planning_runs
         SET execution_id = $2, heartbeat_at = now()
       WHERE id = $1 AND status = 'active'
    `, [id, executionId]);
  }

  static async settleForTask(
    taskId: string,
    status: Exclude<WorkTaskPlanningRunStatus, 'active' | 'stale'>,
    error?: string,
  ): Promise<WorkTaskPlanningRunRecord | null> {
    const row = await postgresClient.queryOne<WorkTaskPlanningRunRecord>(`
      UPDATE work_task_planning_runs
         SET status = $2, error = $3, heartbeat_at = now(), finished_at = now()
       WHERE task_id = $1 AND status = 'active'
       RETURNING *
    `, [taskId, status, error ?? null]);
    return row ?? null;
  }

  static async findActiveByExecution(executionId: string): Promise<WorkTaskPlanningRunRecord | null> {
    return await postgresClient.queryOne<WorkTaskPlanningRunRecord>(`
      SELECT * FROM work_task_planning_runs
       WHERE execution_id = $1 AND status = 'active'
       LIMIT 1
    `, [executionId]) ?? null;
  }

  /** Expire one task's abandoned claim during its next status event. */
  static async recoverStaleForTask(taskId: string, staleMinutes = 45): Promise<boolean> {
    const row = await postgresClient.queryOne<{ id: string }>(`
      UPDATE work_task_planning_runs
         SET status = 'stale',
             error = 'planning council lease expired before status retry',
             finished_at = now()
       WHERE task_id = $1
         AND status = 'active'
         AND heartbeat_at <= now() - ($2 * interval '1 minute')
       RETURNING id
    `, [taskId, staleMinutes]);
    return Boolean(row);
  }

  /** Marks expired councils stale and returns tasks that still need planning. */
  static async recoverStale(staleMinutes = 45): Promise<string[]> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const stale = await client.query<{ task_id: string }>(`
        UPDATE work_task_planning_runs
           SET status = 'stale',
               error = 'planning council lease expired or app restarted',
               finished_at = now()
         WHERE status = 'active'
           AND heartbeat_at <= now() - ($1 * interval '1 minute')
        RETURNING task_id
      `, [staleMinutes]);
      if (stale.rows.length === 0) return [];

      const ids = stale.rows.map(row => row.task_id);
      const tasks = await client.query<{ id: string }>(`
        SELECT id FROM work_tasks
         WHERE id = ANY($1::text[])
           AND archived = false
           AND status IN ('planning', 'blocked')
      `, [ids]);
      return tasks.rows.map(row => row.id);
    });
  }
}
