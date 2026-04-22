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
  created_at:           Date;
  updated_at:           Date;
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
  ];

  protected readonly casts: Record<string, string> = {
    definition: 'json',
    enabled:    'boolean',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  };

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
    } = {},
  ): Promise<WorkflowModel> {
    const id = String(definition.id ?? '').trim();
    if (!id) throw new Error('WorkflowModel.upsertFromDefinition: definition.id is required');

    const name = String(definition.name ?? id);
    const description = definition.description ? String(definition.description) : null;
    const version = definition.version != null ? String(definition.version) : null;
    const status = (options.status
      ?? (definition._status as WorkflowStatus | undefined)
      ?? 'draft') as WorkflowStatus;
    const enabled = definition.enabled !== false;
    const sourceTemplateSlug = options.sourceTemplateSlug ?? null;

    const existing = await WorkflowModel.findById(id);
    const isInsert = !existing;
    const definitionBefore = existing ? existing.attributes.definition ?? null : null;

    try {
      const row = await postgresClient.queryOne(
        `INSERT INTO workflows (id, name, description, version, status, definition, enabled, source_template_slug)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           name        = EXCLUDED.name,
           description = EXCLUDED.description,
           version     = EXCLUDED.version,
           status      = EXCLUDED.status,
           definition  = EXCLUDED.definition,
           enabled     = EXCLUDED.enabled,
           updated_at  = CURRENT_TIMESTAMP
         RETURNING *`,
        [id, name, description, version, status, JSON.stringify(definition), enabled, sourceTemplateSlug],
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

  static async deleteById(id: string): Promise<boolean> {
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
}
