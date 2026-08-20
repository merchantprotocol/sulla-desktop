import { createHash } from 'node:crypto';

import { BaseModel } from '../BaseModel';
import { postgresClient } from '../PostgresClient';

import { WorkflowHistoryModel } from './WorkflowHistoryModel';

export type WorkflowStatus = 'draft' | 'production' | 'archive';

interface WorkflowAttributes {
  id:                   string;
  name:                 string;
  description:          string | null;
  version:              string | null;
  status:               WorkflowStatus;
  definition:           Record<string, unknown>;
  enabled:              boolean;
  source_template_slug: string | null;
  /**
   * Locked "core" routine baked into Sulla Desktop. Re-asserted from a bundled
   * definition on every boot by the CoreRoutineSeeder. Visible + runnable +
   * disable-able, but cannot be edited or deleted through any user surface.
   */
  system:               boolean;
  /** sha-256 of the seeded definition + notes — drift detection for `system` rows. */
  content_hash:         string | null;
  created_at:           Date;
  updated_at:           Date;
}

/**
 * Thrown when a user-facing surface tries to edit or delete a locked core
 * routine. The mutation choke points (upsertFromDefinition / updateStatus /
 * deleteById) raise this unless the caller is the boot seeder (actor: 'seeder').
 */
export class LockedRoutineError extends Error {
  constructor(id: string, action: string) {
    super(`Workflow "${ id }" is a locked core routine and cannot be ${ action }. It ships with Sulla Desktop — you can disable it, but not edit or delete it.`);
    this.name = 'LockedRoutineError';
  }
}

/**
 * Canonical sha-256 over the routine definition + its notes only (never sibling
 * files). Keys are sorted recursively so cosmetic re-serialization (object key
 * order) never churns the hash — only real content changes flip it.
 */
export function hashRoutineDefinition(definition: Record<string, any>): string {
  const stable = (value: any): any => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc: Record<string, any>, k) => {
        acc[k] = stable(value[k]);
        return acc;
      }, {});
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(stable(definition))).digest('hex');
}

export interface WorkflowListRow {
  id:          string;
  name:        string;
  description: string | null;
  status:      WorkflowStatus;
  updatedAt:   string;
  // nodeCount is derived at query time from the definition JSONB so list
  // consumers don't need to re-parse the full definition just to show
  // "N agents" in a summary row.
  nodeCount:   number;
  // True for locked core routines — the UI shows a lock badge and hides the
  // edit/delete/archive/publish actions (enforcement is also server-side).
  system:      boolean;
}

export class WorkflowModel extends BaseModel<WorkflowAttributes> {
  protected readonly tableName = 'workflows';
  protected readonly primaryKey = 'id';
  protected readonly timestamps = true;

  protected readonly fillable = [
    'id',
    'name',
    'description',
    'version',
    'status',
    'definition',
    'enabled',
    'source_template_slug',
    'system',
    'content_hash',
  ];

  protected readonly casts: Record<string, string> = {
    definition: 'json',
    enabled:    'boolean',
    system:     'boolean',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  };

  /** True if `id` is a locked core routine (system = true). */
  static async isSystem(id: string): Promise<boolean> {
    const row = await postgresClient.queryOne(
      `SELECT system FROM workflows WHERE id = $1 LIMIT 1`,
      [id],
    );
    return row?.system === true;
  }

  static async findById(id: string): Promise<WorkflowModel | null> {
    const row = await postgresClient.queryOne(
      `SELECT * FROM workflows WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!row) return null;
    const model = new WorkflowModel();
    model.databaseFill(row);
    return model;
  }

  static async listAll(): Promise<WorkflowListRow[]> {
    // Pull summary fields only — description for the list display,
    // jsonb_array_length for a cheap node count without shipping the
    // full definition. The CASE guard is defensive: jsonb_array_length
    // throws on anything that isn't a JSON array, and any pre-cutover
    // row with an odd `nodes` shape would otherwise poison the whole
    // query and make the playbill look empty. Full definition still
    // goes through findById.
    const rows = await postgresClient.queryAll(
      `SELECT id,
              name,
              description,
              status,
              system,
              updated_at,
              CASE
                WHEN jsonb_typeof(definition->'nodes') = 'array'
                  THEN jsonb_array_length(definition->'nodes')
                ELSE 0
              END AS node_count
       FROM workflows
       ORDER BY updated_at DESC`,
      [],
    );
    return rows.map((r: any) => ({
      id:          r.id,
      name:        r.name,
      description: r.description ?? null,
      status:      r.status as WorkflowStatus,
      updatedAt:   r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at ?? ''),
      nodeCount:   Number(r.node_count ?? 0),
      system:      r.system === true,
    }));
  }

  static async listByStatus(status: WorkflowStatus): Promise<WorkflowModel[]> {
    const rows = await postgresClient.queryAll(
      `SELECT * FROM workflows WHERE status = $1 ORDER BY updated_at DESC`,
      [status],
    );
    return rows.map((row: any) => {
      const model = new WorkflowModel();
      model.databaseFill(row);
      return model;
    });
  }

  /**
   * Insert or update a workflow from a full definition document.
   *
   * The `definition` argument is the entire workflow graph (nodes, edges, viewport,
   * metadata) as it would appear in YAML. Top-level fields (name, description, version,
   * status) are extracted into columns for indexing; the whole document is stored in
   * the `definition` JSONB column for canonical retrieval.
   *
   * Logs the previous definition into workflow_history on every change.
   */
  static async upsertFromDefinition(
    definition: Record<string, any>,
    options: {
      status?:       WorkflowStatus;
      changedBy?:    string;
      changeReason?: string;
      /**
       * Skip the workflow_history row for this save. Used by undo/redo
       * restores — applying a previous version shouldn't pollute the
       * audit trail with sawtooth "undo" / "redo" entries. The current
       * state of the `workflows` table still updates so reload reflects
       * the restore.
       */
      skipHistory?:  boolean;
      /**
       * The slug of the template this routine was instantiated from. Set
       * on the initial INSERT (from the instantiate handler) and preserved
       * on subsequent canvas saves — UPDATE never touches this column, so
       * passing it later is a no-op. Use setSourceTemplateSlug if you
       * genuinely need to change it after creation.
       */
      sourceTemplateSlug?: string | null;
      /**
       * Who is writing. The boot CoreRoutineSeeder passes 'seeder' — the ONLY
       * actor permitted to create or overwrite a locked core (system) routine.
       * Any other caller editing an existing system row throws LockedRoutineError.
       */
      actor?: 'seeder' | 'user';
      /** Seeder only: mark the row as a locked core routine (system = true). */
      system?: boolean;
      /** Seeder only: sha-256 of the seeded definition, stored in content_hash. */
      contentHash?: string | null;
    } = {},
  ): Promise<WorkflowModel> {
    const id = String(definition.id ?? '').trim();
    if (!id) throw new Error('WorkflowModel.upsertFromDefinition: definition.id is required');

    const isSeeder = options.actor === 'seeder';

    const existing = await WorkflowModel.findById(id);

    // Lock guard: a locked core routine can only be written by the seeder.
    if (existing?.attributes.system && !isSeeder) {
      throw new LockedRoutineError(id, 'edited');
    }

    const name = String(definition.name ?? id);
    const description = definition.description ? String(definition.description) : null;
    const version = definition.version != null ? String(definition.version) : null;
    const status = (options.status
      ?? (definition._status as WorkflowStatus | undefined)
      ?? 'draft') as WorkflowStatus;
    // On a seeder RE-SEED of an existing core routine, preserve the human's
    // enabled/disabled choice — re-asserting the definition must never silently
    // re-enable a routine the human deliberately paused. On first insert, honor
    // the definition.
    const enabled = (isSeeder && existing)
      ? existing.attributes.enabled
      : definition.enabled !== false;
    const sourceTemplateSlug = options.sourceTemplateSlug ?? null;
    const system = isSeeder ? (options.system ?? true) : (existing?.attributes.system ?? false);
    const contentHash = isSeeder ? (options.contentHash ?? null) : (existing?.attributes.content_hash ?? null);

    const isInsert = !existing;
    const definitionBefore = existing ? existing.attributes.definition ?? null : null;

    try {
      const row = await postgresClient.queryOne(
        `INSERT INTO workflows (id, name, description, version, status, definition, enabled, source_template_slug, system, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name         = EXCLUDED.name,
           description  = EXCLUDED.description,
           version      = EXCLUDED.version,
           status       = EXCLUDED.status,
           definition   = EXCLUDED.definition,
           enabled      = EXCLUDED.enabled,
           system       = EXCLUDED.system,
           content_hash = EXCLUDED.content_hash,
           updated_at   = CURRENT_TIMESTAMP
         RETURNING *`,
        [id, name, description, version, status, JSON.stringify(definition), enabled, sourceTemplateSlug, system, contentHash],
      );

      const model = new WorkflowModel();
      model.databaseFill(row);

      if (!options.skipHistory) {
        await WorkflowHistoryModel.recordChange({
          workflowId:       id,
          definitionBefore,
          definitionAfter:  definition,
          changedBy:        options.changedBy ?? null,
          changeReason:     options.changeReason ?? null,
        });
      }

      console.log(`[WorkflowModel.upsert] ← ok ${ isInsert ? 'INSERT' : 'UPDATE' } id=${ id } status=${ status }${ options.skipHistory ? ' (no-history)' : '' }${ options.changeReason ? ` reason="${ options.changeReason }"` : '' }`);

      return model;
    } catch (err) {
      console.error(`[WorkflowModel.upsert] ✗ id=${ id } status=${ status }`, err);
      throw err;
    }
  }

  /**
   * Update only the status (promotion between draft / production / archive).
   * Records a history entry with change_reason "status: draft -> production".
   */
  static async updateStatus(
    id: string,
    newStatus: WorkflowStatus,
    options: { changedBy?: string } = {},
  ): Promise<WorkflowModel | null> {
    const existing = await WorkflowModel.findById(id);
    if (!existing) {
      console.warn(`[WorkflowModel.updateStatus] ✗ id=${ id } — not found`);

      return null;
    }
    // Locked core routines are pinned to their seeded status; pause them with
    // the `enabled` flag instead. (Not applicable to the seeder, which sets
    // status through upsertFromDefinition, never here.)
    if (existing.attributes.system) {
      throw new LockedRoutineError(id, 'promoted or archived');
    }
    const oldStatus = existing.attributes.status;
    if (oldStatus === newStatus) {
      console.log(`[WorkflowModel.updateStatus] ← noop id=${ id } already ${ newStatus }`);

      return existing;
    }

    try {
      const row = await postgresClient.queryOne(
        `UPDATE workflows
         SET status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [id, newStatus],
      );
      if (!row) {
        console.warn(`[WorkflowModel.updateStatus] ✗ id=${ id } — update returned no row`);

        return null;
      }

      const model = new WorkflowModel();
      model.databaseFill(row);

      await WorkflowHistoryModel.recordChange({
        workflowId:       id,
        definitionBefore: existing.attributes.definition ?? null,
        definitionAfter:  model.attributes.definition!,
        changedBy:        options.changedBy ?? null,
        changeReason:     `status: ${ oldStatus } -> ${ newStatus }`,
      });

      console.log(`[WorkflowModel.updateStatus] ← ok id=${ id } ${ oldStatus } → ${ newStatus }`);

      return model;
    } catch (err) {
      console.error(`[WorkflowModel.updateStatus] ✗ id=${ id } → ${ newStatus }`, err);
      throw err;
    }
  }

  static async deleteById(id: string, options: { actor?: 'seeder' | 'user' } = {}): Promise<boolean> {
    // Lock guard: locked core routines cannot be deleted by any user surface.
    if (options.actor !== 'seeder' && await WorkflowModel.isSystem(id)) {
      throw new LockedRoutineError(id, 'deleted');
    }
    try {
      const result = await postgresClient.query(
        `DELETE FROM workflows WHERE id = $1`,
        [id],
      );
      const deleted = (result?.length ?? 0) > 0;
      console.log(`[WorkflowModel.deleteById] ← ${ deleted ? 'ok' : 'miss' } id=${ id }`);

      return deleted;
    } catch (err) {
      console.error(`[WorkflowModel.deleteById] ✗ id=${ id }`, err);
      throw err;
    }
  }

  /**
   * Seed (or re-assert) a locked core routine from its bundled definition.
   * Idempotent and self-healing — safe to run on every boot:
   *
   *   - Absent           → inserted as a system routine, status 'production'.
   *   - Present, in sync → no write (content_hash matches the bundle).
   *   - Present, drifted → silently re-seeded from the bundle (definition
   *                        replaced, hash refreshed). The human's enabled/
   *                        disabled choice is always preserved.
   *
   * This is the ONLY writer permitted to touch a system row (actor: 'seeder').
   * Returns 'inserted' | 'resynced' | 'unchanged'.
   */
  static async seedCoreRoutine(
    definition: Record<string, any>,
  ): Promise<'inserted' | 'resynced' | 'unchanged'> {
    const id = String(definition.id ?? '').trim();
    if (!id) throw new Error('WorkflowModel.seedCoreRoutine: definition.id is required');

    const contentHash = hashRoutineDefinition(definition);
    const existing = await WorkflowModel.findById(id);

    if (existing && existing.attributes.system && existing.attributes.content_hash === contentHash) {
      return 'unchanged';
    }

    await WorkflowModel.upsertFromDefinition(definition, {
      actor:        'seeder',
      system:       true,
      contentHash,
      status:       'production',
      changedBy:    'core-routine-seeder',
      changeReason: existing ? 'core routine re-seeded from bundle' : 'core routine seeded from bundle',
    });

    return existing ? 'resynced' : 'inserted';
  }
}
