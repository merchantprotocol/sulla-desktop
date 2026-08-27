import { createHash, randomUUID } from 'node:crypto';
import { WorkTaskDependencyModel } from './WorkTaskDependencyModel';

import { postgresClient } from '../PostgresClient';
import { ArtifactCustodyPolicy, type ArtifactCustody } from '../../services/ArtifactCustodyPolicy';
import { evaluateClaim, type WipLimits } from '../../services/ProjectAutomationWipLimits';
import {
  buildReceipt, receiptInsertInput, renderReceiptComment,
  type ArtifactReceipt, type ArtifactReceiptInput,
} from '../../services/ArtifactReceiptService';
import { ArtifactReceiptModel } from './ArtifactReceiptModel';
import { LifecycleCapabilityModel, type LifecycleStageClaim } from './LifecycleCapabilityModel';
import { AUTONOMOUS_TASK_ASSIGNEES, NON_AUTONOMOUS_TASK_LABELS, TASK_ASSIGNEES } from './TaskOwnership';
import type { WorkLaneSemanticRole } from './WorkLaneDefinitionModel';

import type { WorkTaskRecord } from './WorkItemsModel';
import type { PoolClient } from 'pg';

export type WorkTaskDispatchStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'stale';
export type WorkTaskDispatchKind = 'execution' | 'verification';
export type VerificationVerdict = 'APPROVE' | 'REWORK' | 'BLOCKED';
export type ReviewDisposition = 'PASS' | 'REPAIRABLE' | 'REPLAN' | 'EXTERNAL_WAIT' | 'BLOCKED';
export type ReviewArtifactType =
  | 'code_pr' | 'documentation' | 'marketing_campaign' | 'research'
  | 'data_spreadsheet' | 'design_media' | 'operations_configuration' | 'projects_evidence';

export interface ReviewArtifactComponent {
  type:         ReviewArtifactType;
  canonicalRef: string;
  hash:         string;
  adapter:      string;
  url?:         string | null;
  code:         boolean;
}

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
  excludedAgentIds:    string[];
  generationHash:      string;
  artifactTypes:       ReviewArtifactType[];
  artifacts:           ReviewArtifactComponent[];
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
  id:                      string;
  task_id:                 string;
  agent_id:                string;
  thread_id:               string;
  status:                  WorkTaskDispatchStatus;
  kind:                    WorkTaskDispatchKind;
  attempt:                 number;
  verdict:                 VerificationVerdict | null;
  artifact_sha:            string | null;
  failure_reason:          string | null;
  origin_dispatch_id?:     string | null;
  origin_agent_id?:        string | null;
  origin_evidence?:        Record<string, unknown> | null;
  workflow_execution_id?:  string | null;
  reviewer_agent_ids?:     string[];
  worker_agent_ids?:       string[];
  custodian_agent_ids?:    string[];
  excluded_agent_ids?:     string[];
  review_generation_hash?: string | null;
  review_artifact_types?:  ReviewArtifactType[];
  review_artifacts?:       ReviewArtifactComponent[];
  review_artifact_type?:   string | null;
  review_artifact_ref?:    string | null;
  review_artifact_url?:    string | null;
  review_artifact_hash?:   string | null;
  review_checks?:          unknown[];
  review_findings?:        unknown[];
  findings_fingerprint?:   string | null;
  disposition?:            ReviewDisposition | null;
  result:                  string | null;
  error:                   string | null;
  started_at:              string;
  heartbeat_at:            string;
  finished_at:             string | null;
  run_kind?:               string;
  classifier_decision?:    unknown;
  selected_agents?:        unknown[];
  worker_child_ids?:       string[];
  attempt_count?:          number;
  review_count?:           number;
  repair_count?:           number;
  artifact_type?:          string | null;
  artifact_location?:      string | null;
  artifact_url?:           string | null;
  artifact_ref?:           string | null;
  content_hash?:           string | null;
  reviewer_verdict?:       string | null;
  review_evidence?:        unknown;
  terminal_reason?:        string | null;
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
  custody?:      ArtifactCustody | null;
  terminalReason?:      string;
}

export interface ClaimedDispatch {
  dispatch:    WorkTaskDispatchRecord;
  task:        WorkTaskRecord;
  stage_claim: LifecycleStageClaim;
}

export type InProgressExclusionReason =
  | 'archived'
  | 'epic_closed'
  | 'non_autonomous_label'
  | 'live_dispatch'
  | 'active_child'
  | 'recent_activity'
  | 'active_agent_job'
  | 'linked_external_operation';

export interface InProgressClassificationRow extends WorkTaskRecord {
  epic_open:            boolean;
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

export interface WorkTaskDispatchFinalization {
  dispatchStatus: Exclude<WorkTaskDispatchStatus, 'running' | 'stale'>;
  taskStatus:     'in_review' | 'planning' | 'blocked';
  taskAssignee:   'heartbeat' | 'dispatcher';
  comment:        string;
  result?:        string;
  error?:         string;
  evidence?:      WorkTaskDispatchEvidence;
  receipt?:       ArtifactReceipt;
}

interface WorkTaskOutcomeJournalRow {
  id: string;
  dispatch_id: string;
  task_id: string;
  dispatch_status: Exclude<WorkTaskDispatchStatus, 'running' | 'stale'>;
  task_status: 'in_review' | 'planning' | 'blocked';
  task_assignee: 'heartbeat' | 'dispatcher';
  comment: string;
  result: string | null;
  error: string | null;
  evidence: WorkTaskDispatchEvidence | null;
  receipt: ArtifactReceipt | null;
  consumed_at: string | null;
}

const CLOSED_EPIC_STATUSES = ['done', 'cancelled', 'parked', 'blocked'];

/**
 * Idle in_progress reclaim is ownership-neutral by design (Jonathon
 * directive 2026-08-25, Projects task 1Nk7): whoever is actively working a
 * task — human or agent — holds it as assignee exactly like any other
 * sub-agent assignment. There is no "must already be assignee=dispatcher"
 * or "must be an autonomous owner" gate here. The only protections against
 * yanking real work out from under someone are activity-based
 * (stale_activity / has_live_dispatch / has_active_child /
 * has_active_agent_job) and the explicit opt-out labels in
 * NON_AUTONOMOUS_TASK_LABELS (e.g. "human", "gated", "no-auto-dispatch").
 */
export function classifyInProgressRow(row: InProgressClassificationRow): InProgressExclusionReason[] {
  const reasons: InProgressExclusionReason[] = [];
  if (row.archived) reasons.push('archived');
  if (!row.epic_open) reasons.push('epic_closed');
  if (!row.autonomous_labels) reasons.push('non_autonomous_label');
  if (row.has_live_dispatch) reasons.push('live_dispatch');
  if (row.has_active_child) reasons.push('active_child');
  if (!row.stale_activity) reasons.push('recent_activity');
  if (row.has_active_agent_job) reasons.push('active_agent_job');
  return reasons;
}

export class WorkTaskDispatchModel {
  private static async persistReceiptWithClient(
    client: PoolClient,
    receipt: ArtifactReceipt,
    author: string,
  ): Promise<boolean> {
    const receiptId = randomUUID();
    const inserted = await ArtifactReceiptModel.insertIfAbsentWithClient(
      client,
      receiptInsertInput(receipt, receiptId),
    );
    if (!inserted.inserted) return false;
    const commentId = `artifact-receipt-comment-${ randomUUID() }`;
    await client.query(`
      INSERT INTO work_task_comments (id, task_id, body, author)
      VALUES ($1, $2, $3, $4)
    `, [commentId, receipt.taskId, renderReceiptComment(receipt), author]);
    await ArtifactReceiptModel.attachCommentWithClient(client, receiptId, commentId);
    return true;
  }

  private static reviewReceipt(input: ArtifactReceiptInput): ArtifactReceipt {
    return buildReceipt({ ...input, validationSummary: input.validationSummary?.slice(0, 500) });
  }
  static reviewGenerationHash(artifacts: ReviewArtifactComponent[]): string {
    const normalized = [...artifacts]
      .map(artifact => ({
        type:         artifact.type,
        canonicalRef: artifact.canonicalRef,
        hash:         artifact.hash.toLowerCase(),
        adapter:      artifact.adapter,
        code:         artifact.code,
      }))
      .sort((a, b) => `${ a.type }\0${ a.canonicalRef }`.localeCompare(`${ b.type }\0${ b.canonicalRef }`));
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  static async claimNext(
    agentId: string,
    runtimeInstanceId: string,
    wipLimits?: WipLimits,
  ): Promise<ClaimedDispatch | null> {
    return postgresClient.transaction(async(client) => {
      // Serialize semantic WIP evaluation with the status mutation. Without the
      // transaction-scoped lock two dispatcher instances can both observe the
      // last free slot and oversubscribe the execution stage.
      if (wipLimits) {
        await client.query('SELECT pg_advisory_xact_lock($1)', [4823710299]);
        const counts = await this.countByRoleWithClient(client);
        if (!evaluateClaim('execution', counts, wipLimits).allowed) return null;
      }
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
             SELECT 1
               FROM work_tasks downstream
               JOIN work_epics downstream_epic ON downstream_epic.id = downstream.epic_id
               JOIN work_projects downstream_project ON downstream_project.id = downstream_epic.project_id
              WHERE downstream.archived = false
                AND downstream.status = 'in_review'
                AND downstream_epic.archived = false
                AND downstream_project.archived = false
                AND NOT (downstream_project.status = ANY($1::text[]))
                AND NOT (downstream_epic.status = ANY($1::text[]))
                AND (downstream.assignee IS NULL OR LOWER(downstream.assignee) IN ('heartbeat', 'dispatcher', 'verifier'))
                AND NOT EXISTS (
                  SELECT 1 FROM unnest(COALESCE(downstream.labels, '{}')) AS downstream_label
                   WHERE LOWER(downstream_label) = ANY($3::text[])
                )
           )
           AND NOT EXISTS (
             SELECT 1 FROM work_tasks child
              WHERE child.parent_id = t.id
                AND child.archived = false
                AND child.status NOT IN ('done', 'cancelled', 'parked')
           )
         ${WorkTaskDependencyModel.claimExclusionSql('t.id')}
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
      const committed = updated.rows[0];

      // Mirror WorkItemsModel.updateTask's status-transition side effects.
      // Without this, mechanical execution dispatch was a second write path
      // that bypassed the lane-entry-workflow claim entirely: no project
      // pipeline workflow bound to the entered lane was ever resolved or
      // attached, and no work_project_domain_events row was appended, so the
      // Projects activity/audit trail silently missed every dispatcher-driven
      // todo -> in_progress transition.
      const { WorkLaneWorkflowBindingModel } = await import('./WorkLaneWorkflowBindingModel');
      const laneEntry = await WorkLaneWorkflowBindingModel.claimLaneEntryInTransaction(
        client, committed.id, committed.status, TASK_ASSIGNEES.dispatcher,
      );
      const { createPostgresProjectsRepositories } = await import('../../projects/infrastructure/PostgresProjectsRepositories');
      await createPostgresProjectsRepositories(client).events.append({
        id:             `projects-event-${ committed.id }-${ laneEntry.entry.generation }-transition`,
        taskId:         committed.id,
        generation:     laneEntry.entry.generation,
        eventType:      'projects.task.transitioned',
        idempotencyKey: `projects.task.transitioned:${ committed.id }:${ laneEntry.entry.generation }`,
        occurredAt:     new Date(),
        payload:        {
          actor:         TASK_ASSIGNEES.dispatcher,
          source:        'dispatcher',
          fromLane:      task.status,
          toLane:        committed.status,
          laneEntryId:   laneEntry.entry.id,
          laneAutomated: laneEntry.entry.status === 'pending',
        },
      });

      return { dispatch: inserted.rows[0], task: committed, stage_claim: stageClaim.claim };
    });
  }

  static async claimNextReview(
    agentId: string,
    reviewerAgentIds: string[],
    runtimeInstanceId: string,
  ): Promise<ClaimedDispatch | null> {
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
         ${WorkTaskDependencyModel.claimExclusionSql('t.id')}
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
      `, [CLOSED_EPIC_STATUSES, NON_AUTONOMOUS_TASK_LABELS]);

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
   * Count autonomous work already at the review stage, including work with an
   * active verification lease. Any such row is farther down the conveyor than
   * todo, so the dispatcher uses this as a hard backpressure gate before
   * claiming fresh execution work.
   */
  static async countReviewBacklog(): Promise<number> {
    const row = await postgresClient.queryOne<{ count: string }>(`
      SELECT COUNT(*)::text AS count
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
    `, [CLOSED_EPIC_STATUSES, NON_AUTONOMOUS_TASK_LABELS]);
    return Number(row?.count || 0);
  }

  /**
   * Count autonomous, non-terminal work in each semantic lane role across the
   * whole portfolio, honouring custom project lanes via their resolved
   * semantic_role (issue #711). Queued and active work both count. Closed epics
   * and non-autonomous or human-gated tasks are excluded, matching the
   * eligibility surface of countReviewBacklog and the claim paths.
   */
  static async countByRole(): Promise<Partial<Record<WorkLaneSemanticRole, number>>> {
    return postgresClient.transaction(client => this.countByRoleWithClient(client));
  }

  /** Transaction-local semantic counts used by the race-free claim gate. */
  static async countByRoleWithClient(
    client: PoolClient,
  ): Promise<Partial<Record<WorkLaneSemanticRole, number>>> {
    const rows = await client.query<{ semantic_role: WorkLaneSemanticRole; count: string }>(`
      SELECT COALESCE(
               project_lane.semantic_role,
               global_lane.semantic_role,
               CASE t.status
                 WHEN 'backlog' THEN 'backlog'
                 WHEN 'todo' THEN 'execution'
                 WHEN 'planning' THEN 'planning'
                 WHEN 'in_progress' THEN 'execution'
                 WHEN 'in_review' THEN 'review'
                 WHEN 'blocked' THEN 'blocked'
                 WHEN 'done' THEN 'terminal'
                 WHEN 'cancelled' THEN 'terminal'
                 WHEN 'parked' THEN 'manual'
                 ELSE 'manual'
               END
             )::text AS semantic_role,
             COUNT(*)::text AS count
        FROM work_tasks t
        JOIN work_epics e ON e.id = t.epic_id
        JOIN work_projects p ON p.id = e.project_id
        LEFT JOIN LATERAL (
          SELECT semantic_role
            FROM work_lane_definitions
           WHERE scope = 'project'
             AND project_id = p.id
             AND lane_key = t.status
             AND reset_at IS NULL
             AND archived = false
             AND enabled = true
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 1
        ) project_lane ON true
        LEFT JOIN LATERAL (
          SELECT semantic_role
            FROM work_lane_definitions
           WHERE scope = 'global_default'
             AND lane_key = t.status
             AND reset_at IS NULL
             AND archived = false
             AND enabled = true
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 1
        ) global_lane ON true
       WHERE t.archived = false
         AND e.archived = false
         AND p.archived = false
         AND NOT (p.status = ANY($1::text[]))
         AND NOT (e.status = ANY($1::text[]))
         AND (t.assignee IS NULL OR LOWER(t.assignee) IN ('heartbeat', 'dispatcher', 'verifier'))
         AND NOT EXISTS (
           SELECT 1 FROM unnest(COALESCE(t.labels, '{}')) AS label
            WHERE LOWER(label) = ANY($2::text[])
         )
       GROUP BY 1
    `, [CLOSED_EPIC_STATUSES, NON_AUTONOMOUS_TASK_LABELS]);

    const totals: Partial<Record<WorkLaneSemanticRole, number>> = {};
    for (const row of rows.rows) totals[row.semantic_role] = Number(row.count || 0);
    return totals;
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
             NOT EXISTS (
               SELECT 1 FROM unnest(COALESCE(t.labels, '{}')) AS label
                WHERE LOWER(label) = ANY($2::text[])
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
             (t.last_activity_at <= now() - ($3 * interval '1 minute')) AS stale_activity,
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
       LIMIT $4
    `, [CLOSED_EPIC_STATUSES, NON_AUTONOMOUS_TASK_LABELS, staleMinutes, Math.max(1, limit)]);

    return rows.map((row) => {
      const {
        epic_open: _epicOpen,
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
             AND NOT EXISTS (
               SELECT 1 FROM unnest(COALESCE(t.labels, '{}')) AS label
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
             AND NOT EXISTS (
               SELECT 1 FROM agent_jobs j
                WHERE j.status = 'running'
                  AND (j.job_id = t.source_ref OR COALESCE(j.results, '[]'::jsonb)::text LIKE '%' || t.id || '%')
             )
             AND t.last_activity_at = $4::timestamptz
           FOR UPDATE OF t SKIP LOCKED
        `, [candidate.task.id, CLOSED_EPIC_STATUSES, NON_AUTONOMOUS_TASK_LABELS, candidate.fingerprint]);

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
        // Ownership-neutral: prior assignee may be a human, dispatcher, heartbeat, or any
        // other agent identity. Idle timeout is the only gate — see classifyInProgressRow.
        const reason = outcome === 'recovered'
          ? 'in_progress task idle past the reclaim threshold with no live owner or operation'
          : `recovery retry ceiling reached (${ retryCeiling })`;
        const auditId = `recovery-${ randomUUID() }`;
        const idleMinutes = Math.max(0, Math.round(
          (Date.now() - new Date(task.last_activity_at).getTime()) / 60000,
        ));
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
          `Orphan recovery attempt ${ attemptNumber }: ${ reason }. Prior owner: ${ task.assignee ?? 'unassigned' }. ` +
          `Idle for ${ idleMinutes } minute(s) (no activity since ${ task.last_activity_at }). ` +
          `Outcome: ${ nextStatus }/${ nextAssignee }. Undo: ${ undo }.`,
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

  /** Bind the lease to immutable artifacts before any reviewer graph starts. */
  static async bindReviewGeneration(
    id: string,
    artifacts: ReviewArtifactComponent[],
  ): Promise<{ generationHash: string; excludedAgentIds: string[]; suppressed: boolean }> {
    if (artifacts.length === 0 || artifacts.some(artifact => !/^[a-f0-9]{40,64}$/i.test(artifact.hash))) {
      throw new Error('review_generation_requires_immutable_artifacts');
    }
    const generationHash = WorkTaskDispatchModel.reviewGenerationHash(artifacts);
    return postgresClient.transaction(async(client: PoolClient) => {
      const current = await client.query<{ task_id: string }>(`
        SELECT d.task_id FROM work_task_dispatches d
        JOIN work_tasks t ON t.id = d.task_id
        WHERE d.id = $1 AND d.kind = 'verification' AND d.status = 'running'
          AND t.status = 'in_review'
        FOR UPDATE OF d, t
      `, [id]);
      const taskId = current.rows[0]?.task_id;
      if (!taskId) throw new Error('review_lease_not_live');

      const identities = await client.query<{ agent_id: string; origin_evidence: Record<string, any> | null }>(`
        SELECT agent_id, origin_evidence FROM work_task_dispatches
         WHERE task_id = $1 AND kind = 'execution'
         ORDER BY started_at ASC
      `, [taskId]);
      const workers = new Set<string>();
      const custodians = new Set<string>();
      for (const row of identities.rows) {
        if (row.agent_id) workers.add(row.agent_id);
        const custody = row.origin_evidence?.custodianAgentIds ?? row.origin_evidence?.custodian_agent_ids ?? [];
        if (Array.isArray(custody)) custody.filter(value => typeof value === 'string').forEach(value => custodians.add(value));
      }
      // Until #668 supplies explicit custody IDs, the worker that produced the
      // latest handoff is also conservatively treated as its custodian.
      const latestWorker = identities.rows.at(-1)?.agent_id;
      if (latestWorker) custodians.add(latestWorker);
      const excluded = new Set([...workers, ...custodians]);

      const terminal = await client.query<{ id: string; status: string; disposition: ReviewDisposition | null }>(`
        SELECT id, status, disposition FROM work_task_dispatches
         WHERE task_id = $1 AND kind = 'verification' AND id <> $2
           AND review_generation_hash = $3
           AND (status = 'completed' OR (status = 'failed' AND failure_reason LIKE 'terminal:%'))
         ORDER BY finished_at DESC NULLS LAST LIMIT 1
      `, [taskId, id, generationHash]);
      if (terminal.rows[0]) {
        const priorDisposition = terminal.rows[0].disposition;
        const transition = priorDisposition === 'PASS'
          ? { status: 'done', assignee: null }
          : priorDisposition === 'REPAIRABLE'
            ? { status: 'todo', assignee: 'dispatcher' }
            : priorDisposition === 'REPLAN'
              ? { status: 'planning', assignee: 'dispatcher' }
              : priorDisposition
                ? { status: 'blocked', assignee: 'heartbeat' }
                : { status: 'planning', assignee: 'dispatcher' };
        await client.query(`
          UPDATE work_task_dispatches SET status = 'completed', result = $2, disposition = $7,
            review_generation_hash = $3, review_artifact_types = $4::text[],
            review_artifacts = $5::jsonb, excluded_agent_ids = $6::text[],
            worker_agent_ids = $8::text[], custodian_agent_ids = $9::text[],
            heartbeat_at = now(), finished_at = now()
          WHERE id = $1 AND status = 'running'
        `, [id, `suppressed identical terminal generation ${ terminal.rows[0].id }`, generationHash,
          [...new Set(artifacts.map(value => value.type))], JSON.stringify(artifacts), [...excluded], priorDisposition,
          [...workers], [...custodians]]);
        await client.query(`
          UPDATE work_tasks SET status = $2, assignee = $3, updated_at = now(),
            last_moved_at = now(), last_activity_at = now(), last_moved_by = 'verifier',
            completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
          WHERE id = $1 AND status = 'in_review'
        `, [taskId, transition.status, transition.assignee]);
        return { generationHash, excludedAgentIds: [...excluded], suppressed: true };
      }

      await client.query(`
        UPDATE work_task_dispatches SET review_generation_hash = $2,
          review_artifact_types = $3::text[], review_artifacts = $4::jsonb,
          excluded_agent_ids = $5::text[], worker_agent_ids = $6::text[],
          custodian_agent_ids = $7::text[], heartbeat_at = now()
        WHERE id = $1 AND status = 'running'
      `, [id, generationHash, [...new Set(artifacts.map(value => value.type))], JSON.stringify(artifacts),
        [...excluded], [...workers], [...custodians]]);
      return { generationHash, excludedAgentIds: [...excluded], suppressed: false };
    });
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
  static async appendOutcomeJournal(
    id: string,
    taskId: string,
    finalization: WorkTaskDispatchFinalization,
  ): Promise<string> {
    const journalId = `outcome-${ randomUUID() }`;
    const inserted = await postgresClient.query<{ id: string }>(`
      INSERT INTO work_task_outcome_journal
        (id, dispatch_id, task_id, dispatch_status, task_status, task_assignee,
         comment, result, error, evidence, receipt)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
      ON CONFLICT (dispatch_id) DO NOTHING
      RETURNING id
    `, [
      journalId, id, taskId, finalization.dispatchStatus, finalization.taskStatus,
      finalization.taskAssignee, finalization.comment, finalization.result ?? null,
      finalization.error ?? null,
      finalization.evidence === undefined ? null : JSON.stringify(finalization.evidence),
      finalization.receipt === undefined ? null : JSON.stringify(finalization.receipt),
    ]);
    if (inserted[0]) return inserted[0].id;
    const existing = await postgresClient.query<{ id: string }>(
      'SELECT id FROM work_task_outcome_journal WHERE dispatch_id = $1', [id],
    );
    if (!existing[0]) throw new Error(`Outcome journal insert disappeared for dispatch ${ id }`);
    return existing[0].id;
  }

  static async finalizeOutcomeJournal(journalId: string): Promise<WorkTaskRecord | null> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const journal = await client.query<WorkTaskOutcomeJournalRow>(`
        SELECT * FROM work_task_outcome_journal WHERE id = $1 FOR UPDATE
      `, [journalId]);
      const row = journal.rows[0];
      if (!row) throw new Error(`Outcome journal ${ journalId } was not found`);
      if (row.consumed_at) return null;
      const dispatch = await client.query<{ status: WorkTaskDispatchStatus }>(
        'SELECT status FROM work_task_dispatches WHERE id = $1 FOR UPDATE', [row.dispatch_id],
      );
      if (dispatch.rows[0]?.status !== 'running') {
        await client.query('UPDATE work_task_outcome_journal SET consumed_at = now() WHERE id = $1', [journalId]);
        return null;
      }
      const task = await this.finalizeWithClient(client, row.dispatch_id, row.task_id, {
        dispatchStatus: row.dispatch_status,
        taskStatus: row.task_status,
        taskAssignee: row.task_assignee,
        comment: row.comment,
        result: row.result ?? undefined,
        error: row.error ?? undefined,
        evidence: row.evidence ?? undefined,
        receipt: row.receipt ?? undefined,
      });
      await client.query(
        'UPDATE work_task_outcome_journal SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
        [journalId],
      );
      return task;
    });
  }

  static async recoverPendingOutcomeJournals(): Promise<string[]> {
    const pending = await postgresClient.query<{ id: string }>(`
      SELECT id FROM work_task_outcome_journal
       WHERE consumed_at IS NULL ORDER BY created_at ASC
    `);
    const settled: string[] = [];
    for (const row of pending) {
      try {
        await this.finalizeOutcomeJournal(row.id);
        settled.push(row.id);
      } catch (err) {
        console.warn(`[WorkTaskDispatchModel] Outcome journal ${ row.id } remains pending:`, err);
      }
    }
    return settled;
  }

  static async finalize(id: string, taskId: string, finalization: WorkTaskDispatchFinalization): Promise<WorkTaskRecord> {
    const evidence = finalization.evidence ?? {};
    const custody = ArtifactCustodyPolicy.derive(evidence as unknown as Record<string, unknown>);
    if (finalization.taskStatus === 'in_review') {
      await ArtifactCustodyPolicy.assertForTransition('in_review', custody);
    }
    return postgresClient.transaction(async(client: PoolClient) => this.finalizeWithClient(client, id, taskId, finalization));
  }

  private static async finalizeWithClient(
    client: PoolClient,
    id: string,
    taskId: string,
    finalization: WorkTaskDispatchFinalization,
  ): Promise<WorkTaskRecord> {
    return (async() => {
      const evidence = finalization.evidence ?? {};
      const custody = ArtifactCustodyPolicy.derive(evidence as unknown as Record<string, unknown>);
      if (finalization.taskStatus === 'in_review') {
        await ArtifactCustodyPolicy.assertForTransition('in_review', custody);
      }
      const locked = await client.query<{ status: WorkTaskDispatchStatus }>(
        'SELECT status FROM work_task_dispatches WHERE id = $1 AND task_id = $2 FOR UPDATE',
        [id, taskId],
      );
      if (locked.rows[0]?.status !== 'running') {
        throw new Error(`Dispatch ${ id } is not running and cannot be finalized`);
      }
      if (finalization.taskStatus === 'in_review' && custody) {
        await ArtifactCustodyPolicy.persistWithClient(client, taskId, 'in_review', custody, 'dispatcher');
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

      if (finalization.receipt) {
        await this.persistReceiptWithClient(client, finalization.receipt, 'dispatcher');
      } else {
        await client.query(`
          INSERT INTO work_task_comments (id, task_id, body, author)
          VALUES ($1, $2, $3, 'dispatcher')
        `, [`dispatch-comment-${ randomUUID() }`, taskId, finalization.comment]);
      }

      const moved = await client.query<WorkTaskRecord>(`
        UPDATE work_tasks
           SET status = $2, assignee = $3, updated_at = now(),
               last_moved_at = now(), last_activity_at = now(),
               last_moved_by = 'dispatcher', completed_at = NULL
         WHERE id = $1 AND status = 'in_progress' AND assignee = 'dispatcher'
         RETURNING *
      `, [taskId, finalization.taskStatus, finalization.taskAssignee]);
      if (!moved.rows[0]) {
        throw new Error(`Task ${ taskId } is no longer owned by dispatch ${ id }`);
      }
      return moved.rows[0];
    })();
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
           AND NOT EXISTS (
             SELECT 1 FROM work_task_outcome_journal j
              WHERE j.dispatch_id = work_task_dispatches.id
                AND j.consumed_at IS NULL
           )
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

  /**
   * Settle verification dispatches whose previous-runtime stage claims were
   * explicitly recovered during startup. Healthy current-runtime leases are
   * never selected, regardless of their age.
   */
  static async recoverOrphanedVerification(taskIds: string[]): Promise<string[]> {
    if (taskIds.length === 0) return [];
    return postgresClient.transaction(async(client: PoolClient) => {
      const reclaimed = await client.query<{ id: string; task_id: string }>(`
        UPDATE work_task_dispatches dispatch
           SET status = 'stale', failure_reason = 'previous_runtime_recovered',
               error = 'previous runtime ended before review settlement',
               heartbeat_at = now(), finished_at = now()
         WHERE dispatch.kind = 'verification'
           AND dispatch.status = 'running'
           AND dispatch.task_id = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM work_task_stage_claims claim
              WHERE claim.task_id = dispatch.task_id
                AND claim.capability_key = 'in-review-verification'
                AND claim.stage = 'in_review'
                AND claim.status = 'active'
           )
        RETURNING dispatch.id, dispatch.task_id
      `, [taskIds]);
      const reclaimedTaskIds: string[] = [
        ...new Set<string>(reclaimed.rows.map((row: { task_id: string }) => row.task_id)),
      ];
      if (reclaimedTaskIds.length > 0) {
        await client.query(`
          UPDATE work_tasks
             SET status = 'in_review', assignee = 'heartbeat', updated_at = now(),
                 last_activity_at = now(), last_moved_by = 'dispatcher'
           WHERE id = ANY($1::text[]) AND status = 'in_review' AND assignee = 'verifier'
        `, [reclaimedTaskIds]);
      }
      return reclaimedTaskIds;
    });
  }

  static async verificationPoolStats(): Promise<{
    backlog: number;
    active: number;
    suppressedDuplicates: number;
    failures: number;
  }> {
    const rows = await postgresClient.query<{
      backlog: string;
      active: string;
      suppressed_duplicates: string;
      failures: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM work_tasks WHERE archived = false AND status = 'in_review')::text AS backlog,
        (SELECT COUNT(*) FROM work_task_dispatches WHERE kind = 'verification' AND status = 'running')::text AS active,
        (SELECT COUNT(*) FROM work_task_dispatches
          WHERE kind = 'verification' AND status = 'completed'
            AND result LIKE 'suppressed identical terminal generation%')::text AS suppressed_duplicates,
        (SELECT COUNT(*) FROM work_task_dispatches
          WHERE kind = 'verification' AND status = 'failed'
            AND finished_at >= now() - interval '24 hours')::text AS failures
    `);
    const row = rows[0];
    return {
      backlog: Number(row?.backlog ?? 0),
      active: Number(row?.active ?? 0),
      suppressedDuplicates: Number(row?.suppressed_duplicates ?? 0),
      failures: Number(row?.failures ?? 0),
    };
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

      if (finalVerdict === 'APPROVE') {
        await ArtifactCustodyPolicy.persistWithClient(client, taskId, 'done', {
          workKind:   'non_code',
          artifactId: `verification-dispatch:${ id }`,
          evidence:   { artifactSha, currentArtifactSha, verdict: finalVerdict, summary },
          provenance: { routine: 'legacy-verifier', dispatchId: id },
        }, 'verifier');
      }

      await client.query(`
        UPDATE work_task_dispatches
           SET status = 'completed', verdict = $2, artifact_sha = $3,
               result = $4, failure_reason = $5,
               heartbeat_at = now(), finished_at = now()
         WHERE id = $1 AND status = 'running'
      `, [id, finalVerdict, artifactSha, summary, verdict === 'REWORK' ? summary : null]);
      await this.persistReceiptWithClient(client, this.reviewReceipt({
        taskId,
        eventType:          finalVerdict === 'REWORK' ? 'repair' : 'review',
        actor:              'verifier',
        dispatchId:         id,
        disposition:        finalVerdict,
        nextOwner:          transition.assignee ?? 'complete',
        validationSummary:  `${ summary }${ repeatedSuffix }`,
        artifacts:          [{ type: 'reviewed_artifact', canonicalRef: artifactSha, hash: artifactSha }],
        evidence:           { kind: 'dispatch', ref: id },
      }), 'verifier');
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
    currentArtifacts: ReviewArtifactComponent[],
  ): Promise<ReviewDisposition | null> {
    return postgresClient.transaction(async(client: PoolClient) => {
      const current = await client.query<{ task_id: string; review_generation_hash: string | null }>(`
        SELECT d.task_id, d.review_generation_hash
          FROM work_task_dispatches d
          JOIN work_tasks t ON t.id = d.task_id
         WHERE d.id = $1 AND d.kind = 'verification' AND d.status = 'running'
           AND t.status = 'in_review'
         FOR UPDATE OF d, t
      `, [id]);
      const taskId = current.rows[0]?.task_id;
      if (!taskId) return null;
      const liveGenerationHash = WorkTaskDispatchModel.reviewGenerationHash(currentArtifacts);
      if (current.rows[0].review_generation_hash !== evidence.generationHash ||
          liveGenerationHash !== evidence.generationHash) return null;

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
           AND review_generation_hash = $4
           AND findings_fingerprint = $5
         LIMIT 1
      `, [taskId, id, finalDisposition, evidence.generationHash, fingerprint]);

      const transition = finalDisposition === 'PASS'
        ? { status: 'done', assignee: null }
        : finalDisposition === 'REPAIRABLE'
          ? { status: 'todo', assignee: 'dispatcher' }
          : finalDisposition === 'REPLAN'
            ? { status: 'planning', assignee: 'dispatcher' }
        : { status: 'blocked', assignee: 'heartbeat' };

      if (finalDisposition === 'PASS') {
        await ArtifactCustodyPolicy.persistWithClient(client, taskId, 'done', {
          workKind:   'non_code',
          artifactId: `protected-review-dispatch:${ id }`,
          artifactUrl: evidence.artifactUrl ?? undefined,
          evidence:   {
            generationHash: evidence.generationHash,
            artifactHash: evidence.artifactHash,
            checks: evidence.checks,
            findings: evidence.findings,
          },
          provenance: {
            routine: 'protected-review',
            dispatchId: id,
            workflowExecutionId: evidence.workflowExecutionId,
            reviewerAgentIds: evidence.reviewerAgentIds,
          },
        }, 'verifier');
      }

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
               review_generation_hash = $14, review_artifact_types = $15::text[],
               review_artifacts = $16::jsonb, excluded_agent_ids = $17::text[],
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
        evidence.generationHash,
        evidence.artifactTypes,
        JSON.stringify(evidence.artifacts),
        evidence.excludedAgentIds,
      ]);

      if (!duplicate.rows[0]) {
        const escalation = disposition === 'REPAIRABLE' && finalDisposition === 'REPLAN'
          ? '\n\nThe same finding reached the repair ceiling; routed to planning/#667.'
          : '';
        const waitLine = finalDisposition === 'EXTERNAL_WAIT' && evidence.wait
          ? `\nDurable wait: ${ evidence.wait.kind } ${ evidence.wait.targetKey }.`
          : '';
        await this.persistReceiptWithClient(client, this.reviewReceipt({
          taskId,
          eventType:          finalDisposition === 'REPAIRABLE' || finalDisposition === 'REPLAN' ? 'repair' : 'review',
          actor:              'verifier',
          workflowExecutionId: evidence.workflowExecutionId,
          dispatchId:         id,
          disposition:        finalDisposition,
          nextOwner:          transition.assignee ?? 'complete',
          validationSummary:  `${ evidence.summary }${ waitLine }${ escalation }`,
          artifacts:          evidence.artifacts.map(artifact => ({
            type:         artifact.type,
            canonicalRef: artifact.canonicalRef,
            url:          artifact.url ?? undefined,
            hash:         artifact.hash,
          })),
          evidence: { kind: 'dispatch', ref: id },
        }), 'verifier');
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
      const settled = await client.query<{ task_id: string; review_generation_hash: string | null }>(`
        UPDATE work_task_dispatches
           SET status = 'failed', error = $2, failure_reason = $2,
               heartbeat_at = now(), finished_at = now()
         WHERE id = $1 AND kind = 'verification' AND status = 'running'
        RETURNING task_id, review_generation_hash
      `, [id, reason]);
      const taskId = settled.rows[0]?.task_id;
      if (!taskId) return false;
      const generationHash = settled.rows[0].review_generation_hash;
      const equivalent = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM work_task_dispatches
         WHERE task_id = $1 AND kind = 'verification' AND status = 'failed'
           AND failure_reason = $2
           AND review_generation_hash IS NOT DISTINCT FROM $3
      `, [taskId, reason, generationHash]);
      const terminal = Number(equivalent.rows[0]?.count ?? 0) >= 3;
      if (terminal) {
        await client.query(`UPDATE work_task_dispatches SET failure_reason = 'terminal:' || $2 WHERE id = $1`, [id, reason]);
      }
      const duplicate = await client.query<{ id: string }>(`
        SELECT id FROM work_task_dispatches
         WHERE task_id = $1 AND kind = 'verification' AND id <> $2
           AND status = 'failed' AND failure_reason = $3
         LIMIT 1
      `, [taskId, id, reason]);
      if (!duplicate.rows[0] || terminal) {
        await this.persistReceiptWithClient(client, this.reviewReceipt({
          taskId,
          eventType:         terminal ? 'repair' : 'review',
          actor:             'verifier',
          dispatchId:        id,
          disposition:       terminal ? 'REPLAN' : 'RETRY',
          nextOwner:         terminal ? 'dispatcher' : 'protected-review',
          validationSummary: terminal
            ? `Three equivalent verification infrastructure failures for generation ${ generationHash ?? 'unbound' }: ${ reason }`
            : `Verification infrastructure failure released for retry: ${ reason }`,
          artifacts:         generationHash
            ? [{ type: 'review_generation', canonicalRef: generationHash, hash: generationHash }]
            : [{ type: 'verification_dispatch', canonicalRef: id }],
          evidence:          { kind: 'dispatch', ref: id },
        }), 'verifier');
      }
      await client.query(`
        UPDATE work_tasks
           SET status = $2, assignee = $3, updated_at = now(),
               last_moved_at = now(), last_activity_at = now(), last_moved_by = 'verifier'
         WHERE id = $1 AND status = 'in_review'
      `, [taskId, terminal ? 'planning' : 'in_review', terminal ? 'dispatcher' : 'heartbeat']);
      return true;
    });
  }
}
