import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';
import { LifecycleCapabilityModel, type LifecycleStageClaim } from './LifecycleCapabilityModel';

import type { WorkTaskRecord } from './WorkItemsModel';
import type { PoolClient } from 'pg';

export type WorkTaskDispatchStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'stale';

export interface WorkTaskDispatchRecord {
  id:           string;
  task_id:      string;
  agent_id:     string;
  thread_id:    string;
  status:       WorkTaskDispatchStatus;
  result:       string | null;
  error:        string | null;
  started_at:   string;
  heartbeat_at: string;
  finished_at:  string | null;
}

export interface ClaimedDispatch {
  dispatch:    WorkTaskDispatchRecord;
  task:        WorkTaskRecord;
  stage_claim: LifecycleStageClaim;
}

const CLOSED_EPIC_STATUSES = ['done', 'cancelled', 'parked', 'blocked'];
const NON_AUTONOMOUS_LABELS = ['gated', 'decision', 'human', 'manual', 'no-auto-dispatch'];

export class WorkTaskDispatchModel {
  static async claimNext(agentId: string, runtimeInstanceId: string): Promise<ClaimedDispatch | null> {
    return postgresClient.transaction(async(client) => {
      const candidate = await client.query<WorkTaskRecord>(`
        SELECT t.*
          FROM work_tasks t
          JOIN work_epics e ON e.id = t.epic_id
         WHERE t.archived = false
           AND t.status = 'todo'
           AND e.archived = false
           AND NOT (e.status = ANY($1::text[]))
           AND (t.assignee IS NULL OR LOWER(t.assignee) IN ('heartbeat', 'dispatcher'))
           AND NOT EXISTS (
             SELECT 1
               FROM unnest(COALESCE(t.labels, '{}')) AS label
              WHERE LOWER(label) = ANY($2::text[])
           )
           AND NOT EXISTS (
             SELECT 1 FROM work_task_dispatches d
              WHERE d.task_id = t.id AND d.status = 'running'
           )
           AND NOT EXISTS (
             SELECT 1 FROM work_task_stage_claims c
              WHERE c.task_id = t.id AND c.stage = 'in_progress' AND c.status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM work_tasks child
              WHERE child.parent_id = t.id
                AND child.archived = false
                AND child.status NOT IN ('done', 'cancelled', 'parked')
           )
         ORDER BY
           CASE e.priority
             WHEN 'critical' THEN 0 WHEN 'p0' THEN 0 WHEN 'P0' THEN 0 WHEN '🔴' THEN 0
             WHEN 'high' THEN 1 WHEN 'p1' THEN 1 WHEN 'P1' THEN 1
             WHEN 'medium' THEN 2 WHEN 'p2' THEN 2 WHEN 'P2' THEN 2 WHEN '🟡' THEN 2
             WHEN 'p3' THEN 3 WHEN 'P3' THEN 3
             WHEN 'low' THEN 4 WHEN 'p4' THEN 4 WHEN 'P4' THEN 4 WHEN '⚪' THEN 4
             ELSE 5 END,
           CASE t.priority
             WHEN 'critical' THEN 0 WHEN 'p0' THEN 0 WHEN 'P0' THEN 0 WHEN '🔴' THEN 0
             WHEN 'high' THEN 1 WHEN 'p1' THEN 1 WHEN 'P1' THEN 1
             WHEN 'medium' THEN 2 WHEN 'p2' THEN 2 WHEN 'P2' THEN 2 WHEN '🟡' THEN 2
             WHEN 'p3' THEN 3 WHEN 'P3' THEN 3
             WHEN 'low' THEN 4 WHEN 'p4' THEN 4 WHEN 'P4' THEN 4 WHEN '⚪' THEN 4
             ELSE 5 END,
           t.due_at ASC NULLS LAST,
           t.last_activity_at ASC,
           t.position ASC
         FOR UPDATE OF t SKIP LOCKED
         LIMIT 1
      `, [CLOSED_EPIC_STATUSES, NON_AUTONOMOUS_LABELS]);

      const task = candidate.rows[0];
      if (!task) return null;

      const stageClaim = await LifecycleCapabilityModel.claimStageWithClient(
        client,
        task.id,
        'todo-execution',
        'in_progress',
        'dispatcher',
        runtimeInstanceId,
      );
      if (!stageClaim.claimed || !stageClaim.claim) return null;

      const id = `dispatch-${ randomUUID() }`;
      const threadId = `task-dispatch-${ task.id }-${ Date.now() }`;
      const inserted = await client.query<WorkTaskDispatchRecord>(`
        INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [id, task.id, agentId, threadId]);

      const updated = await client.query<WorkTaskRecord>(`
        UPDATE work_tasks
           SET status = 'in_progress',
               assignee = 'dispatcher',
               updated_at = now(),
               last_moved_at = now(),
               last_activity_at = now(),
               last_moved_by = 'dispatcher'
         WHERE id = $1 AND status = 'todo'
        RETURNING *
      `, [task.id]);
      if (!updated.rows[0]) {
        throw new Error(`Atomic dispatch lost task ${ task.id } before execution handoff`);
      }

      return { dispatch: inserted.rows[0], task: updated.rows[0], stage_claim: stageClaim.claim };
    });
  }

  static async countRunning(): Promise<number> {
    const row = await postgresClient.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_task_dispatches WHERE status = 'running'`,
    );
    return Number(row?.count || 0);
  }

  static async touch(id: string): Promise<void> {
    await postgresClient.query(
      `UPDATE work_task_dispatches SET heartbeat_at = now() WHERE id = $1 AND status = 'running'`,
      [id],
    );
  }

  static async settle(
    id: string,
    status: Exclude<WorkTaskDispatchStatus, 'running' | 'stale'>,
    result?: string,
    error?: string,
  ): Promise<void> {
    await postgresClient.query(`
      UPDATE work_task_dispatches
         SET status = $2, result = $3, error = $4,
             heartbeat_at = now(), finished_at = now()
       WHERE id = $1 AND status = 'running'
    `, [id, status, result ?? null, error ?? null]);
  }

  static async recoverStale(staleMinutes = 45): Promise<string[]> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const stale = await client.query<{ id: string; task_id: string }>(`
        UPDATE work_task_dispatches
           SET status = 'stale',
               error = 'dispatcher lease expired or app restarted',
               finished_at = now()
         WHERE status = 'running'
           AND heartbeat_at < now() - ($1 * interval '1 minute')
        RETURNING id, task_id
      `, [staleMinutes]);

      const taskIds = stale.rows.map(row => row.task_id);
      if (taskIds.length > 0) {
        await client.query(`
          UPDATE work_tasks
             SET status = 'todo', assignee = NULL,
                 updated_at = now(), last_moved_at = now(),
                 last_activity_at = now(), last_moved_by = 'dispatcher'
           WHERE id = ANY($1::text[]) AND status = 'in_progress' AND assignee = 'dispatcher'
        `, [taskIds]);
      }
      return taskIds;
    });
  }
}
