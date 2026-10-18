import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

export interface ClaimLease { taskId: string; token: string; expiresAt: string }
export interface ClaimResult { claimed: boolean; conflicts: { taskId: string; owner: string }[]; leases: ClaimLease[] }

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function ensureClaimsTable(client: PoolClient): Promise<void> {
  const result = await client.query("SELECT to_regclass('public.work_task_claims') IS NOT NULL AS present");
  if (!result.rows[0]?.present) throw new Error('Projects claim schema is not migrated');
}

export async function recoverExpiredClaims(client: PoolClient, tenantId: string): Promise<number> {
  const expired = await client.query<{ task_id: string; prior_assignee: string | null; claimed_assignee: string }>(`
    UPDATE work_task_claims SET released_at=now(),updated_at=now()
     WHERE tenant_id=$1 AND released_at IS NULL AND expires_at <= now()
    RETURNING task_id,prior_assignee,claimed_assignee`, [tenantId]);
  for (const row of expired.rows) {
    await client.query(`UPDATE work_tasks SET assignee=$2,updated_at=now()
      WHERE id=$1 AND assignee IS NOT DISTINCT FROM $3`, [row.task_id, row.prior_assignee, row.claimed_assignee]);
  }
  return expired.rowCount ?? 0;
}

export async function claimTasks(client: PoolClient, input: {
  tenantId:         string;
  subject:          string;
  externalRef:      string;
  assignees:        Record<string, string>;
  inheritedClaims?: Record<string, string>;
  leaseSeconds?:    number;
}): Promise<ClaimResult> {
  const taskIds = Object.keys(input.assignees);
  if (!input.externalRef.trim()) throw Object.assign(new Error('claim_ref_required'), { status: 400, publicCode: 'claim_ref_required' });
  if (!taskIds.length) return { claimed: true, conflicts: [], leases: [] };
  await client.query("SELECT pg_advisory_xact_lock(hashtext('projects-task-claims'))");
  await recoverExpiredClaims(client, input.tenantId);
  const active = await client.query<{
    task_id:          string;
    owner_subject:    string;
    external_ref:     string;
    lease_hash:       string;
    prior_assignee:   string | null;
    claimed_assignee: string;
  }>(`
    SELECT task_id,owner_subject,external_ref,lease_hash,prior_assignee,claimed_assignee FROM work_task_claims
     WHERE tenant_id=$1 AND task_id=ANY($2::text[]) AND released_at IS NULL FOR UPDATE`, [input.tenantId, taskIds]);
  const inherited = input.inheritedClaims ?? {};
  const conflicts = active.rows.filter(row => row.owner_subject !== input.subject ||
      !Object.prototype.hasOwnProperty.call(inherited, row.task_id) || hash(inherited[row.task_id]) !== row.lease_hash)
    .map(row => ({ taskId: row.task_id, owner: row.owner_subject }));
  if (conflicts.length) return { claimed: false, conflicts, leases: [] };
  const tasks = await client.query<{ id: string; assignee: string | null }>(
    'SELECT id,assignee FROM work_tasks WHERE id=ANY($1::text[]) AND archived=false FOR UPDATE', [taskIds],
  );
  if (tasks.rowCount !== taskIds.length) throw Object.assign(new Error('unknown_task'), { status: 404, publicCode: 'unknown_task' });
  const staleHandoffs = tasks.rows.filter((task) => {
    const existing = active.rows.find(row => row.task_id === task.id);

    return existing && task.assignee !== existing.claimed_assignee;
  }).map(task => ({ taskId: task.id, owner: active.rows.find(row => row.task_id === task.id)!.owner_subject }));

  if (staleHandoffs.length) return { claimed: false, conflicts: staleHandoffs, leases: [] };
  const leaseSeconds = Math.max(60, Math.min(Number(input.leaseSeconds ?? 900), 3600));
  const leases: ClaimLease[] = [];
  for (const task of tasks.rows) {
    const existing = active.rows.find(row => row.task_id === task.id);
    if (existing) {
      const inheritedToken = inherited[task.id];
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const transferred = await client.query(`UPDATE work_task_claims
        SET external_ref=$6,lease_hash=$7,claimed_assignee=$2,expires_at=$3,updated_at=now()
        WHERE tenant_id=$1 AND task_id=$4 AND owner_subject=$5 AND external_ref=$8 AND lease_hash=$9
          AND released_at IS NULL
        RETURNING task_id`, [input.tenantId, input.assignees[task.id], expiresAt, task.id, input.subject,
        input.externalRef, hash(token), existing.external_ref, hash(inheritedToken)]);
      if (!transferred.rows[0]) throw Object.assign(new Error('invalid_lease'), { status: 409, publicCode: 'invalid_lease' });
      const reassigned = await client.query(`UPDATE work_tasks SET assignee=$2,updated_at=now(),last_activity_at=now()
        WHERE id=$1 AND assignee IS NOT DISTINCT FROM $3 RETURNING id`,
      [task.id, input.assignees[task.id], existing.claimed_assignee]);
      if (!reassigned.rows[0]) throw Object.assign(new Error('claim_conflict'), { status: 409, publicCode: 'claim_conflict' });
      leases.push({ taskId: task.id, token, expiresAt });
      continue;
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    await client.query(`INSERT INTO work_task_claims
      (id,tenant_id,task_id,owner_subject,external_ref,lease_hash,prior_assignee,claimed_assignee,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), input.tenantId, task.id, input.subject,
      input.externalRef, hash(token), task.assignee, input.assignees[task.id], expiresAt]);
    await client.query('UPDATE work_tasks SET assignee=$2,updated_at=now(),last_activity_at=now() WHERE id=$1', [task.id, input.assignees[task.id]]);
    leases.push({ taskId: task.id, token, expiresAt });
  }
  return { claimed: true, conflicts: [], leases };
}

export async function renewClaims(client: PoolClient, input: {
  tenantId: string; subject: string; externalRef: string; leases: { taskId: string; token: string }[]; leaseSeconds?: number;
}): Promise<ClaimLease[]> {
  const leaseSeconds = Math.max(60, Math.min(Number(input.leaseSeconds ?? 900), 3600));
  const renewed: ClaimLease[] = [];
  for (const lease of input.leases) {
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const row = await client.query(`UPDATE work_task_claims SET expires_at=$6,updated_at=now()
      WHERE tenant_id=$1 AND task_id=$2 AND owner_subject=$3 AND external_ref=$4 AND lease_hash=$5
        AND released_at IS NULL AND expires_at > now() RETURNING task_id`,
    [input.tenantId, lease.taskId, input.subject, input.externalRef, hash(lease.token), expiresAt]);
    if (!row.rows[0]) throw Object.assign(new Error('invalid_lease'), { status: 409, publicCode: 'invalid_lease' });
    renewed.push({ taskId: lease.taskId, token: lease.token, expiresAt });
  }
  return renewed;
}

export async function releaseClaims(client: PoolClient, input: {
  tenantId: string; subject: string; externalRef: string; leases: { taskId: string; token: string }[];
}): Promise<void> {
  for (const lease of input.leases) {
    const row = await client.query<{ prior_assignee: string | null; claimed_assignee: string }>(`
      UPDATE work_task_claims SET released_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND task_id=$2 AND owner_subject=$3 AND external_ref=$4
         AND lease_hash=$5 AND released_at IS NULL
      RETURNING prior_assignee,claimed_assignee`, [input.tenantId, lease.taskId, input.subject, input.externalRef, hash(lease.token)]);
    if (!row.rows[0]) continue;
    await client.query(`UPDATE work_tasks SET assignee=$2,updated_at=now()
      WHERE id=$1 AND assignee IS NOT DISTINCT FROM $3`, [lease.taskId, row.rows[0].prior_assignee, row.rows[0].claimed_assignee]);
  }
}
