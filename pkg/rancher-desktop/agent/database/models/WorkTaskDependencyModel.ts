import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { postgresClient } from '../PostgresClient';

/**
 * WorkTaskDependencyModel — FK-backed dependencies between Projects tasks that
 * mechanically gate planning, execution, review, and lane-entry claims. A row
 * means `dependent_task_id` depends on `depends_on_task_id`; the dependent
 * cannot be claimed on any autonomous path until the prerequisite reaches a
 * qualifying terminal state ('done').
 *
 * Design: there is NO cached "resolved" flag. The gate
 * (listUnresolvedDependencies / assertClaimable) always joins the LIVE
 * work_tasks.status, and callers run it INSIDE their own claim transaction
 * (passing their PoolClient) after locking the task row FOR UPDATE. A
 * dependency resolved between queue-scan and claim is therefore observed
 * atomically, and a prerequisite that reaches a failed/cancelled terminal state
 * (status <> 'done') stays blocking — we never silently unblock. Auto-release
 * is a consequence of reading live status, not a separate write path.
 *
 * Rows are soft-archived (archived_at) so attribution and removal history
 * survive. Cycles and self-links are rejected transactionally in create().
 */

export type DependencyRelationType = 'blocks' | 'requires' | 'ordered-after';

const RELATION_TYPES: ReadonlySet<DependencyRelationType> = new Set<DependencyRelationType>([
  'blocks', 'requires', 'ordered-after',
]);

/** A prerequisite in one of these states satisfies (auto-releases) a dependency. */
export const RESOLVING_STATES: readonly string[] = ['done'];

/**
 * Terminal prerequisite states that did NOT satisfy the dependency. Policy: the
 * dependent stays blocked pending an EXPLICIT override (remove the dependency).
 * We never silently unblock on cancellation/parking/failure.
 */
export const FAILED_TERMINAL_STATES: readonly string[] = ['cancelled', 'parked'];

export interface DependencyRecord {
  id: string;
  dependent_task_id: string;
  depends_on_task_id: string;
  relation_type: DependencyRelationType;
  acceptance_condition: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}

export interface CreateDependencyInput {
  dependentTaskId: string;
  dependsOnTaskId: string;
  relationType?: DependencyRelationType | string | null;
  acceptanceCondition?: string | null;
  actor?: string | null;
}

export interface RemoveDependencyInput {
  id?: string;
  dependentTaskId?: string;
  dependsOnTaskId?: string;
  relationType?: DependencyRelationType | string | null;
}

export type UnresolvedPolicy = 'pending' | 'failed_terminal' | 'missing';

export interface UnresolvedDependency {
  dependency: DependencyRecord;
  dependsOnTaskId: string;
  dependsOnStatus: string | null;
  dependsOnTitle: string | null;
  policy: UnresolvedPolicy;
  reason: string;
}

export interface TaskDependencyHold extends UnresolvedDependency {
  taskId: string;
}

export interface DependencyChainEntry {
  taskId: string;
  status: string | null;
  title: string | null;
  relationType: DependencyRelationType;
  depth: number;
  resolved: boolean;
}

export interface ClaimabilityExplanation {
  taskId: string;
  claimable: boolean;
  reason: string;
  unresolved: UnresolvedDependency[];
  chain: DependencyChainEntry[];
  exclusionReasons?: string[];
}

function normalizeRelation(value?: DependencyRelationType | string | null): DependencyRelationType {
  const v = (value ?? 'requires').toString().trim() as DependencyRelationType;
  if (!RELATION_TYPES.has(v)) {
    throw new Error(`Invalid relation_type '${ value }'. Expected one of: blocks, requires, ordered-after.`);
  }
  return v;
}

export class WorkTaskDependencyModel {
  private static readonly TABLE = 'work_task_dependencies';

  /**
   * A correlated `AND NOT EXISTS (...)` SQL fragment for queue-scan claim
   * SELECTs. Interpolate into a candidate query INSIDE the same FOR UPDATE
   * transaction so any task with an unresolved dependency is never selected —
   * fail-closed, non-starving, and free of a scan->claim gap. `taskIdExpr` is a
   * trusted column reference (e.g. 't.id'), never user input.
   */
  static claimExclusionSql(taskIdExpr: string): string {
    return `AND NOT EXISTS (
          SELECT 1 FROM ${ this.TABLE } wtd
          LEFT JOIN work_tasks dep_t ON dep_t.id = wtd.depends_on_task_id
          WHERE wtd.dependent_task_id = ${ taskIdExpr }
            AND wtd.archived_at IS NULL
            AND (dep_t.id IS NULL OR dep_t.status IS DISTINCT FROM 'done')
        )`;
  }


  private static mapRow(row: any): DependencyRecord {
    return {
      id:                   row.id,
      dependent_task_id:    row.dependent_task_id,
      depends_on_task_id:   row.depends_on_task_id,
      relation_type:        row.relation_type as DependencyRelationType,
      acceptance_condition: row.acceptance_condition ?? null,
      created_by:           row.created_by ?? null,
      created_at:           row.created_at,
      updated_at:           row.updated_at ?? null,
      archived_at:          row.archived_at ?? null,
    };
  }

  /**
   * Create (or reactivate) one dependency. Rejects self-links and cycles
   * transactionally: both task rows are locked FOR UPDATE, a pair advisory lock
   * serialises concurrent edits, and a recursive reachability check ensures the
   * prerequisite cannot already reach the dependent before we insert.
   */
  static async create(input: CreateDependencyInput): Promise<DependencyRecord> {
    const relation = normalizeRelation(input.relationType);
    const dependentId = (input.dependentTaskId ?? '').toString().trim();
    const dependsOnId = (input.dependsOnTaskId ?? '').toString().trim();
    if (!dependentId || !dependsOnId) throw new Error('dependent_task_id and depends_on_task_id are required.');
    if (dependentId === dependsOnId) throw new Error('A task cannot depend on itself.');

    return postgresClient.transaction(async(client) => {
      const [lo, hi] = [dependentId, dependsOnId].sort();
      const locked = await client.query<{ id: string; archived: boolean }>(
        `SELECT id, archived FROM work_tasks WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [[lo, hi]],
      );
      const byId = new Map(locked.rows.map(r => [r.id, r]));
      if (!byId.has(dependentId)) throw new Error(`Dependent task not found: ${ dependentId }`);
      if (!byId.has(dependsOnId)) throw new Error(`Depended-on task not found: ${ dependsOnId }`);
      if (byId.get(dependentId)!.archived) throw new Error(`Dependent task is archived: ${ dependentId }`);
      if (byId.get(dependsOnId)!.archived) throw new Error(`Depended-on task is archived: ${ dependsOnId }`);

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wtd:${ lo }:${ hi }`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['work-task-dependency-graph']);

      const cycle = await client.query(
        `WITH RECURSIVE reach AS (
           SELECT $1::text AS node
           UNION
           SELECT d.depends_on_task_id
             FROM ${ this.TABLE } d
             JOIN reach r ON d.dependent_task_id = r.node
            WHERE d.archived_at IS NULL
         )
         SELECT 1 FROM reach WHERE node = $2 LIMIT 1`,
        [dependsOnId, dependentId],
      );
      if (cycle.rows[0]) {
        throw new Error(`Dependency rejected: would create a cycle (${ dependsOnId } already depends on ${ dependentId }).`);
      }

      const existing = await client.query<DependencyRecord>(
        `SELECT * FROM ${ this.TABLE }
          WHERE dependent_task_id = $1 AND depends_on_task_id = $2 AND relation_type = $3
          ORDER BY archived_at NULLS FIRST, updated_at DESC NULLS LAST LIMIT 1 FOR UPDATE`,
        [dependentId, dependsOnId, relation],
      );
      if (existing.rows[0]) {
        const reactivated = await client.query<DependencyRecord>(
          `UPDATE ${ this.TABLE }
              SET archived_at = NULL,
                  acceptance_condition = $2,
                  created_by = COALESCE(created_by, $3),
                  updated_at = now()
            WHERE id = $1 RETURNING *`,
          [existing.rows[0].id, input.acceptanceCondition ?? existing.rows[0].acceptance_condition ?? null, input.actor ?? null],
        );
        return this.mapRow(reactivated.rows[0]);
      }

      const inserted = await client.query<DependencyRecord>(
        `INSERT INTO ${ this.TABLE }
           (id, dependent_task_id, depends_on_task_id, relation_type, acceptance_condition, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
        [`dep-${ randomUUID() }`, dependentId, dependsOnId, relation, input.acceptanceCondition ?? null, input.actor ?? null],
      );
      return this.mapRow(inserted.rows[0]);
    });
  }

  /** Soft-archive one dependency by id, or by (dependent, depends_on, relation). */
  static async remove(input: RemoveDependencyInput): Promise<boolean> {
    return postgresClient.transaction(async(client) => {
      if (input.id) {
        const res = await client.query(
          `UPDATE ${ this.TABLE } SET archived_at = now(), updated_at = now()
            WHERE id = $1 AND archived_at IS NULL`, [input.id]);
        return (res.rowCount ?? 0) > 0;
      }
      const dependentId = (input.dependentTaskId ?? '').toString().trim();
      const dependsOnId = (input.dependsOnTaskId ?? '').toString().trim();
      if (!dependentId || !dependsOnId) throw new Error('Provide id, or both dependent_task_id and depends_on_task_id.');
      const relation = normalizeRelation(input.relationType);
      const res = await client.query(
        `UPDATE ${ this.TABLE } SET archived_at = now(), updated_at = now()
          WHERE dependent_task_id = $1 AND depends_on_task_id = $2 AND relation_type = $3 AND archived_at IS NULL`,
        [dependentId, dependsOnId, relation]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /** Active dependencies where `taskId` is the dependent (its prerequisites). */
  static async listDependencies(taskId: string, opts: { includeArchived?: boolean } = {}): Promise<DependencyRecord[]> {
    const rows = await postgresClient.query<any>(
      `SELECT * FROM ${ this.TABLE }
        WHERE dependent_task_id = $1 ${ opts.includeArchived ? '' : 'AND archived_at IS NULL' }
        ORDER BY created_at ASC`, [taskId]);
    return rows.map(r => this.mapRow(r));
  }

  /** Active dependencies where `taskId` is the prerequisite (its dependents). */
  static async listDependents(taskId: string, opts: { includeArchived?: boolean } = {}): Promise<DependencyRecord[]> {
    const rows = await postgresClient.query<any>(
      `SELECT * FROM ${ this.TABLE }
        WHERE depends_on_task_id = $1 ${ opts.includeArchived ? '' : 'AND archived_at IS NULL' }
        ORDER BY created_at ASC`, [taskId]);
    return rows.map(r => this.mapRow(r));
  }

  /**
   * The fail-closed gate's data: active prerequisites of `taskId` whose task is
   * not 'done'. Pass a PoolClient to run inside the caller's claim transaction
   * so a resolution committed between queue-scan and claim is seen atomically.
   */
  static async listUnresolvedDependencies(taskId: string, client?: PoolClient): Promise<UnresolvedDependency[]> {
    const sql = `
      SELECT d.*, t.id AS dep_exists, t.status AS dep_status, t.title AS dep_title
        FROM ${ this.TABLE } d
        LEFT JOIN work_tasks t ON t.id = d.depends_on_task_id
       WHERE d.dependent_task_id = $1
         AND d.archived_at IS NULL
         AND (t.id IS NULL OR t.status IS DISTINCT FROM 'done')
       ORDER BY d.created_at ASC`;
    const rows = client ? (await client.query(sql, [taskId])).rows : await postgresClient.query<any>(sql, [taskId]);
    return rows.map((r: any) => {
      const status: string | null = r.dep_status ?? null;
      const missing = !r.dep_exists;
      const failed = !!status && FAILED_TERMINAL_STATES.includes(status);
      const policy: UnresolvedPolicy = missing ? 'missing' : failed ? 'failed_terminal' : 'pending';
      const reason = missing
        ? `prerequisite ${ r.depends_on_task_id } is missing or archived; stays blocked pending explicit override`
        : failed
          ? `prerequisite ${ r.depends_on_task_id } reached terminal state '${ status }' without completing; stays blocked pending explicit override`
          : `prerequisite ${ r.depends_on_task_id } is '${ status ?? 'unknown' }', not yet done`;
      return {
        dependency:      this.mapRow(r),
        dependsOnTaskId: r.depends_on_task_id,
        dependsOnStatus: status,
        dependsOnTitle:  r.dep_title ?? null,
        policy,
        reason,
      };
    });
  }

  /** One bounded query for report/UI separation of dependency-held work. */
  static async listUnresolvedForTasks(taskIds: string[]): Promise<TaskDependencyHold[]> {
    if (taskIds.length === 0) return [];
    const rows = await postgresClient.query<any>(`
      SELECT d.*, t.id AS dep_exists, t.status AS dep_status, t.title AS dep_title
        FROM ${ this.TABLE } d
        LEFT JOIN work_tasks t ON t.id = d.depends_on_task_id
       WHERE d.dependent_task_id = ANY($1::text[])
         AND d.archived_at IS NULL
         AND (t.id IS NULL OR t.status IS DISTINCT FROM 'done')
       ORDER BY d.dependent_task_id, d.created_at ASC`, [taskIds]);
    return rows.map((r: any) => {
      const status: string | null = r.dep_status ?? null;
      const missing = !r.dep_exists;
      const failed = !!status && FAILED_TERMINAL_STATES.includes(status);
      const policy: UnresolvedPolicy = missing ? 'missing' : failed ? 'failed_terminal' : 'pending';
      const reason = missing
        ? `prerequisite ${ r.depends_on_task_id } is missing or archived; stays blocked pending explicit override`
        : failed
          ? `prerequisite ${ r.depends_on_task_id } reached terminal state '${ status }' without completing; stays blocked pending explicit override`
          : `prerequisite ${ r.depends_on_task_id } is '${ status ?? 'unknown' }', not yet done`;
      return {
        taskId: r.dependent_task_id,
        dependency: this.mapRow(r),
        dependsOnTaskId: r.depends_on_task_id,
        dependsOnStatus: status,
        dependsOnTitle: r.dep_title ?? null,
        policy,
        reason,
      };
    });
  }

  /**
   * Fail-closed claim gate. MUST be called inside the caller's claim
   * transaction (pass its PoolClient) after the task row is locked FOR UPDATE.
   * Throws (code TASK_DEPENDENCY_UNRESOLVED) when any prerequisite is
   * unresolved, which rolls the claim back.
   */
  static async assertClaimable(taskId: string, client: PoolClient): Promise<void> {
    const unresolved = await this.listUnresolvedDependencies(taskId, client);
    if (unresolved.length > 0) {
      const summary = unresolved.map(u => `${ u.dependsOnTaskId }(${ u.dependsOnStatus ?? 'missing' })`).join(', ');
      const err = new Error(`Task ${ taskId } blocked by ${ unresolved.length } unresolved dependency(ies): ${ summary }`) as Error & {
        code?: string; unresolved?: UnresolvedDependency[];
      };
      err.code = 'TASK_DEPENDENCY_UNRESOLVED';
      err.unresolved = unresolved;
      throw err;
    }
  }

  /** Human/agent-facing claimability explanation with the transitive chain. */
  static async explainClaimability(taskId: string, maxDepth = 25): Promise<ClaimabilityExplanation> {
    const unresolved = await this.listUnresolvedDependencies(taskId);
    const task = await postgresClient.queryOne<{
      id: string;
      status: string;
      archived: boolean;
      assignee: string | null;
      labels: string[] | null;
      epic_status: string | null;
      project_status: string | null;
      epic_archived: boolean | null;
      project_archived: boolean | null;
      has_active_child: boolean;
      has_running_dispatch: boolean;
    }>(`
      SELECT t.id, t.status, t.archived, t.assignee, t.labels,
             e.status AS epic_status, p.status AS project_status,
             e.archived AS epic_archived, p.archived AS project_archived,
             EXISTS (
               SELECT 1 FROM work_tasks child
                WHERE child.parent_id = t.id AND child.archived = false
                  AND child.status NOT IN ('done', 'cancelled', 'parked')
             ) AS has_active_child,
             EXISTS (
               SELECT 1 FROM work_task_dispatches d
                WHERE d.task_id = t.id AND d.status = 'running'
             ) AS has_running_dispatch
        FROM work_tasks t
        LEFT JOIN work_epics e ON e.id = t.epic_id
        LEFT JOIN work_projects p ON p.id = e.project_id
       WHERE t.id = $1
    `, [taskId]);
    const exclusionReasons: string[] = [];
    if (!task) exclusionReasons.push('task is missing');
    else {
      if (task.archived) exclusionReasons.push('task is archived');
      if (!['todo', 'in_review'].includes(task.status)) {
        exclusionReasons.push(`status '${ task.status }' is not a claimable execution or review lane`);
      }
      if (task.epic_status === null || task.epic_archived) exclusionReasons.push('epic is missing or archived');
      else if (['done', 'cancelled', 'parked', 'blocked'].includes(task.epic_status)) {
        exclusionReasons.push(`epic is '${ task.epic_status }'`);
      }
      if (task.project_status === null || task.project_archived) exclusionReasons.push('project is missing or archived');
      else if (['done', 'cancelled', 'parked', 'blocked'].includes(task.project_status)) {
        exclusionReasons.push(`project is '${ task.project_status }'`);
      }
      if (task.assignee && !['heartbeat', 'dispatcher', 'verifier'].includes(task.assignee.toLowerCase())) {
        exclusionReasons.push(`assignee '${ task.assignee }' is outside autonomous ownership`);
      }
      if ((task.labels ?? []).some(label => ['gated', 'decision', 'human', 'manual', 'no-auto-dispatch'].includes(label.trim().toLowerCase()))) {
        exclusionReasons.push('task has a non-autonomous label');
      }
      if (task.has_active_child) exclusionReasons.push('task has open non-terminal children');
      if (task.has_running_dispatch) exclusionReasons.push('task already has a running dispatch');
    }
    const chainRows = await postgresClient.query<any>(
      `WITH RECURSIVE chain AS (
         SELECT d.depends_on_task_id AS task_id, d.relation_type, 1 AS depth
           FROM ${ this.TABLE } d
          WHERE d.dependent_task_id = $1 AND d.archived_at IS NULL
         UNION ALL
         SELECT d.depends_on_task_id, d.relation_type, c.depth + 1
           FROM ${ this.TABLE } d
           JOIN chain c ON d.dependent_task_id = c.task_id
          WHERE d.archived_at IS NULL AND c.depth < $2
       )
       SELECT DISTINCT ON (task_id) task_id, relation_type, depth,
              t.status AS status, t.title AS title
         FROM chain
         LEFT JOIN work_tasks t ON t.id = chain.task_id
        ORDER BY task_id, depth ASC`,
      [taskId, maxDepth]);
    const chain: DependencyChainEntry[] = chainRows.map(r => ({
      taskId:       r.task_id,
      status:       r.status ?? null,
      title:        r.title ?? null,
      relationType: r.relation_type as DependencyRelationType,
      depth:        r.depth,
      resolved:     r.status === 'done',
    }));
    const reasons = [...unresolved.map(u => u.reason), ...exclusionReasons];
    const claimable = reasons.length === 0;
    const reason = claimable
      ? `Task ${ taskId } is claimable: no dispatcher or review exclusions.`
      : `Task ${ taskId } is NOT claimable — ${ reasons.join('; ') }`;
    return { taskId, claimable, reason, unresolved, chain, exclusionReasons };
  }
}
