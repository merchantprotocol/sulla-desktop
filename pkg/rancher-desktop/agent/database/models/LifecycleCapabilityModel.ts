import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';
import { WorkLaneDefinitionModel, type WorkLaneSemanticRole } from './WorkLaneDefinitionModel';

import type { PoolClient } from 'pg';

export const LIFECYCLE_CAPABILITY_KEYS = [
  'planning-council',
  'todo-execution',
  'in-review-verification',
  'durable-waits',
  'stale-recovery',
] as const;

export type LifecycleCapabilityKey = typeof LIFECYCLE_CAPABILITY_KEYS[number];
export type LifecycleHealth = 'healthy' | 'degraded' | 'unavailable';
export type LifecycleFallback = 'heartbeat' | 'manual_hold' | 'keep_current';

export interface LifecycleCapabilityRecord {
  capability_key:      LifecycleCapabilityKey;
  version:             number;
  enabled:             boolean;
  health:              LifecycleHealth;
  active_owner:        string | null;
  runtime_instance_id: string | null;
  last_success_at:     string | null;
  exception_count:     number;
  fallback_mode:       LifecycleFallback;
  fallback_active:     boolean;
  last_error:          string | null;
  recovery_task_id:    string | null;
  updated_at:          string;
}

export interface LifecycleStageClaim {
  id:                  string;
  task_id:             string;
  capability_key:      LifecycleCapabilityKey;
  stage:               string;
  owner:               string;
  runtime_instance_id: string;
  status:              'active' | 'released' | 'recovered' | 'cancelled';
  claimed_at:          string;
  heartbeat_at:        string;
  released_at:         string | null;
}

export interface CapabilityReport {
  key:                LifecycleCapabilityKey;
  version?:           number;
  enabled:            boolean;
  health:             LifecycleHealth;
  owner?:             string | null;
  runtimeInstanceId?: string | null;
  fallbackMode:       LifecycleFallback;
  error?:             string | null;
}

export interface ClaimResult {
  claimed: boolean;
  reason?: string;
  claim?:  LifecycleStageClaim;
}

const ROLE_CAPABILITY: Partial<Record<WorkLaneSemanticRole, LifecycleCapabilityKey>> = {
  blocked:   'planning-council',
  planning:  'planning-council',
  execution: 'todo-execution',
  review:    'in-review-verification',
};

function effectiveOwner(capability: LifecycleCapabilityRecord): string | null {
  if (capability.enabled && capability.health === 'healthy' && capability.active_owner) {
    return capability.active_owner;
  }
  if (capability.enabled && capability.health === 'degraded' && capability.fallback_mode === 'keep_current') {
    return capability.active_owner;
  }
  if (capability.fallback_mode === 'heartbeat') return 'heartbeat';
  return null;
}

export class LifecycleCapabilityModel {
  private static compatibilityCapability(status: string): LifecycleCapabilityKey | null {
    if (status === 'planning' || status === 'blocked') return 'planning-council';
    if (status === 'todo' || status === 'in_progress') return 'todo-execution';
    if (status === 'in_review') return 'in-review-verification';
    return null;
  }

  static capabilityForRole(role: WorkLaneSemanticRole): LifecycleCapabilityKey | null {
    return ROLE_CAPABILITY[role] ?? null;
  }

  static async capabilityForTask(
    projectId: string,
    status: string,
  ): Promise<LifecycleCapabilityKey | null> {
    const role = await WorkLaneDefinitionModel.semanticRoleForStatus(projectId, status);
    return LifecycleCapabilityModel.capabilityForRole(role);
  }

  static async report(report: CapabilityReport): Promise<LifecycleCapabilityRecord> {
    const fallbackActive = !(report.enabled && report.health === 'healthy' && report.owner);
    const row = await postgresClient.queryOne<LifecycleCapabilityRecord>(`
      INSERT INTO lifecycle_capabilities (
        capability_key, version, enabled, health, active_owner,
        runtime_instance_id, last_success_at, exception_count,
        fallback_mode, fallback_active, last_error, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        CASE WHEN $4 = 'healthy' THEN now() ELSE NULL END,
        CASE WHEN $4 = 'healthy' THEN 0 ELSE 1 END,
        $7, $8, $9, now()
      )
      ON CONFLICT (capability_key) DO UPDATE SET
        version = EXCLUDED.version,
        enabled = EXCLUDED.enabled,
        health = EXCLUDED.health,
        active_owner = EXCLUDED.active_owner,
        runtime_instance_id = EXCLUDED.runtime_instance_id,
        last_success_at = CASE
          WHEN EXCLUDED.health = 'healthy' THEN now()
          ELSE lifecycle_capabilities.last_success_at END,
        exception_count = CASE
          WHEN EXCLUDED.health = 'healthy' THEN 0
          WHEN lifecycle_capabilities.health = EXCLUDED.health
            AND lifecycle_capabilities.last_error IS NOT DISTINCT FROM EXCLUDED.last_error
            THEN lifecycle_capabilities.exception_count
          ELSE lifecycle_capabilities.exception_count + 1 END,
        fallback_mode = EXCLUDED.fallback_mode,
        fallback_active = EXCLUDED.fallback_active,
        last_error = EXCLUDED.last_error,
        updated_at = now()
      RETURNING *
    `, [
      report.key,
      report.version ?? 1,
      report.enabled,
      report.health,
      report.owner ?? null,
      report.runtimeInstanceId ?? null,
      report.fallbackMode,
      fallbackActive,
      report.error ?? null,
    ]);
    if (!row) throw new Error(`Failed to report lifecycle capability ${ report.key }`);

    if (row.health === 'healthy' && row.recovery_task_id) {
      await LifecycleCapabilityModel.resolveRecoveryTask(row);
    } else if (row.health === 'degraded') {
      await LifecycleCapabilityModel.ensureRecoveryTask(row);
    }
    return row;
  }

  /**
   * Atomically recover claims owned by a previous process instance. There is
   * intentionally no age predicate: restart identity, not elapsed time, proves
   * the old owner is gone.
   */
  static async recoverPreviousRuntime(key: LifecycleCapabilityKey, runtimeInstanceId: string): Promise<string[]> {
    return postgresClient.transaction(async(client) => {
      const recovered = await client.query<{ task_id: string }>(`
        UPDATE work_task_stage_claims
           SET status = 'recovered', released_at = now()
         WHERE capability_key = $1
           AND status = 'active'
           AND runtime_instance_id <> $2
        RETURNING task_id
      `, [key, runtimeInstanceId]);
      return recovered.rows.map(row => row.task_id);
    });
  }

  static async claimStage(
    taskId: string,
    key: LifecycleCapabilityKey,
    stage: string,
    owner: string,
    runtimeInstanceId: string,
  ): Promise<ClaimResult> {
    return postgresClient.transaction(client => LifecycleCapabilityModel.claimStageWithClient(
      client,
      taskId,
      key,
      stage,
      owner,
      runtimeInstanceId,
    ));
  }

  static async claimStageWithClient(
    client: PoolClient,
    taskId: string,
    key: LifecycleCapabilityKey,
    stage: string,
    owner: string,
    runtimeInstanceId: string,
  ): Promise<ClaimResult> {
    const capabilityResult = await client.query<LifecycleCapabilityRecord>(`
        SELECT * FROM lifecycle_capabilities WHERE capability_key = $1 FOR UPDATE
      `, [key]);
    const capability = capabilityResult.rows[0];
    if (!capability) return { claimed: false, reason: `capability ${ key } is not registered` };

    const authorized = effectiveOwner(capability);
    if (!authorized) {
      return { claimed: false, reason: `${ key } is ${ capability.enabled ? capability.health : 'disabled' }; fallback ${ capability.fallback_mode } holds work` };
    }
    if (authorized !== owner) {
      return { claimed: false, reason: `${ key } is owned by ${ authorized }` };
    }

    const existing = await client.query<LifecycleStageClaim>(`
        SELECT * FROM work_task_stage_claims
         WHERE task_id = $1 AND stage = $2 AND status = 'active'
         FOR UPDATE
      `, [taskId, stage]);
    if (existing.rows[0]) {
      const claim = existing.rows[0];
      if (claim.owner === owner && claim.runtime_instance_id === runtimeInstanceId) {
        return { claimed: true, claim };
      }
      return { claimed: false, reason: `${ stage } already claimed by ${ claim.owner }` };
    }

    const inserted = await client.query<LifecycleStageClaim>(`
        INSERT INTO work_task_stage_claims
          (id, task_id, capability_key, stage, owner, runtime_instance_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [`stage-${ randomUUID() }`, taskId, key, stage, owner, runtimeInstanceId]);
    return { claimed: true, claim: inserted.rows[0] };
  }

  static async releaseStage(claimId: string, status: 'released' | 'cancelled' = 'released'): Promise<void> {
    await postgresClient.query(`
      UPDATE work_task_stage_claims
         SET status = $2, released_at = now(), heartbeat_at = now()
       WHERE id = $1 AND status = 'active'
    `, [claimId, status]);
  }

  static async assertActorCanManageTask(status: string, labels: string[] | null, actor: string): Promise<void>;
  static async assertActorCanManageTask(taskId: string, projectId: string, status: string, actor: string): Promise<void>;
  static async assertActorCanManageTask(
    taskOrStatus: string,
    projectOrLabels: string | string[] | null,
    statusOrActor: string,
    maybeActor?: string,
  ): Promise<void> {
    const compatibilityCall = maybeActor === undefined;
    const taskId = compatibilityCall ? '' : taskOrStatus;
    const projectId = compatibilityCall ? '' : projectOrLabels as string;
    const status = compatibilityCall ? taskOrStatus : statusOrActor;
    const actor = compatibilityCall ? statusOrActor : maybeActor;
    if (actor !== 'heartbeat') return;
    const activeWait = taskId
      ? await postgresClient.queryOne<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM work_task_waits WHERE task_id = $1 AND status = 'active') AS present`,
        [taskId],
      ).catch(() => null)
      : null;
    const key = activeWait?.present
      ? 'durable-waits'
      : compatibilityCall
        ? LifecycleCapabilityModel.compatibilityCapability(status)
        : await LifecycleCapabilityModel.capabilityForTask(projectId, status);
    if (!key) return;
    const capability = await postgresClient.queryOne<LifecycleCapabilityRecord>(
      'SELECT * FROM lifecycle_capabilities WHERE capability_key = $1',
      [key],
    );
    // Old/incomplete rollout: no row means preserve the working Heartbeat path.
    if (!capability) return;
    const owner = effectiveOwner(capability);
    if (owner !== 'heartbeat') {
      throw new Error(`Lifecycle handoff denied: ${ key } is ${ capability.health } and owned by ${ owner ?? 'manual hold' }.`);
    }
  }

  /** Remove stages owned by healthy protected services from Heartbeat's queue. */
  static async filterHeartbeatEligible<T extends { id: string; project_id?: string; status: string }>(tasks: T[]): Promise<T[]> {
    if (tasks.length === 0) return tasks;
    const rows = await postgresClient.query<LifecycleCapabilityRecord>(`
      SELECT * FROM lifecycle_capabilities
       WHERE capability_key = ANY($1::text[])
    `, [[...LIFECYCLE_CAPABILITY_KEYS]]);
    const byKey = new Map(rows.map(row => [row.capability_key, row]));

    const keyed = await Promise.all(tasks.map(async task => ({
      task,
      key: task.project_id
        ? await LifecycleCapabilityModel.capabilityForTask(task.project_id, task.status)
        : LifecycleCapabilityModel.compatibilityCapability(task.status),
    })));
    return keyed.filter(({ key }) => {
      if (!key) return true;
      const capability = byKey.get(key);
      // Incomplete rollout preserves the current working Heartbeat owner.
      return !capability || effectiveOwner(capability) === 'heartbeat';
    }).map(({ task }) => task);
  }

  static async buildDigest(): Promise<string> {
    const rows = await postgresClient.query<LifecycleCapabilityRecord>(`
      SELECT * FROM lifecycle_capabilities
       WHERE capability_key = ANY($1::text[])
       ORDER BY array_position($1::text[], capability_key)
    `, [[...LIFECYCLE_CAPABILITY_KEYS]]);
    if (rows.length === 0) return 'LIFECYCLE: control plane unavailable; Heartbeat retains legacy ownership.';
    const compact = rows.map(row => {
      const last = row.last_success_at ? new Date(row.last_success_at).toISOString() : 'never';
      const owner = effectiveOwner(row) ?? 'hold';
      return `${ row.capability_key }@${ row.version }=${ row.enabled ? row.health : 'disabled' } owner:${ owner } ok:${ last } ex:${ row.exception_count } fallback:${ row.fallback_mode }${ row.fallback_active ? '*' : '' }`;
    });
    return ['LIFECYCLE:', ...compact.map(line => `  • ${ line }`)].join('\n');
  }

  private static async ensureRecoveryTask(capability: LifecycleCapabilityRecord): Promise<void> {
    await postgresClient.transaction(async(client: PoolClient) => {
      const locked = await client.query<LifecycleCapabilityRecord>(
        'SELECT * FROM lifecycle_capabilities WHERE capability_key = $1 FOR UPDATE',
        [capability.capability_key],
      );
      const current = locked.rows[0];
      if (current?.health !== 'degraded') return;
      const id = `caprec-${ current.capability_key }`;
      const context = await client.query<{ project_id: string; epic_id: string }>(`
        SELECT p.id AS project_id, e.id AS epic_id
          FROM work_projects p
          JOIN work_epics e ON e.project_id = p.id AND e.archived = false
         WHERE p.archived = false
           AND p.status NOT IN ('done', 'cancelled', 'parked')
           AND e.status NOT IN ('done', 'cancelled', 'parked')
         ORDER BY (LOWER(COALESCE(p.owner, '')) = 'heartbeat') DESC,
                  p.last_moved_at ASC, e.position ASC
         LIMIT 1
      `);
      const target = context.rows[0];
      if (!target) return;
      await client.query(`
        INSERT INTO work_tasks (
          id, project_id, epic_id, title, description, status, priority,
          assignee, labels, source, source_ref, created_by, last_moved_by
        ) VALUES ($1, $2, $3, $4, $5,
          resolve_project_lane_key($2, 'execution', 'todo'), 'critical', 'dispatcher',
          ARRAY['systemic-recovery', 'lifecycle-capability'], 'system', $6,
          'lifecycle-control-plane', 'lifecycle-control-plane')
        ON CONFLICT (id) DO UPDATE SET
          description = EXCLUDED.description,
          status = CASE
            WHEN resolve_work_task_lane_role(work_tasks.id, work_tasks.status) = 'terminal'
              THEN EXCLUDED.status
            ELSE work_tasks.status END,
          priority = 'critical', archived = false, updated_at = now(), last_activity_at = now()
      `, [
        id,
        target.project_id,
        target.epic_id,
        `Recover lifecycle capability: ${ current.capability_key }`,
        `Capability ${ current.capability_key } is degraded. Owner: ${ current.active_owner ?? 'none' }. Error: ${ current.last_error ?? 'unknown' }. Exception count: ${ current.exception_count }. Restore health without bypassing its single-owner claim.`,
        `lifecycle-capability:${ current.capability_key }`,
      ]);
      await client.query(
        'UPDATE lifecycle_capabilities SET recovery_task_id = $2 WHERE capability_key = $1',
        [current.capability_key, id],
      );
    });
  }

  private static async resolveRecoveryTask(capability: LifecycleCapabilityRecord): Promise<void> {
    await postgresClient.transaction(async(client) => {
      await client.query(`
        UPDATE work_tasks
           SET status = resolve_project_lane_key(project_id, 'terminal', 'done'),
               completed_at = now(), updated_at = now(),
               last_moved_at = now(), last_activity_at = now(),
               last_moved_by = 'lifecycle-control-plane'
         WHERE id = $1 AND resolve_work_task_lane_role(id, status) <> 'terminal'
      `, [capability.recovery_task_id]);
      await client.query(
        'UPDATE lifecycle_capabilities SET recovery_task_id = NULL WHERE capability_key = $1',
        [capability.capability_key],
      );
    });
  }
}
