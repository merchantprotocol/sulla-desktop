import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { postgresClient } from '../../database.js';

/**
 * WorkTaskDependencyModel — FK-backed dependencies between Projects tasks. A
 * row means `dependent_task_id` depends on `depends_on_task_id`. Dependencies
 * are plain board metadata: they inform readiness (list_ready_tasks, the
 * project report, the UI) and never move or claim work on their own.
 *
 * There is NO cached "resolved" flag. Readiness always joins the LIVE
 * work_tasks.status, so a prerequisite counts as resolved only once it is
 * 'done'; one that reaches a failed/cancelled terminal state stays listed as
 * unresolved until someone removes the dependency explicitly.
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

function normalizeRelation(value?: DependencyRelationType | string | null): DependencyRelationType {
  const v = (value ?? 'requires').toString().trim() as DependencyRelationType;
  if (!RELATION_TYPES.has(v)) {
    throw new Error(`Invalid relation_type '${ value }'. Expected one of: blocks, requires, ordered-after.`);
  }
  return v;
}

export class WorkTaskDependencyModel {
  private static readonly TABLE = 'work_task_dependencies';

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

  /** Active prerequisites of `taskId` whose task is not 'done'. */
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
}

