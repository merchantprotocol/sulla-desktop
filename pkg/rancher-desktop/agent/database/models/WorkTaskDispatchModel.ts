import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

import type { WorkTaskRecord } from './WorkItemsModel';
import type { PoolClient } from 'pg';

export type WorkTaskDispatchStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'stale';

export interface WorkTaskDispatchRecord {
  id:                     string;
  task_id:                string;
  agent_id:               string;
  thread_id:              string;
  status:                 WorkTaskDispatchStatus;
  result:                 string | null;
  error:                  string | null;
  started_at:             string;
  heartbeat_at:           string;
  finished_at:            string | null;
  run_kind?:              string;
  workflow_execution_id?: string | null;
  classifier_decision?:   unknown;
  selected_agents?:       unknown[];
  worker_child_ids?:      string[];
  artifact_type?:         string | null;
  artifact_location?:     string | null;
  artifact_url?:          string | null;
  artifact_ref?:          string | null;
  content_hash?:          string | null;
  reviewer_verdict?:      string | null;
  review_evidence?:       unknown;
  terminal_reason?:       string | null;
}

export interface WorkTaskDispatchEvidence {
  workflowExecutionId?: string;
  classifierDecision?:  unknown;
  selectedAgents?:      unknown[];
  workerChildIds?:      string[];
  reviewCount?:         number;
  repairCount?:         number;
  artifactType?:        string;
  artifactLocation?:    string;
  artifactUrl?:         string;
  artifactRef?:         string;
  contentHash?:         string;
  reviewerVerdict?:     string;
  reviewEvidence?:      unknown;
  terminalReason?:      string;
}

export interface ClaimedDispatch {
  dispatch: WorkTaskDispatchRecord;
  task:     WorkTaskRecord;
}

export interface WorkTaskDispatchFinalization {
  dispatchStatus: Exclude<WorkTaskDispatchStatus, 'running' | 'stale'>;
  taskStatus:     'in_review' | 'planning' | 'blocked';
  taskAssignee:   'heartbeat' | 'dispatcher';
  comment:        string;
  result?:        string;
  error?:         string;
  evidence?:      WorkTaskDispatchEvidence;
}

const CLOSED_EPIC_STATUSES = ['done', 'cancelled', 'parked', 'blocked'];
const NON_AUTONOMOUS_LABELS = ['gated', 'decision', 'human', 'manual', 'no-auto-dispatch'];

export class WorkTaskDispatchModel {
  static async claimNext(agentId: string, runKind = 'core-todo'): Promise<ClaimedDispatch | null> {
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

      const id = `dispatch-${ randomUUID() }`;
      const threadId = `task-dispatch-${ task.id }-${ Date.now() }`;
      const inserted = await client.query<WorkTaskDispatchRecord>(`
        INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, run_kind, attempt_count)
        VALUES (
          $1, $2, $3, $4, $5,
          (SELECT COALESCE(MAX(attempt_count), 0) + 1 FROM work_task_dispatches WHERE task_id = $2)
        )
        RETURNING *
      `, [id, task.id, agentId, threadId, runKind]);

      await client.query(`
        UPDATE work_tasks
           SET status = 'in_progress',
               assignee = 'dispatcher',
               updated_at = now(),
               last_moved_at = now(),
               last_activity_at = now(),
               last_moved_by = 'dispatcher'
         WHERE id = $1
      `, [task.id]);

      return { dispatch: inserted.rows[0], task };
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

  static async recordEvidence(id: string, evidence: WorkTaskDispatchEvidence): Promise<void> {
    await postgresClient.query(`
      UPDATE work_task_dispatches
         SET workflow_execution_id = COALESCE($2, workflow_execution_id),
             classifier_decision = COALESCE($3::jsonb, classifier_decision),
             selected_agents = COALESCE($4::jsonb, selected_agents),
             worker_child_ids = COALESCE($5::text[], worker_child_ids),
             review_count = GREATEST(review_count, COALESCE($6, review_count)),
             repair_count = GREATEST(repair_count, COALESCE($7, repair_count)),
             artifact_type = COALESCE($8, artifact_type),
             artifact_location = COALESCE($9, artifact_location),
             artifact_url = COALESCE($10, artifact_url),
             artifact_ref = COALESCE($11, artifact_ref),
             content_hash = COALESCE($12, content_hash),
             reviewer_verdict = COALESCE($13, reviewer_verdict),
             review_evidence = COALESCE($14::jsonb, review_evidence),
             terminal_reason = COALESCE($15, terminal_reason),
             heartbeat_at = now()
       WHERE id = $1 AND status = 'running'
    `, [
      id,
      evidence.workflowExecutionId ?? null,
      evidence.classifierDecision === undefined ? null : JSON.stringify(evidence.classifierDecision),
      evidence.selectedAgents === undefined ? null : JSON.stringify(evidence.selectedAgents),
      evidence.workerChildIds ?? null,
      evidence.reviewCount ?? null,
      evidence.repairCount ?? null,
      evidence.artifactType ?? null,
      evidence.artifactLocation ?? null,
      evidence.artifactUrl ?? null,
      evidence.artifactRef ?? null,
      evidence.contentHash ?? null,
      evidence.reviewerVerdict ?? null,
      evidence.reviewEvidence === undefined ? null : JSON.stringify(evidence.reviewEvidence),
      evidence.terminalReason ?? null,
    ]);
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

  /**
   * Commit the terminal ledger, Projects comment, and task transition as one
   * unit. A crash cannot leave a terminal dispatch attached to an in-progress
   * task (or move the task without retaining the evidence that justified it).
   */
  static async finalize(id: string, taskId: string, finalization: WorkTaskDispatchFinalization): Promise<WorkTaskRecord> {
    const evidence = finalization.evidence ?? {};
    return postgresClient.transaction(async(client: PoolClient) => {
      const locked = await client.query<{ status: WorkTaskDispatchStatus }>(
        'SELECT status FROM work_task_dispatches WHERE id = $1 AND task_id = $2 FOR UPDATE',
        [id, taskId],
      );
      if (locked.rows[0]?.status !== 'running') {
        throw new Error(`Dispatch ${ id } is not running and cannot be finalized`);
      }

      await client.query(`
        UPDATE work_task_dispatches
           SET status = $3, result = $4, error = $5,
               workflow_execution_id = COALESCE($6, workflow_execution_id),
               classifier_decision = COALESCE($7::jsonb, classifier_decision),
               selected_agents = COALESCE($8::jsonb, selected_agents),
               worker_child_ids = COALESCE($9::text[], worker_child_ids),
               review_count = GREATEST(review_count, COALESCE($10, review_count)),
               repair_count = GREATEST(repair_count, COALESCE($11, repair_count)),
               artifact_type = COALESCE($12, artifact_type),
               artifact_location = COALESCE($13, artifact_location),
               artifact_url = COALESCE($14, artifact_url),
               artifact_ref = COALESCE($15, artifact_ref),
               content_hash = COALESCE($16, content_hash),
               reviewer_verdict = COALESCE($17, reviewer_verdict),
               review_evidence = COALESCE($18::jsonb, review_evidence),
               terminal_reason = COALESCE($19, terminal_reason),
               heartbeat_at = now(), finished_at = now()
         WHERE id = $1 AND task_id = $2 AND status = 'running'
      `, [
        id,
        taskId,
        finalization.dispatchStatus,
        finalization.result ?? null,
        finalization.error ?? null,
        evidence.workflowExecutionId ?? null,
        evidence.classifierDecision === undefined ? null : JSON.stringify(evidence.classifierDecision),
        evidence.selectedAgents === undefined ? null : JSON.stringify(evidence.selectedAgents),
        evidence.workerChildIds ?? null,
        evidence.reviewCount ?? null,
        evidence.repairCount ?? null,
        evidence.artifactType ?? null,
        evidence.artifactLocation ?? null,
        evidence.artifactUrl ?? null,
        evidence.artifactRef ?? null,
        evidence.contentHash ?? null,
        evidence.reviewerVerdict ?? null,
        evidence.reviewEvidence === undefined ? null : JSON.stringify(evidence.reviewEvidence),
        evidence.terminalReason ?? null,
      ]);

      await client.query(`
        INSERT INTO work_task_comments (id, task_id, body, author)
        VALUES ($1, $2, $3, 'dispatcher')
      `, [`dispatch-comment-${ randomUUID() }`, taskId, finalization.comment]);

      const moved = await client.query<WorkTaskRecord>(`
        UPDATE work_tasks
           SET status = $2, assignee = $3, updated_at = now(),
               last_moved_at = now(), last_activity_at = now(),
               last_moved_by = 'dispatcher', completed_at = NULL
         WHERE id = $1 AND status = 'in_progress' AND assignee = 'dispatcher'
         RETURNING id
      `, [taskId, finalization.taskStatus, finalization.taskAssignee]);
      if (!moved.rows[0]) {
        throw new Error(`Task ${ taskId } is no longer owned by dispatch ${ id }`);
      }
      return moved.rows[0];
    });
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
          WITH latest AS (
            SELECT DISTINCT ON (task_id)
                   task_id,
                   artifact_url IS NOT NULL
                     AND content_hash IS NOT NULL
                     AND reviewer_verdict = 'pass' AS custody_complete
              FROM work_task_dispatches
             WHERE task_id = ANY($1::text[])
               AND status = 'stale'
             ORDER BY task_id, started_at DESC
          )
          UPDATE work_tasks t
             SET status = CASE WHEN latest.custody_complete THEN 'in_review' ELSE 'todo' END,
                 assignee = CASE WHEN latest.custody_complete THEN 'heartbeat' ELSE NULL END,
                 updated_at = now(), last_moved_at = now(),
                 last_activity_at = now(), last_moved_by = 'dispatcher'
            FROM latest
           WHERE t.id = latest.task_id
             AND t.status = 'in_progress'
             AND t.assignee = 'dispatcher'
        `, [taskIds]);
      }
      return taskIds;
    });
  }
}
