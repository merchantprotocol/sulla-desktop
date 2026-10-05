import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';
import { LiveWriterRegistry } from '../../services/LiveWriterRegistry';
import { agentAdmissionSql, noWriterEvidenceSql } from './WorkAgentAdmission';
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
  /**
   * Atomically claims a council without moving unfinished work out of its lane.
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
    const admission = await agentAdmissionSql('t', 'planning-council');
    return postgresClient.transaction(async(client: PoolClient) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('projects-agent-admission'))");
      const taskResult = await client.query<WorkTaskRecord>(`
        SELECT t.* FROM work_tasks t
         WHERE t.id = $1 AND t.archived = false
           ${ admission }
           AND EXISTS (SELECT 1 FROM work_projects p WHERE p.id = t.project_id AND p.dispatch_enabled = true)
         FOR UPDATE
      `, [taskId]);
      const task = taskResult.rows[0];
      if (!task || !planningKeys.includes(task.status)) return null;

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

      return { run: inserted.rows[0], task };
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

  /** Expire one task's orphaned council during its next status event. */
  static async recoverStaleForTask(taskId: string, staleMinutes = 45): Promise<boolean> {
    return (await WorkTaskPlanningRunModel.recoverOrphans(staleMinutes, taskId)).length > 0;
  }

  /**
   * Mark orphaned councils stale and return their task ids. The terminal
   * callback still owns normal settlement; this only fires when no writer
   * evidence remains (see noWriterEvidenceSql), so a council whose workflow is
   * still heartbeating or whose child agent job is still running is kept.
   */
  static async recoverStale(staleMinutes = 45): Promise<string[]> {
    return WorkTaskPlanningRunModel.recoverOrphans(staleMinutes);
  }

  private static async recoverOrphans(staleMinutes: number, taskId?: string): Promise<string[]> {
    const rows = await postgresClient.query<{ task_id: string }>(`
      UPDATE work_task_planning_runs run
         SET status = 'stale',
             error = 'no live writer evidence: council heartbeat, workflow execution and agent jobs all silent',
             finished_at = now()
       WHERE run.status = 'active'
         AND ($2::text IS NULL OR run.task_id = $2)
         AND run.heartbeat_at < now() - ($1::int * interval '1 minute')
         ${ noWriterEvidenceSql('run.task_id', 'run.execution_id', '$1::int', '$3::text[]') }
      RETURNING run.task_id
    `, [Math.max(0, Math.floor(staleMinutes)), taskId ?? null, LiveWriterRegistry.executionIds()]);
    return [...new Set(rows.map(row => row.task_id))];
  }
}
