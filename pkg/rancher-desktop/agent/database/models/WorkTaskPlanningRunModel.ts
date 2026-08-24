import { randomUUID } from 'node:crypto';
import { WorkTaskDependencyModel } from './WorkTaskDependencyModel';
import { WorkTaskWaitModel } from './WorkTaskWaitModel';

import { postgresClient } from '../PostgresClient';
import { LifecycleCapabilityModel } from './LifecycleCapabilityModel';
import { WorkLaneDefinitionModel } from './WorkLaneDefinitionModel';

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
  private static async reportStaleRecoveryDegraded(reason: string): Promise<void> {
    await LifecycleCapabilityModel.report({
      key:          'planning-council',
      enabled:      true,
      health:       'degraded',
      owner:        'planning-council',
      fallbackMode: 'keep_current',
      error:        `Planning stale recovery entered stable-key compatibility mode: ${ reason }`,
    }).catch(reportError => console.warn(
      '[PlanningCouncil] Could not persist degraded stale-recovery capability:', reportError,
    ));
  }

  /**
   * Atomically claims a planning council. A blocked task becomes planning in
   * the same transaction; an already-planning task is left untouched.
   */
  static async claim(
    taskId: string,
    triggerStatus: string,
    actor?: string,
  ): Promise<ClaimedPlanningRun | null> {
    const preview = await postgresClient.queryOne<{ project_id: string }>(
      'SELECT project_id FROM work_tasks WHERE id = $1 AND archived = false', [taskId],
    );
    if (!preview) return null;
    const capability = await WorkLaneDefinitionModel.runtimeCapability(preview.project_id);
    const planningKeys = capability.ready
      ? await WorkLaneDefinitionModel.laneKeysForRoles(preview.project_id, ['planning', 'blocked'])
      : ['planning', 'blocked'];
    const planningLaneKey = await WorkLaneDefinitionModel.preferredLaneKey(
      preview.project_id, 'planning', 'planning',
    );
    return postgresClient.transaction(async(client: PoolClient) => {
      const taskResult = await client.query<WorkTaskRecord>(`
        SELECT * FROM work_tasks
         WHERE id = $1 AND archived = false
         FOR UPDATE
      `, [taskId]);
      const task = taskResult.rows[0];
      if (!task || !planningKeys.includes(task.status)) return null;
      if ((await WorkTaskDependencyModel.listUnresolvedDependencies(taskId, client)).length > 0) return null;
      // A blocked task with an active monitor-owned durable wait is not eligible
      // for planning re-entry: its wait monitor moves the task out of 'blocked'
      // (to in_review, or to planning on failure) once the external state
      // changes, is satisfied, or is cancelled. Claiming planning while the wait
      // is still 'active' spuriously burns a council attempt on an unchanged gate
      // (regression: KEfo planning attempt 5 fired against an active external_job wait).
      if (triggerStatus === 'blocked' && await WorkTaskWaitModel.hasActiveWait(taskId, client)) return null;

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
      const currentLane = capability.ready
        ? await WorkLaneDefinitionModel.resolveStatus(task.project_id, task.status)
        : null;
      if ((currentLane?.semantic_role ?? task.status) === 'blocked') {
        const moved = await client.query<WorkTaskRecord>(`
          UPDATE work_tasks
             SET status = $2, assignee = 'planning-council',
                 updated_at = now(), last_moved_at = now(),
                 last_activity_at = now(), last_moved_by = 'planning-council'
           WHERE id = $1
           RETURNING *
        `, [taskId, planningLaneKey]);
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

  /** Refresh the task-scoped lease after each durable workflow checkpoint. */
  static async touchByExecution(executionId: string): Promise<void> {
    await postgresClient.query(`
      UPDATE work_task_planning_runs
         SET heartbeat_at = now()
       WHERE execution_id = $1 AND status = 'active'
    `, [executionId]);
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
    const degradedReasons: string[] = [];
    const recovered = await postgresClient.transaction(async(client: PoolClient) => {
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
      const taskRows = await client.query<{ id: string; project_id: string; status: string }>(`
        SELECT id, project_id, status FROM work_tasks
         WHERE id = ANY($1::text[]) AND archived = false
      `, [ids]);
      const projectIds = [...new Set(taskRows.rows.map(row => row.project_id))];
      const capabilities = new Map(await Promise.all(projectIds.map(async(projectId) => [
        projectId,
        await WorkLaneDefinitionModel.runtimeCapability(projectId),
      ] as const)));
      const degradedProjects = projectIds.filter(projectId => !capabilities.get(projectId)?.ready);
      if (degradedProjects.length > 0) {
        const reasons = degradedProjects.map(projectId =>
          `${ projectId }: ${ capabilities.get(projectId)?.degradedReason ?? 'semantic lane capability unavailable' }`,
        );
        degradedReasons.push(...reasons);
      }

      const healthyIds = taskRows.rows
        .filter(row => capabilities.get(row.project_id)?.ready)
        .map(row => row.id);
      let semanticIds: string[] = [];
      let semanticQueryFailed = false;
      if (healthyIds.length > 0) {
        try {
          const tasks = await client.query<{ id: string }>(`
        SELECT task.id FROM work_tasks task
        JOIN LATERAL (
          SELECT lane.semantic_role FROM work_lane_definitions lane
           WHERE lane.reset_at IS NULL AND lane.archived = false AND lane.enabled = true
             AND lane.lane_key = task.status
             AND (lane.scope = 'global_default'
               OR (lane.scope = 'project' AND lane.project_id = task.project_id))
           ORDER BY CASE WHEN lane.scope = 'project' THEN 0 ELSE 1 END LIMIT 1
        ) effective ON true
         WHERE task.id = ANY($1::text[])
           AND task.archived = false
           AND effective.semantic_role IN ('planning', 'blocked')
          `, [healthyIds]);
          semanticIds = tasks.rows.map(row => row.id);
        } catch (error) {
          semanticQueryFailed = true;
          const message = error instanceof Error ? error.message : String(error);
          degradedReasons.push(
            `semantic role query failed after capability passed: ${ message }`,
          );
        }
      }

      const compatibilityIds = taskRows.rows
        .filter(row => semanticQueryFailed || !capabilities.get(row.project_id)?.ready)
        .filter(row => row.status === 'planning' || row.status === 'blocked')
        .map(row => row.id);
      return [...new Set([...semanticIds, ...compatibilityIds])];
    });
    if (degradedReasons.length > 0) {
      await WorkTaskPlanningRunModel.reportStaleRecoveryDegraded(degradedReasons.join('; '));
    }
    return recovered;
  }
}
