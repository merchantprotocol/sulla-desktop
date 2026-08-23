import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';
import { LifecycleCapabilityModel, type LifecycleStageClaim } from './LifecycleCapabilityModel';
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
  dispatch:    WorkTaskDispatchRecord;
  task:        WorkTaskRecord;
  stage_claim: LifecycleStageClaim;
}

export type InProgressExclusionReason =
  | 'archived'
  | 'epic_closed'
  | 'human_or_unknown_owner'
  | 'non_autonomous_label'
  | 'live_dispatch'
  | 'active_child'
  | 'recent_activity'
  | 'active_agent_job'
  | 'linked_external_operation';

export interface InProgressClassificationRow extends WorkTaskRecord {
  epic_open:            boolean;
  autonomous_owner:     boolean;
  autonomous_labels:    boolean;
  has_live_dispatch:    boolean;
  has_active_child:     boolean;
  stale_activity:       boolean;
  has_active_agent_job: boolean;
  recovery_attempts:    string | number;
}

export interface RecoverableInProgressCandidate {
  task:             WorkTaskRecord;
  fingerprint:      string;
  attemptCount:     number;
  exclusionReasons: InProgressExclusionReason[];
}

export interface OrphanRecoveryResult {
  taskId:         string;
  outcome:        'recovered' | 'blocked_ceiling' | 'cas_miss';
  attemptNumber?: number;
}

const CLOSED_EPIC_STATUSES = ['done', 'cancelled', 'parked', 'blocked'];

export function classifyInProgressRow(row: InProgressClassificationRow): InProgressExclusionReason[] {
  const reasons: InProgressExclusionReason[] = [];
  if (row.archived) reasons.push('archived');
  if (!row.epic_open) reasons.push('epic_closed');
  if (!row.autonomous_owner) reasons.push('human_or_unknown_owner');
  if (!row.autonomous_labels) reasons.push('non_autonomous_label');
  if (row.has_live_dispatch) reasons.push('live_dispatch');
  if (row.has_active_child) reasons.push('active_child');
  if (!row.stale_activity) reasons.push('recent_activity');
  if (row.has_active_agent_job) reasons.push('active_agent_job');
  return reasons;
}

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
      `, [CLOSED_EPIC_STATUSES, AUTONOMOUS_TASK_ASSIGNEES, NON_AUTONOMOUS_TASK_LABELS]);

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
        INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, kind, attempt)
        VALUES ($1, $2, $3, $4, 'execution', COALESCE((
          SELECT MAX(attempt) + 1 FROM work_task_dispatches
           WHERE task_id = $2 AND kind = 'execution'
        ), 1))
        RETURNING *
      `, [id, task.id, agentId, threadId]);

      const updated = await client.query<WorkTaskRecord>(`
        UPDATE work_tasks
           SET status = 'in_progress',
               assignee = $2,
               updated_at = now(),
               last_moved_at = now(),
               last_activity_at = now(),
               last_moved_by = $2
         WHERE id = $1 AND status = 'todo'
        RETURNING *
      `, [task.id, TASK_ASSIGNEES.dispatcher]);
      if (!updated.rows[0]) {
        throw new Error(`Atomic dispatch lost task ${ task.id } before execution handoff`);
      }

      return { dispatch: inserted.rows[0], task: updated.rows[0], stage_claim: stageClaim.claim };
    });
  }

  static async claimNextReview(agentId: string, runtimeInstanceId: string): Promise<ClaimedDispatch | null> {
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

      const stageClaim = await LifecycleCapabilityModel.claimStageWithClient(
        client,
        task.id,
        'in-review-verification',
        'in_review',
        'dispatcher',
        runtimeInstanceId,
      );
      if (!stageClaim.claimed || !stageClaim.claim) return null;

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

      return { dispatch: inserted.rows[0], task, stage_claim: stageClaim.claim };
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

  /**
   * Classify in-progress tasks without changing them. This is deliberately the
   * same eligibility surface used by recovery, so the default report-only
   * rollout measures what an enabled pass would do.
   */
  static async findRecoverableInProgress(staleMinutes = 360, limit = 100): Promise<RecoverableInProgressCandidate[]> {
    const rows = await postgresClient.query<InProgressClassificationRow>(`
      SELECT t.*,
             (e.id IS NOT NULL AND e.archived = false AND NOT (e.status = ANY($1::text[]))) AS epic_open,
             (t.assignee IS NULL OR LOWER(t.assignee) = ANY($2::text[])) AS autonomous_owner,
             NOT EXISTS (
               SELECT 1 FROM unnest(COALESCE(t.labels, '{}')) AS label
                WHERE LOWER(label) = ANY($3::text[])
             ) AS autonomous_labels,
             EXISTS (
               SELECT 1 FROM work_task_dispatches d
                WHERE d.task_id = t.id AND d.status = 'running'
             ) AS has_live_dispatch,
             EXISTS (
               SELECT 1 FROM work_tasks child
                WHERE child.parent_id = t.id
                  AND child.archived = false
                  AND child.status NOT IN ('done', 'cancelled', 'parked')
             ) AS has_active_child,
             (t.last_activity_at <= now() - ($4 * interval '1 minute')) AS stale_activity,
             EXISTS (
               SELECT 1 FROM agent_jobs j
                WHERE j.status = 'running'
                  AND (j.job_id = t.source_ref OR COALESCE(j.results, '[]'::jsonb)::text LIKE '%' || t.id || '%')
             ) AS has_active_agent_job,
             (SELECT COUNT(*)::text FROM work_task_recovery_attempts a WHERE a.task_id = t.id) AS recovery_attempts
        FROM work_tasks t
        LEFT JOIN work_epics e ON e.id = t.epic_id
       WHERE t.status = 'in_progress'
       ORDER BY t.last_activity_at ASC, t.id ASC
       LIMIT $5
    `, [CLOSED_EPIC_STATUSES, AUTONOMOUS_TASK_ASSIGNEES, NON_AUTONOMOUS_TASK_LABELS, staleMinutes, Math.max(1, limit)]);

    return rows.map((row) => {
      const {
        epic_open: _epicOpen,
        autonomous_owner: _autonomousOwner,
        autonomous_labels: _autonomousLabels,
        has_live_dispatch: _hasLiveDispatch,
        has_active_child: _hasActiveChild,
        stale_activity: _staleActivity,
        has_active_agent_job: _hasActiveAgentJob,
        recovery_attempts: recoveryAttempts,
        ...task
      } = row;
      return {
        task:             task as WorkTaskRecord,
        fingerprint:      row.last_activity_at,
        attemptCount:     Number(recoveryAttempts || 0),
        exclusionReasons: classifyInProgressRow(row),
      };
    });
  }

  /**
   * Recover snapshots under row locks. Every eligibility predicate and the
   * activity fingerprint is re-checked after locking; any concurrent edit or
   * comment therefore wins and produces a harmless CAS miss.
   */
  static async recoverOrphanedInProgress(
    candidates: RecoverableInProgressCandidate[],
    batchSize = 1,
    retryCeiling = 3,
  ): Promise<OrphanRecoveryResult[]> {
    const eligible = candidates.filter(candidate => candidate.exclusionReasons.length === 0).slice(0, Math.max(0, batchSize));
    if (eligible.length === 0) return [];

    return postgresClient.transaction(async(client: PoolClient) => {
      const results: OrphanRecoveryResult[] = [];
      for (const candidate of eligible) {
        const locked = await client.query<WorkTaskRecord>(`
          SELECT t.*
            FROM work_tasks t
            JOIN work_epics e ON e.id = t.epic_id
           WHERE t.id = $1
             AND t.status = 'in_progress'
             AND t.archived = false
             AND e.archived = false
             AND NOT (e.status = ANY($2::text[]))
             AND (t.assignee IS NULL OR LOWER(t.assignee) = ANY($3::text[]))
             AND NOT EXISTS (
               SELECT 1 FROM unnest(COALESCE(t.labels, '{}')) AS label
                WHERE LOWER(label) = ANY($4::text[])
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
             AND NOT EXISTS (
               SELECT 1 FROM agent_jobs j
                WHERE j.status = 'running'
                  AND (j.job_id = t.source_ref OR COALESCE(j.results, '[]'::jsonb)::text LIKE '%' || t.id || '%')
             )
             AND t.last_activity_at = $5::timestamptz
           FOR UPDATE OF t SKIP LOCKED
        `, [candidate.task.id, CLOSED_EPIC_STATUSES, AUTONOMOUS_TASK_ASSIGNEES, NON_AUTONOMOUS_TASK_LABELS, candidate.fingerprint]);

        const task = locked.rows[0];
        if (!task) {
          results.push({ taskId: candidate.task.id, outcome: 'cas_miss' });
          continue;
        }

        const count = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM work_task_recovery_attempts WHERE task_id = $1`,
          [task.id],
        );
        const attemptNumber = Number(count.rows[0]?.count || 0) + 1;
        const outcome = attemptNumber >= Math.max(1, retryCeiling) ? 'blocked_ceiling' : 'recovered';
        const nextStatus = outcome === 'recovered' ? 'todo' : 'blocked';
        const nextAssignee = outcome === 'recovered' ? TASK_ASSIGNEES.dispatcher : TASK_ASSIGNEES.heartbeat;
        const reason = outcome === 'recovered'
          ? 'stale autonomous in_progress task had no live owner or operation'
          : `recovery retry ceiling reached (${ retryCeiling })`;
        const auditId = `recovery-${ randomUUID() }`;
        const undo = `restore status=in_progress, assignee=${ task.assignee ?? 'unassigned' }, and review activity at ${ task.last_activity_at }`;

        await client.query(`
          INSERT INTO work_task_recovery_attempts
            (id, task_id, attempt_number, outcome, reason, previous_status, previous_assignee, previous_activity_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [auditId, task.id, attemptNumber, outcome, reason, task.status, task.assignee, task.last_activity_at]);

        await client.query(`
          WITH inserted AS (
            INSERT INTO work_task_comments (id, task_id, body, author)
            VALUES ($1, $2, $3, 'dispatcher')
          )
          UPDATE work_tasks
             SET status = $4,
                 assignee = $5,
                 updated_at = now(),
                 last_moved_at = now(),
                 last_activity_at = now(),
                 last_moved_by = 'dispatcher'
           WHERE id = $2
        `, [
          `comment-${ randomUUID() }`, task.id,
          `Orphan recovery attempt ${ attemptNumber }: ${ reason }. Prior owner: ${ task.assignee ?? 'unassigned' }. Prior activity: ${ task.last_activity_at }. Outcome: ${ nextStatus }/${ nextAssignee }. Undo path: ${ undo }.`,
          nextStatus, nextAssignee,
        ]);
        results.push({ taskId: task.id, outcome, attemptNumber });
      }
      return results;
    });
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
          UPDATE work_task_stage_claims
             SET status = 'recovered', released_at = now(), heartbeat_at = now()
           WHERE task_id = ANY($1::text[])
             AND capability_key = 'todo-execution'
             AND stage = 'in_progress'
             AND status = 'active'
        `, [executionTaskIds]);

        await client.query(`
          UPDATE work_tasks
             SET status = 'todo', assignee = NULL,
                 updated_at = now(), last_moved_at = now(),
                 last_activity_at = now(), last_moved_by = 'dispatcher'
           WHERE id = ANY($1::text[]) AND status = 'in_progress' AND assignee = 'dispatcher'
        `, [executionTaskIds]);
      }
      if (verificationTaskIds.length > 0) {
        await client.query(`
          UPDATE work_task_stage_claims
             SET status = 'recovered', released_at = now(), heartbeat_at = now()
           WHERE task_id = ANY($1::text[])
             AND capability_key = 'in-review-verification'
             AND stage = 'in_review'
             AND status = 'active'
        `, [verificationTaskIds]);

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
