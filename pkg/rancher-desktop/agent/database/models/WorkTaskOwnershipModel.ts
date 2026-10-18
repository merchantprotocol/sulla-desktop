import { ProjectsApiClient } from '../../projects/application/ProjectsApiClient';
import { postgresClient } from '../PostgresClient';

import type { PoolClient } from 'pg';

export interface TaskOwner {
  taskId: string;
  kind:   'agent_job';
  ref:    string;
}

export interface OwnershipClaimResult {
  claimed:   boolean;
  conflicts: TaskOwner[];
}

interface ClaimLease {
  taskId:    string;
  token:     string;
  expiresAt: string;
}

interface ClaimResponse {
  claimed:   boolean;
  conflicts: { taskId: string; owner: string }[];
  leases:    ClaimLease[];
}

const LEASE_SECONDS = 15 * 60;
const RENEW_INTERVAL_MS = 5 * 60_000;
const projectsClient = new ProjectsApiClient();
const activeLeases = new Map<string, ClaimLease[]>();
const renewTimers = new Map<string, ReturnType<typeof setInterval>>();

function leaseWasRejected(error: unknown): boolean {
  return error instanceof Error && /\(invalid_lease\)$/.test(error.message);
}

function isClaimLease(value: unknown): value is ClaimLease {
  return Boolean(value && typeof value === 'object' &&
    typeof (value as ClaimLease).taskId === 'string' &&
    typeof (value as ClaimLease).token === 'string' &&
    typeof (value as ClaimLease).expiresAt === 'string');
}

function leaseRecord(leases: ClaimLease[]): Record<string, ClaimLease> {
  return Object.fromEntries(leases.map(lease => [lease.taskId, lease]));
}

function leaseIdentityRecord(leases: ClaimLease[]): Record<string, Pick<ClaimLease, 'taskId' | 'token'>> {
  return Object.fromEntries(leases.map(({ taskId, token }) => [taskId, { taskId, token }]));
}

function sameLeaseIdentity(left: ClaimLease[] | undefined, right: ClaimLease[]): boolean {
  if (!left || left.length !== right.length) return false;
  const identities = leaseIdentityRecord(left);
  return right.every(lease => identities[lease.taskId]?.token === lease.token);
}

async function storedLeases(jobId: string): Promise<ClaimLease[]> {
  const cached = activeLeases.get(jobId);
  if (cached) return cached;
  const row = await postgresClient.queryOne<{ project_task_prior_assignees: Record<string, ClaimLease> }>(
    'SELECT project_task_prior_assignees FROM agent_jobs WHERE job_id = $1', [jobId],
  );
  const leases = Object.values(row?.project_task_prior_assignees ?? {})
    .filter(isClaimLease);
  if (leases.length) activeLeases.set(jobId, leases);
  return leases;
}

async function inheritedClaimState(jobId: string, taskIds: string[]): Promise<{
  tokens: Record<string, string>;
  owners: { jobId: string; taskIds: string[] }[];
}> {
  if (!taskIds.length) return { tokens: {}, owners: [] };
  const rows = await postgresClient.query<{
    job_id: string; project_task_ids: string[]; project_task_prior_assignees: Record<string, ClaimLease>;
  }>(`
    SELECT owner.job_id, owner.project_task_ids, owner.project_task_prior_assignees
      FROM agent_jobs child
      JOIN agent_jobs owner ON owner.status = 'running'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(owner.tasks, '[]'::jsonb)) AS parent_task
          WHERE parent_task->>'threadId' = child.parent_thread_id
       )
     WHERE child.job_id = $2 AND owner.project_task_ids && $1::text[]
  `, [taskIds, jobId]);
  const tokens: Record<string, string> = {};
  for (const row of rows) {
    for (const taskId of taskIds) {
      const lease = row.project_task_prior_assignees?.[taskId];
      if (lease?.token) tokens[taskId] = lease.token;
    }
  }
  return {
    tokens,
    owners: rows.map(row => ({ jobId: row.job_id, taskIds: row.project_task_ids.filter(id => taskIds.includes(id)) })),
  };
}

function stopRenewal(jobId: string): void {
  const timer = renewTimers.get(jobId);
  if (timer) clearInterval(timer);
  renewTimers.delete(jobId);
}

async function clearRejectedLeases(jobId: string, leases: ClaimLease[]): Promise<void> {
  const cleared = await postgresClient.queryOne<{ job_id: string }>(`
    UPDATE agent_jobs
       SET project_task_ids = '{}'::text[], project_task_prior_assignees = '{}'::jsonb
     WHERE job_id = $1
       AND project_task_prior_assignees @> $2::jsonb
       AND (SELECT count(*) FROM jsonb_object_keys(project_task_prior_assignees)) = $3
     RETURNING job_id
  `, [jobId, JSON.stringify(leaseIdentityRecord(leases)), leases.length]);
  if (cleared && sameLeaseIdentity(activeLeases.get(jobId), leases)) {
    stopRenewal(jobId);
    activeLeases.delete(jobId);
  }
}

async function clearInvalidStoredCustody(row: {
  job_id: string; project_task_ids: string[]; project_task_prior_assignees: Record<string, unknown>;
}): Promise<boolean> {
  const cleared = await postgresClient.queryOne<{ job_id: string }>(`
    UPDATE agent_jobs
       SET project_task_ids = '{}'::text[], project_task_prior_assignees = '{}'::jsonb
     WHERE job_id = $1 AND project_task_ids = $2::text[] AND project_task_prior_assignees = $3::jsonb
     RETURNING job_id
  `, [row.job_id, row.project_task_ids, JSON.stringify(row.project_task_prior_assignees)]);
  if (cleared && !activeLeases.has(row.job_id)) stopRenewal(row.job_id);
  return Boolean(cleared);
}

async function renewLeases(jobId: string, leases: ClaimLease[]): Promise<void> {
  try {
    const renewed = await projectsClient.request<ClaimLease[]>('/v1/claims/renew', {
      externalRef: jobId, leases, leaseSeconds: LEASE_SECONDS,
    });
    const persisted = await postgresClient.queryOne<{ job_id: string }>(`
      UPDATE agent_jobs SET project_task_prior_assignees = $2::jsonb
       WHERE job_id = $1
         AND project_task_prior_assignees @> $3::jsonb
         AND (SELECT count(*) FROM jsonb_object_keys(project_task_prior_assignees)) = $4
       RETURNING job_id
    `, [jobId, JSON.stringify(leaseRecord(renewed)), JSON.stringify(leaseIdentityRecord(leases)), leases.length]);
    if (!persisted) throw new Error(`Agent job ${ jobId } changed task custody while its leases were renewed.`);
    activeLeases.set(jobId, renewed);
  } catch (error) {
    if (leaseWasRejected(error)) {
      await clearRejectedLeases(jobId, leases);
    }
    throw error;
  }
}

function startRenewal(jobId: string): void {
  stopRenewal(jobId);
  const timer = setInterval(() => {
    (async() => {
      const leases = await storedLeases(jobId);
      if (!leases.length) return;
      await renewLeases(jobId, leases);
    })().catch(error => console.warn(`[WorkTaskOwnership] Could not renew task claims for ${ jobId }:`, error));
  }, RENEW_INTERVAL_MS);
  timer.unref?.();
  renewTimers.set(jobId, timer);
}

/**
 * Desktop owns agent_jobs only. Projects task admission and assignee changes
 * are atomic inside the Projects service and represented here by renewable,
 * opaque leases.
 */
export class WorkTaskOwnershipModel {
  static async findOwnersWithClient(client: PoolClient, taskIds: string[], excludeJobId?: string): Promise<TaskOwner[]> {
    if (!taskIds.length) return [];
    const rows = await client.query<{ task_id: string; ref: string }>(`
      SELECT owned.task_id, job.job_id AS ref FROM agent_jobs job
       CROSS JOIN LATERAL unnest(job.project_task_ids) AS owned(task_id)
       WHERE job.status = 'running' AND owned.task_id = ANY($1::text[])
         AND ($2::text IS NULL OR job.job_id <> $2)
    `, [taskIds, excludeJobId ?? null]);
    return rows.rows.map(row => ({ taskId: row.task_id, kind: 'agent_job', ref: row.ref }));
  }

  static async claimForJob(
    jobId: string,
    assignees: Record<string, string>,
    inherited: string[] = [],
  ): Promise<OwnershipClaimResult> {
    const taskIds = Object.keys(assignees);
    if (!taskIds.length) return { claimed: true, conflicts: [] };
    const inheritedState = await inheritedClaimState(jobId, inherited.filter(taskId => taskIds.includes(taskId)));
    const result = await projectsClient.request<ClaimResponse>('/v1/claims/claim', {
      externalRef:     jobId,
      assignees,
      inheritedClaims: inheritedState.tokens,
      leaseSeconds:    LEASE_SECONDS,
    });
    if (!result.claimed) {
      return {
        claimed:   false,
        conflicts: result.conflicts.map(conflict => ({
          taskId: conflict.taskId, kind: 'agent_job', ref: conflict.owner,
        })),
      };
    }
    try {
      activeLeases.set(jobId, result.leases);
      const persisted = await postgresClient.queryOne<{ job_id: string }>(`
        UPDATE agent_jobs
           SET project_task_ids = $2::text[], project_task_prior_assignees = $3::jsonb
         WHERE job_id = $1
         RETURNING job_id
      `, [jobId, taskIds, JSON.stringify(leaseRecord(result.leases))]);
      if (!persisted) throw new Error(`Agent job ${ jobId } is not persisted; task claims were rolled back.`);
      for (const owner of inheritedState.owners) {
        for (const taskId of owner.taskIds) {
          await postgresClient.query(`
            UPDATE agent_jobs
               SET project_task_ids = array_remove(project_task_ids, $2),
                   project_task_prior_assignees = project_task_prior_assignees - $2
             WHERE job_id = $1
          `, [owner.jobId, taskId]);
          const ownerLeases = activeLeases.get(owner.jobId)?.filter(lease => lease.taskId !== taskId);
          if (ownerLeases) {
            activeLeases.set(owner.jobId, ownerLeases);
            if (!ownerLeases.length) stopRenewal(owner.jobId);
          }
        }
      }
      startRenewal(jobId);
      return { claimed: true, conflicts: [] };
    } catch (error) {
      await projectsClient.request('/v1/claims/release', { externalRef: jobId, leases: result.leases }).catch(() => undefined);
      activeLeases.delete(jobId);
      throw error;
    }
  }

  static async releaseForJob(jobId: string): Promise<void> {
    stopRenewal(jobId);
    const leases = await storedLeases(jobId);
    if (leases.length) {
      await projectsClient.request('/v1/claims/release', { externalRef: jobId, leases });
    }
    activeLeases.delete(jobId);
    await postgresClient.query(
      `UPDATE agent_jobs SET project_task_ids = '{}'::text[], project_task_prior_assignees = '{}'::jsonb WHERE job_id = $1`,
      [jobId],
    );
  }

  static async releaseSweptJobs(jobIds: string[]): Promise<void> {
    for (const jobId of jobIds) {
      await this.releaseForJob(jobId).catch(error => console.warn(
        `[WorkTaskOwnership] Could not release tasks for swept job ${ jobId }:`, error,
      ));
    }
  }

  /** Resume renewable claims for tab jobs that intentionally survive restart. */
  static async recoverRunningJobs(): Promise<void> {
    const rows = await postgresClient.query<{
      job_id: string; project_task_ids: string[]; project_task_prior_assignees: Record<string, unknown>;
    }>(`
      SELECT job_id, project_task_ids, project_task_prior_assignees FROM agent_jobs
       WHERE status = 'running' AND cardinality(project_task_ids) > 0
    `);
    for (const row of rows) {
      let leases: ClaimLease[] = [];
      try {
        const record = row.project_task_prior_assignees ?? {};
        const keys = Object.keys(record);
        leases = Object.values(record).filter(isClaimLease);
        const valid = keys.length === row.project_task_ids.length && leases.length === row.project_task_ids.length &&
          row.project_task_ids.every(taskId => isClaimLease(record[taskId]) && record[taskId].taskId === taskId);
        if (!valid) {
          if (await clearInvalidStoredCustody(row)) {
            console.warn(`[WorkTaskOwnership] Cleared invalid stored task claims for ${ row.job_id }.`);
          }
          continue;
        }
        activeLeases.set(row.job_id, leases);
        await renewLeases(row.job_id, leases);
        startRenewal(row.job_id);
      } catch (error) {
        console.warn(`[WorkTaskOwnership] Could not recover task claims for ${ row.job_id }:`, error);
        if (leases.length && !leaseWasRejected(error)) startRenewal(row.job_id);
      }
    }
  }
}
