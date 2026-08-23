import { createHash, randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';
import { AUTONOMOUS_TASK_ASSIGNEES, NON_AUTONOMOUS_TASK_LABELS, TASK_ASSIGNEES } from './TaskOwnership';

import type { WorkTaskRecord } from './WorkItemsModel';
import type { PoolClient } from 'pg';

export type WorkTaskDispatchStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'stale';
export type WorkTaskDispatchKind = 'execution' | 'verification';
export type VerificationVerdict = 'APPROVE' | 'REWORK' | 'BLOCKED';
export type ReviewDisposition = 'PASS' | 'REPAIRABLE' | 'REPLAN' | 'EXTERNAL_WAIT' | 'BLOCKED';

export interface ReviewWaitEvidence {
  kind:         'github_checks' | 'human_gate' | 'scheduled_time' | 'external_job';
  targetKey:    string;
  target:       Record<string, unknown>;
  fingerprint?: string | null;
  nextCheckAt?: string | null;
  dueAt?:       string | null;
}

export interface ProtectedReviewEvidence {
  workflowExecutionId: string;
  reviewerAgentIds:    string[];
  artifactType:        string;
  artifactRef:         string;
  artifactUrl?:        string | null;
  artifactHash:        string;
  summary:             string;
  checks:              unknown[];
  findings:            unknown[];
  wait?:               ReviewWaitEvidence | null;
}

export interface WorkTaskDispatchRecord {
  id:                     string;
  task_id:                string;
  agent_id:               string;
  thread_id:              string;
  status:                 WorkTaskDispatchStatus;
  kind:                   WorkTaskDispatchKind;
  attempt:                number;
  verdict:                VerificationVerdict | null;
  artifact_sha:           string | null;
  failure_reason:         string | null;
  origin_dispatch_id?:    string | null;
  origin_agent_id?:       string | null;
  origin_evidence?:       Record<string, unknown> | null;
  workflow_execution_id?: string | null;
  reviewer_agent_ids?:    string[];
  review_artifact_type?:  string | null;
  review_artifact_ref?:   string | null;
  review_artifact_url?:   string | null;
  review_artifact_hash?:  string | null;
  review_checks?:         unknown[];
  review_findings?:       unknown[];
  findings_fingerprint?:  string | null;
  disposition?:           ReviewDisposition | null;
  result:                 string | null;
  error:                  string | null;
  started_at:             string;
  heartbeat_at:           string;
  finished_at:            string | null;
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

  static async claimNextReview(agentId: string, reviewerAgentIds: string[] = []): Promise<ClaimedDispatch | null> {
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
        INSERT INTO work_task_dispatches (
          id, task_id, agent_id, thread_id, kind, attempt,
          origin_dispatch_id, origin_agent_id, origin_evidence, reviewer_agent_ids
        )
        VALUES ($1, $2, $3, $4, 'verification', COALESCE((
          SELECT MAX(attempt) + 1 FROM work_task_dispatches
           WHERE task_id = $2 AND kind = 'verification'
        ), 1),
        (SELECT id FROM work_task_dispatches
          WHERE task_id = $2 AND kind = 'execution'
          ORDER BY started_at DESC LIMIT 1),
        (SELECT agent_id FROM work_task_dispatches
          WHERE task_id = $2 AND kind = 'execution'
          ORDER BY started_at DESC LIMIT 1),
        (SELECT to_jsonb(origin) FROM work_task_dispatches origin
          WHERE origin.task_id = $2 AND origin.kind = 'execution'
          ORDER BY origin.started_at DESC LIMIT 1),
        $5::text[])
        RETURNING *
      `, [id, task.id, agentId, threadId, reviewerAgentIds]);

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

  static reviewFingerprint(findings: unknown[]): string {
    const stable = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
          result[key] = stable((value as Record<string, unknown>)[key]);
          return result;
        }, {});
      }
      return value;
    };
    return createHash('sha256').update(JSON.stringify(stable(findings))).digest('hex');
  }

  static async recordReviewLaunch(
    id: string,
    workflowExecutionId: string,
    reviewerAgentIds: string[],
  ): Promise<void> {
    await postgresClient.query(`
      UPDATE work_task_dispatches
         SET workflow_execution_id = $2,
             reviewer_agent_ids = $3::text[],
             heartbeat_at = now()
       WHERE id = $1 AND kind = 'verification' AND status = 'running'
    `, [id, workflowExecutionId, reviewerAgentIds]);
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
        SELECT d.task_id
          FROM work_task_dispatches d
          JOIN work_tasks t ON t.id = d.task_id
         WHERE d.id = $1 AND d.kind = 'verification' AND d.status = 'running'
           AND t.status = 'in_review'
         FOR UPDATE OF d, t
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

  /**
   * Settle the protected routine verdict, evidence comment, optional durable
   * wait, and Projects transition in one transaction.
   */
  static async finalizeProtectedReview(
    id: string,
    disposition: ReviewDisposition,
    evidence: ProtectedReviewEvidence,
    currentArtifactHash: string | null,
  ): Promise<ReviewDisposition | null> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const current = await client.query<{ task_id: string }>(`
        SELECT d.task_id
          FROM work_task_dispatches d
          JOIN work_tasks t ON t.id = d.task_id
         WHERE d.id = $1 AND d.kind = 'verification' AND d.status = 'running'
           AND t.status = 'in_review'
         FOR UPDATE OF d, t
      `, [id]);
      const taskId = current.rows[0]?.task_id;
      if (!taskId) return null;

      // PASS is only valid for the exact canonical generation re-resolved by
      // the service immediately before settlement.
      if (disposition === 'PASS' && currentArtifactHash !== evidence.artifactHash) return null;

      const fingerprint = WorkTaskDispatchModel.reviewFingerprint(evidence.findings);
      let finalDisposition = disposition;
      if (disposition === 'REPAIRABLE') {
        const repeats = await client.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
            FROM work_task_dispatches
           WHERE task_id = $1 AND kind = 'verification'
             AND disposition = 'REPAIRABLE'
             AND findings_fingerprint = $2
        `, [taskId, fingerprint]);
        if (Number(repeats.rows[0]?.count ?? 0) >= 2) finalDisposition = 'REPLAN';
      }

      const duplicate = await client.query<{ id: string }>(`
        SELECT id FROM work_task_dispatches
         WHERE task_id = $1 AND kind = 'verification' AND id <> $2
           AND status = 'completed' AND disposition = $3
           AND review_artifact_hash = $4
           AND findings_fingerprint = $5
         LIMIT 1
      `, [taskId, id, finalDisposition, evidence.artifactHash, fingerprint]);

      const transition = finalDisposition === 'PASS'
        ? { status: 'done', assignee: null }
        : finalDisposition === 'REPAIRABLE'
          ? { status: 'todo', assignee: 'dispatcher' }
          : finalDisposition === 'REPLAN'
            ? { status: 'planning', assignee: 'dispatcher' }
            : { status: 'blocked', assignee: 'heartbeat' };

      if (finalDisposition === 'EXTERNAL_WAIT') {
        const wait = evidence.wait;
        if (!wait?.targetKey || !wait.kind || !wait.target) return null;
        await client.query(`
          UPDATE work_task_waits
             SET status = 'cancelled', completed_at = now(), updated_at = now(),
                 last_error = 'superseded by protected review generation'
           WHERE task_id = $1 AND wait_kind = $2 AND status = 'active' AND target_key <> $3
        `, [taskId, wait.kind, wait.targetKey]);
        await client.query(`
          INSERT INTO work_task_waits (
            id, task_id, wait_kind, target_key, target,
            last_observed_fingerprint, next_check_at, due_at, owner
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6,
                    COALESCE($7::timestamptz, now()), $8, 'core-review-routine')
          ON CONFLICT (task_id, wait_kind, target_key) WHERE status = 'active'
          DO UPDATE SET updated_at = work_task_waits.updated_at
        `, [
          `wait-${ randomUUID() }`, taskId, wait.kind, wait.targetKey,
          JSON.stringify(wait.target), wait.fingerprint ?? null,
          wait.nextCheckAt ?? null, wait.dueAt ?? null,
        ]);
      }

      await client.query(`
        UPDATE work_task_dispatches
           SET status = 'completed', verdict = $2, disposition = $3,
               artifact_sha = $4, review_artifact_type = $5,
               review_artifact_ref = $6, review_artifact_url = $7,
               review_artifact_hash = $4, review_checks = $8::jsonb,
               review_findings = $9::jsonb, findings_fingerprint = $10,
               workflow_execution_id = $11, reviewer_agent_ids = $12::text[],
               result = $13, failure_reason = CASE
                 WHEN $3 IN ('REPAIRABLE', 'REPLAN', 'BLOCKED') THEN $10 ELSE NULL END,
               heartbeat_at = now(), finished_at = now()
         WHERE id = $1 AND status = 'running'
      `, [
        id,
        finalDisposition === 'PASS' ? 'APPROVE' : finalDisposition === 'REPAIRABLE' ? 'REWORK' : 'BLOCKED',
        finalDisposition,
        evidence.artifactHash,
        evidence.artifactType,
        evidence.artifactRef,
        evidence.artifactUrl ?? null,
        JSON.stringify(evidence.checks),
        JSON.stringify(evidence.findings),
        fingerprint,
        evidence.workflowExecutionId,
        evidence.reviewerAgentIds,
        evidence.summary,
      ]);

      if (!duplicate.rows[0]) {
        const escalation = disposition === 'REPAIRABLE' && finalDisposition === 'REPLAN'
          ? '\n\nThe same finding reached the repair ceiling; routed to planning/#667.'
          : '';
        const waitLine = finalDisposition === 'EXTERNAL_WAIT' && evidence.wait
          ? `\nDurable wait: ${ evidence.wait.kind } ${ evidence.wait.targetKey }.`
          : '';
        await client.query(`
          INSERT INTO work_task_comments (id, task_id, body, author)
          VALUES ($1, $2, $3, 'verifier')
        `, [randomUUID().slice(0, 12), taskId,
          `Protected review ${ id }: ${ finalDisposition } for ${ evidence.artifactType } ${ evidence.artifactRef } (${ evidence.artifactHash }).\nReviewers: ${ evidence.reviewerAgentIds.join(', ') }.\n\n${ evidence.summary }${ waitLine }${ escalation }`]);
      }

      await client.query(`
        UPDATE work_tasks
           SET status = $2, assignee = $3, updated_at = now(),
               last_moved_at = now(), last_activity_at = now(),
               last_moved_by = 'verifier',
               completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
         WHERE id = $1 AND status = 'in_review'
      `, [taskId, transition.status, transition.assignee]);
      return finalDisposition;
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
      const duplicate = await client.query<{ id: string }>(`
        SELECT id FROM work_task_dispatches
         WHERE task_id = $1 AND kind = 'verification' AND id <> $2
           AND status = 'failed' AND failure_reason = $3
         LIMIT 1
      `, [taskId, id, reason]);
      if (!duplicate.rows[0]) {
        await client.query(`
          INSERT INTO work_task_comments (id, task_id, body, author)
          VALUES ($1, $2, $3, 'verifier')
        `, [randomUUID().slice(0, 12), taskId,
          `Verification ${ id } failed and was released for retry: ${ reason }`]);
      }
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
