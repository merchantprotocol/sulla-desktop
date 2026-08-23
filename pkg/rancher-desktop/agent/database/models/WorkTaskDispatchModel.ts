import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';
import { AUTONOMOUS_TASK_ASSIGNEES, NON_AUTONOMOUS_TASK_LABELS, TASK_ASSIGNEES } from './TaskOwnership';

import type { WorkTaskRecord } from './WorkItemsModel';
import type { PoolClient } from 'pg';

export type WorkTaskDispatchStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'stale';
export type WorkTaskDispatchKind = 'execution' | 'verification';
export type VerificationVerdict = 'APPROVE' | 'REWORK' | 'BLOCKED';

export interface WorkTaskDispatchRecord {
  id:           string;
  task_id:      string;
  agent_id:     string;
  thread_id:    string;
  status:       WorkTaskDispatchStatus;
  kind:         WorkTaskDispatchKind;
  attempt:      number;
  verdict:      VerificationVerdict | null;
  artifact_sha: string | null;
  failure_reason: string | null;
  result:       string | null;
  error:        string | null;
  started_at:   string;
  heartbeat_at: string;
  finished_at:  string | null;
}

export interface ClaimedDispatch {
  dispatch: WorkTaskDispatchRecord;
  task:     WorkTaskRecord;
}

const CLOSED_EPIC_STATUSES = ['done', 'cancelled', 'parked', 'blocked'];
export class WorkTaskDispatchModel {
  static async claimNext(agentId: string): Promise<ClaimedDispatch | null> {
    return postgresClient.transaction(async(client) => {
      const candidate = await client.query<WorkTaskRecord>(`
        SELECT t.*
          FROM work_tasks t
          JOIN work_epics e ON e.id = t.epic_id
         WHERE t.archived = false
           AND t.status = 'todo'
           AND e.archived = false
           AND NOT (e.status = ANY($1::text[]))
           AND (t.assignee IS NULL OR LOWER(t.assignee) = ANY($2::text[]))
           AND NOT EXISTS (
             SELECT 1
               FROM unnest(COALESCE(t.labels, '{}')) AS label
              WHERE LOWER(label) = ANY($3::text[])
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
      `, [CLOSED_EPIC_STATUSES, AUTONOMOUS_TASK_ASSIGNEES, NON_AUTONOMOUS_TASK_LABELS]);

      const task = candidate.rows[0];
      if (!task) return null;

      const id = `dispatch-${ randomUUID() }`;
      const threadId = `task-dispatch-${ task.id }-${ Date.now() }`;
      const inserted = await client.query<WorkTaskDispatchRecord>(`
        INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, kind, attempt)
        VALUES ($1, $2, $3, $4, 'execution', COALESCE((
          SELECT MAX(attempt) + 1 FROM work_task_dispatches
           WHERE task_id = $2 AND kind = 'execution'
        ), 1))
        RETURNING *
      `, [id, task.id, agentId, threadId]);

      await client.query(`
        UPDATE work_tasks
           SET status = 'planning',
               assignee = $2,
               updated_at = now(),
               last_moved_at = now(),
               last_activity_at = now(),
               last_moved_by = $2
         WHERE id = $1
      `, [task.id, TASK_ASSIGNEES.dispatcher]);

      return { dispatch: inserted.rows[0], task };
    });
  }

  static async claimNextReview(agentId: string): Promise<ClaimedDispatch | null> {
    return postgresClient.transaction(async(client) => {
      const candidate = await client.query<WorkTaskRecord>(`
        SELECT t.*
          FROM work_tasks t
          JOIN work_epics e ON e.id = t.epic_id
          JOIN work_projects p ON p.id = e.project_id
         WHERE t.archived = false
           AND t.status = 'in_review'
           AND e.archived = false
           AND p.archived = false
           AND NOT (p.status = ANY($1::text[]))
           AND NOT (e.status = ANY($1::text[]))
           AND (t.assignee IS NULL OR LOWER(t.assignee) IN ('heartbeat', 'dispatcher', 'verifier'))
           AND NOT EXISTS (
             SELECT 1 FROM unnest(COALESCE(t.labels, '{}')) AS label
              WHERE LOWER(label) = ANY($2::text[])
           )
           AND NOT EXISTS (
             SELECT 1 FROM work_task_dispatches d
              WHERE d.task_id = t.id AND d.status = 'running'
           )
           AND NOT EXISTS (
             SELECT 1 FROM work_task_dispatches d
              WHERE d.task_id = t.id AND d.kind = 'verification'
                AND d.status IN ('failed', 'stale')
                AND d.finished_at > now() - interval '5 minutes'
           )
           AND COALESCE((
             SELECT d.agent_id
               FROM work_task_dispatches d
              WHERE d.task_id = t.id AND d.kind = 'execution'
              ORDER BY d.started_at DESC LIMIT 1
           ), '') <> $3
         ORDER BY
           CASE p.priority
             WHEN 'critical' THEN 0 WHEN 'p0' THEN 0 WHEN 'P0' THEN 0 WHEN '🔴' THEN 0
             WHEN 'high' THEN 1 WHEN 'p1' THEN 1 WHEN 'P1' THEN 1
             WHEN 'medium' THEN 2 WHEN 'p2' THEN 2 WHEN 'P2' THEN 2 WHEN '🟡' THEN 2
             WHEN 'p3' THEN 3 WHEN 'P3' THEN 3
             WHEN 'low' THEN 4 WHEN 'p4' THEN 4 WHEN 'P4' THEN 4 WHEN '⚪' THEN 4
             ELSE 5 END,
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
      `, [CLOSED_EPIC_STATUSES, NON_AUTONOMOUS_TASK_LABELS, agentId]);

      const task = candidate.rows[0];
      if (!task) return null;

      const id = `dispatch-${ randomUUID() }`;
      const threadId = `task-verification-${ task.id }-${ Date.now() }`;
      const inserted = await client.query<WorkTaskDispatchRecord>(`
        INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, kind, attempt)
        VALUES ($1, $2, $3, $4, 'verification', COALESCE((
          SELECT MAX(attempt) + 1 FROM work_task_dispatches
           WHERE task_id = $2 AND kind = 'verification'
        ), 1))
        RETURNING *
      `, [id, task.id, agentId, threadId]);

      await client.query(`
        UPDATE work_tasks
           SET assignee = 'verifier', updated_at = now(), last_activity_at = now(),
               last_moved_at = now(), last_moved_by = 'dispatcher'
         WHERE id = $1 AND status = 'in_review'
      `, [task.id]);

      return { dispatch: inserted.rows[0], task };
    });
  }

  static async countRunning(kind?: WorkTaskDispatchKind): Promise<number> {
    const row = await postgresClient.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_task_dispatches
        WHERE status = 'running' AND ($1::text IS NULL OR kind = $1)`,
      [kind ?? null],
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
      const stale = await client.query<{ id: string; task_id: string; kind: WorkTaskDispatchKind }>(`
        UPDATE work_task_dispatches
           SET status = 'stale',
               error = 'dispatcher lease expired or app restarted',
               failure_reason = 'lease_expired',
               finished_at = now()
         WHERE status = 'running'
           AND heartbeat_at < now() - ($1 * interval '1 minute')
        RETURNING id, task_id, kind
      `, [staleMinutes]);

      const executionTaskIds = stale.rows.filter(row => row.kind === 'execution').map(row => row.task_id);
      const verificationTaskIds = stale.rows.filter(row => row.kind === 'verification').map(row => row.task_id);
      if (executionTaskIds.length > 0) {
        await client.query(`
          UPDATE work_tasks
             SET status = 'todo', assignee = NULL,
                 updated_at = now(), last_moved_at = now(),
                 last_activity_at = now(), last_moved_by = 'dispatcher'
           WHERE id = ANY($1::text[]) AND status = 'planning' AND assignee = 'dispatcher'
        `, [executionTaskIds]);
      }
      if (verificationTaskIds.length > 0) {
        await client.query(`
          UPDATE work_tasks
             SET status = 'in_review', assignee = 'heartbeat',
                 updated_at = now(), last_moved_at = now(),
                 last_activity_at = now(), last_moved_by = 'dispatcher'
           WHERE id = ANY($1::text[]) AND status = 'in_review' AND assignee = 'verifier'
        `, [verificationTaskIds]);
      }
      return stale.rows.map(row => row.task_id);
    });
  }

  /** Settle a parsed verifier verdict and its Projects transition atomically. */
  static async finalizeVerification(
    id: string,
    verdict: VerificationVerdict,
    artifactSha: string,
    currentArtifactSha: string | null,
    summary: string,
  ): Promise<VerificationVerdict | null> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const current = await client.query<{ task_id: string }>(`
        SELECT task_id FROM work_task_dispatches
         WHERE id = $1 AND kind = 'verification' AND status = 'running'
         FOR UPDATE
      `, [id]);
      const taskId = current.rows[0]?.task_id;
      if (!taskId) return null;
      if (verdict === 'APPROVE' && currentArtifactSha !== artifactSha) return null;

      let finalVerdict = verdict;
      if (verdict === 'REWORK') {
        const repeated = await client.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count FROM work_task_dispatches
           WHERE task_id = $1 AND kind = 'verification' AND verdict = 'REWORK'
             AND failure_reason = $2
        `, [taskId, summary]);
        if (Number(repeated.rows[0]?.count || 0) >= 2) finalVerdict = 'BLOCKED';
      }

      const transition = finalVerdict === 'APPROVE'
        ? { status: 'done', assignee: null }
        : finalVerdict === 'REWORK'
          ? { status: 'todo', assignee: 'dispatcher' }
          : { status: 'blocked', assignee: 'heartbeat' };
      const repeatedSuffix = finalVerdict !== verdict
        ? '\n\nRepeated identical rework reached the retry ceiling; routed to Heartbeat recovery.'
        : '';

      await client.query(`
        UPDATE work_task_dispatches
           SET status = 'completed', verdict = $2, artifact_sha = $3,
               result = $4, failure_reason = $5,
               heartbeat_at = now(), finished_at = now()
         WHERE id = $1 AND status = 'running'
      `, [id, finalVerdict, artifactSha, summary, verdict === 'REWORK' ? summary : null]);
      await client.query(`
        INSERT INTO work_task_comments (id, task_id, body, author)
        VALUES ($1, $2, $3, 'verifier')
      `, [randomUUID().slice(0, 12), taskId,
        `Verification ${ id }: ${ finalVerdict } at ${ artifactSha }.\n\n${ summary }${ repeatedSuffix }`]);
      await client.query(`
        UPDATE work_tasks
           SET status = $2, assignee = $3, updated_at = now(),
               last_moved_at = now(), last_activity_at = now(),
               last_moved_by = 'verifier',
               completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
         WHERE id = $1 AND status = 'in_review'
      `, [taskId, transition.status, transition.assignee]);
      return finalVerdict;
    });
  }

  /** Audit an infrastructure/output failure without turning it into a task blocker. */
  static async failVerification(id: string, reason: string): Promise<boolean> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const settled = await client.query<{ task_id: string }>(`
        UPDATE work_task_dispatches
           SET status = 'failed', error = $2, failure_reason = $2,
               heartbeat_at = now(), finished_at = now()
         WHERE id = $1 AND kind = 'verification' AND status = 'running'
        RETURNING task_id
      `, [id, reason]);
      const taskId = settled.rows[0]?.task_id;
      if (!taskId) return false;
      await client.query(`
        INSERT INTO work_task_comments (id, task_id, body, author)
        VALUES ($1, $2, $3, 'verifier')
      `, [randomUUID().slice(0, 12), taskId,
        `Verification ${ id } failed and was released for retry: ${ reason }`]);
      await client.query(`
        UPDATE work_tasks
           SET status = 'in_review', assignee = 'heartbeat', updated_at = now(),
               last_moved_at = now(), last_activity_at = now(), last_moved_by = 'verifier'
         WHERE id = $1 AND status = 'in_review'
      `, [taskId]);
      return true;
    });
  }
}
