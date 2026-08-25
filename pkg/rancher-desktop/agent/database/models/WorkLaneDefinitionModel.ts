import { postgresClient } from '../PostgresClient';

import type { PoolClient } from 'pg';

export type WorkLaneScope = 'global_default' | 'project';
export type WorkLaneSemanticRole = 'backlog' | 'planning' | 'execution' | 'review' | 'blocked' | 'terminal' | 'manual';
export type WorkLaneProvenance = 'global' | 'project_override' | 'project_only';

export interface WorkLaneDefinitionRecord {
  id:              string;
  lane_key:        string;
  scope:           WorkLaneScope;
  project_id:      string | null;
  base_lane_key:   string | null;
  display_name:    string;
  description:     string;
  color:           string | null;
  icon:            string | null;
  position:        number;
  semantic_role:   WorkLaneSemanticRole;
  enabled:         boolean;
  archived:        boolean;
  system_required: boolean;
  created_by:      string | null;
  updated_by:      string | null;
  created_at:      string;
  updated_at:      string | null;
  archived_at:     string | null;
  reset_at:        string | null;
}

export interface EffectiveWorkLane extends WorkLaneDefinitionRecord {
  provenance:              WorkLaneProvenance;
  inherited_definition_id: string | null;
}

export interface CreateWorkLaneInput {
  lane_key:         string;
  scope?:           WorkLaneScope;
  project_id?:      string | null;
  base_lane_key?:   string | null;
  display_name:     string;
  description?:     string;
  color?:           string | null;
  icon?:            string | null;
  position?:        number;
  semantic_role?:   WorkLaneSemanticRole;
  enabled?:         boolean;
  system_required?: boolean;
  actor?:           string;
}

export interface UpdateWorkLaneInput {
  display_name?:  string;
  description?:   string;
  color?:         string | null;
  icon?:          string | null;
  position?:      number;
  semantic_role?: WorkLaneSemanticRole;
  enabled?:       boolean;
  actor?:         string;
}

export interface ListWorkLaneOpts {
  scope?:           WorkLaneScope;
  projectId?:       string;
  includeArchived?: boolean;
  includeReset?:    boolean;
}

export interface ArchiveWorkLaneResult {
  lane:       WorkLaneDefinitionRecord;
  movedTasks: number;
}

export interface ArchiveWorkLanePreview {
  taskCount:    number;
  protected:    boolean;
  destinations: EffectiveWorkLane[];
}

export const DEFAULT_WORK_LANES: readonly CreateWorkLaneInput[] = [
  { lane_key: 'backlog', display_name: 'Backlog', position: 0, semantic_role: 'backlog', system_required: true },
  { lane_key: 'todo', display_name: 'To Do', position: 1, semantic_role: 'execution', system_required: true },
  { lane_key: 'planning', display_name: 'Planning', position: 2, semantic_role: 'planning', system_required: true },
  { lane_key: 'in_progress', display_name: 'In Progress', position: 3, semantic_role: 'execution', system_required: true },
  { lane_key: 'in_review', display_name: 'In Review', position: 4, semantic_role: 'review', system_required: true },
  { lane_key: 'blocked', display_name: 'Blocked', position: 5, semantic_role: 'blocked', system_required: true },
  { lane_key: 'done', display_name: 'Done', position: 6, semantic_role: 'terminal', system_required: true },
  { lane_key: 'cancelled', display_name: 'Cancelled', position: 7, semantic_role: 'terminal' },
  { lane_key: 'parked', display_name: 'Parked', position: 8, semantic_role: 'manual' },
] as const;

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = 'lane_';
  for (let i = 0; i < 12; i++) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function requireKey(value: string): string {
  const key = value?.trim();
  if (!key) throw new Error('lane_key is required.');
  return key;
}

function titleFromKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export class WorkLaneDefinitionModel {
  static async ensureTable(): Promise<void> {
    const { PostgresProjectsSchemaVerifier } = await import('../../projects/infrastructure/PostgresProjectsSchemaVerifier');
    return PostgresProjectsSchemaVerifier.verify(['work_lane_definitions']);
  }

  static async get(id: string): Promise<WorkLaneDefinitionRecord | null> {
    return postgresClient.queryOne<WorkLaneDefinitionRecord>(
      'SELECT * FROM work_lane_definitions WHERE id = $1 LIMIT 1', [id],
    );
  }

  static async list(opts: ListWorkLaneOpts = {}): Promise<WorkLaneDefinitionRecord[]> {
    const conditions = [opts.includeReset ? 'true' : 'reset_at IS NULL'];
    const values: unknown[] = [];
    if (!opts.includeArchived) conditions.push('archived = false');
    if (opts.scope) {
      values.push(opts.scope);
      conditions.push(`scope = $${ values.length }`);
    }
    if (opts.projectId) {
      values.push(opts.projectId);
      conditions.push(`project_id = $${ values.length }`);
    }
    return postgresClient.query<WorkLaneDefinitionRecord>(
      `SELECT * FROM work_lane_definitions WHERE ${ conditions.join(' AND ') }
       ORDER BY position ASC, lane_key ASC`, values,
    );
  }

  static async create(input: CreateWorkLaneInput): Promise<WorkLaneDefinitionRecord> {
    const laneKey = requireKey(input.lane_key);
    const scope = input.scope ?? 'global_default';
    const projectId = input.project_id?.trim() || null;
    if (scope === 'project' && !projectId) throw new Error('project_id is required for a project lane.');
    if (scope === 'global_default' && projectId) throw new Error('Global default lanes cannot have a project_id.');

    let baseLaneKey = input.base_lane_key?.trim() || null;
    let inherited: WorkLaneDefinitionRecord | null = null;
    if (scope === 'project' && !baseLaneKey) {
      inherited = await postgresClient.queryOne<WorkLaneDefinitionRecord>(
        `SELECT * FROM work_lane_definitions
          WHERE scope = 'global_default' AND lane_key = $1 AND reset_at IS NULL LIMIT 1`,
        [laneKey],
      );
      if (inherited) baseLaneKey = inherited.lane_key;
    }
    if (scope === 'project' && baseLaneKey && !inherited) {
      inherited = await postgresClient.queryOne<WorkLaneDefinitionRecord>(
        `SELECT * FROM work_lane_definitions
          WHERE scope = 'global_default' AND lane_key = $1 AND reset_at IS NULL LIMIT 1`,
        [baseLaneKey],
      );
      if (!inherited) throw new Error(`No inherited global lane found for key: ${ baseLaneKey }`);
    }
    if (baseLaneKey && baseLaneKey !== laneKey) {
      throw new Error('A project override must keep the inherited lane_key; omit base_lane_key for a project-only lane.');
    }
    if (inherited?.system_required) {
      if (input.enabled === false) throw new Error(`Required lane ${ inherited.lane_key } cannot be disabled.`);
      if (input.semantic_role && input.semantic_role !== inherited.semantic_role) {
        throw new Error(`Required lane ${ inherited.lane_key } cannot change semantic role.`);
      }
    }

    const rows = await postgresClient.query<WorkLaneDefinitionRecord>(`
      INSERT INTO work_lane_definitions (
        id, lane_key, scope, project_id, base_lane_key, display_name, description,
        color, icon, position, semantic_role, enabled, system_required, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      generateId(), laneKey, scope, projectId, scope === 'project' ? baseLaneKey : null,
      input.display_name.trim() || titleFromKey(laneKey), input.description ?? '',
      input.color ?? null, input.icon ?? null, input.position ?? 0,
      input.semantic_role ?? inherited?.semantic_role ?? 'manual', input.enabled ?? true,
      inherited?.system_required ?? input.system_required ?? false, input.actor ?? 'sulla',
    ]);
    return rows[0];
  }

  static async update(id: string, changes: UpdateWorkLaneInput): Promise<WorkLaneDefinitionRecord | null> {
    const existing = await WorkLaneDefinitionModel.get(id);
    if (!existing || existing.reset_at) return null;
    if (changes.enabled === false) {
      throw new Error('Lanes cannot be disabled directly; use archive_lane so populated lanes are moved atomically.');
    }
    if (changes.display_name !== undefined && !changes.display_name.trim()) {
      throw new Error('display_name cannot be empty.');
    }
    if (existing.system_required) {
      if (changes.semantic_role && changes.semantic_role !== existing.semantic_role) {
        throw new Error(`Required lane ${ existing.lane_key } cannot change semantic role.`);
      }
    }
    const sets = ['updated_at = now()', 'updated_by = $1'];
    const values: unknown[] = [changes.actor ?? 'sulla'];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${ column } = $${ values.length }`);
    };
    if (changes.display_name !== undefined) assign('display_name', changes.display_name.trim());
    if (changes.description !== undefined) assign('description', changes.description);
    if (changes.color !== undefined) assign('color', changes.color);
    if (changes.icon !== undefined) assign('icon', changes.icon);
    if (changes.position !== undefined) assign('position', changes.position);
    if (changes.semantic_role !== undefined) assign('semantic_role', changes.semantic_role);
    if (changes.enabled !== undefined) assign('enabled', changes.enabled);
    values.push(id);
    const rows = await postgresClient.query<WorkLaneDefinitionRecord>(
      `UPDATE work_lane_definitions SET ${ sets.join(', ') } WHERE id = $${ values.length } RETURNING *`, values,
    );
    return rows[0] ?? null;
  }

  static async resolveEffective(projectId: string, includeArchived = false): Promise<EffectiveWorkLane[]> {
    const rows = await postgresClient.query<WorkLaneDefinitionRecord>(`
      SELECT * FROM work_lane_definitions
       WHERE reset_at IS NULL
         AND (scope = 'global_default' OR (scope = 'project' AND project_id = $1))
       ORDER BY position ASC, lane_key ASC
    `, [projectId]);
    const globals = new Map(rows.filter(row => row.scope === 'global_default').map(row => [row.lane_key, row]));
    const projectRows = new Map(rows.filter(row => row.scope === 'project').map(row => [row.lane_key, row]));
    const effective: EffectiveWorkLane[] = [];

    for (const global of globals.values()) {
      const override = projectRows.get(global.lane_key);
      const selected = override ?? global;
      projectRows.delete(global.lane_key);
      if (!includeArchived && (selected.archived || !selected.enabled)) continue;
      effective.push({
        ...selected,
        provenance:              override ? 'project_override' : 'global',
        inherited_definition_id: override ? global.id : null,
      });
    }
    for (const projectLane of projectRows.values()) {
      if (!includeArchived && (projectLane.archived || !projectLane.enabled)) continue;
      effective.push({ ...projectLane, provenance: 'project_only', inherited_definition_id: null });
    }
    return effective.sort((a, b) => a.position - b.position || a.lane_key.localeCompare(b.lane_key));
  }

  static async archive(id: string, destinationKey?: string, actor = 'sulla'): Promise<ArchiveWorkLaneResult> {
    return postgresClient.transaction(async(client) => {
      const lane = await WorkLaneDefinitionModel.lockLane(client, id);
      if (!lane || lane.reset_at) throw new Error(`No active lane definition found with id: ${ id }`);
      if (lane.archived) return { lane, movedTasks: 0 };
      if (lane.system_required) throw new Error(`Required lane ${ lane.lane_key } cannot be archived.`);
      // Freeze task writes until the occupancy check, optional move, and lane
      // archive commit together. Otherwise a concurrent status update could
      // enter the source lane between COUNT and UPDATE and become stranded.
      await client.query('LOCK TABLE work_tasks IN SHARE ROW EXCLUSIVE MODE');
      const projectFilter = lane.scope === 'project'
        ? 'AND project_id = $2'
        : `AND NOT EXISTS (
             SELECT 1 FROM work_lane_definitions project_lane
              WHERE project_lane.scope = 'project'
                AND project_lane.project_id = work_tasks.project_id
                AND project_lane.lane_key = $1
                AND project_lane.reset_at IS NULL
           )`;
      const countParams = lane.scope === 'project' ? [lane.lane_key, lane.project_id] : [lane.lane_key];
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM work_tasks WHERE archived = false AND status = $1 ${ projectFilter }`,
        countParams,
      );
      const count = Number(countResult.rows[0]?.count ?? 0);
      const destination = destinationKey?.trim();
      if (count > 0 && !destination) {
        throw new Error(`Lane ${ lane.lane_key } contains ${ count } task(s); destination_lane_key is required.`);
      }
      if (destination) {
        if (destination === lane.lane_key) throw new Error('Destination lane must differ from the archived lane.');
        await WorkLaneDefinitionModel.requireDestination(client, lane, destination);
        const moveParams = lane.scope === 'project'
          ? [destination, actor, lane.lane_key, lane.project_id]
          : [destination, actor, lane.lane_key];
        const moveFilter = lane.scope === 'project'
          ? 'AND project_id = $4'
          : `AND NOT EXISTS (
               SELECT 1 FROM work_lane_definitions project_lane
                WHERE project_lane.scope = 'project'
                  AND project_lane.project_id = work_tasks.project_id
                  AND project_lane.lane_key = $3
                  AND project_lane.reset_at IS NULL
             )`;
        await client.query(
          `UPDATE work_tasks SET status = $1, updated_at = now(), last_moved_at = now(),
             last_activity_at = now(), last_moved_by = $2
            WHERE archived = false AND status = $3 ${ moveFilter }`, moveParams,
        );
      }
      const updated = await client.query<WorkLaneDefinitionRecord>(`
        UPDATE work_lane_definitions
           SET archived = true, enabled = false, archived_at = now(), updated_at = now(), updated_by = $2
         WHERE id = $1 RETURNING *
      `, [id, actor]);
      return { lane: updated.rows[0], movedTasks: count };
    });
  }

  static async previewArchive(id: string): Promise<ArchiveWorkLanePreview> {
    const lane = await WorkLaneDefinitionModel.get(id);
    if (!lane || lane.reset_at) throw new Error(`No active lane definition found with id: ${ id }`);
    const projectFilter = lane.scope === 'project'
      ? 'AND project_id = $2'
      : `AND NOT EXISTS (
           SELECT 1 FROM work_lane_definitions project_lane
            WHERE project_lane.scope = 'project'
              AND project_lane.project_id = work_tasks.project_id
              AND project_lane.lane_key = $1
              AND project_lane.reset_at IS NULL
         )`;
    const params = lane.scope === 'project' ? [lane.lane_key, lane.project_id] : [lane.lane_key];
    const occupied = await postgresClient.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_tasks WHERE archived = false AND status = $1 ${ projectFilter }`,
      params,
    );
    const destinations = lane.scope === 'project'
      ? await WorkLaneDefinitionModel.resolveEffective(lane.project_id!)
      : (await WorkLaneDefinitionModel.list({ scope: 'global_default' }))
        .map(item => ({ ...item, provenance: 'global' as const, inherited_definition_id: null }));
    return {
      taskCount:    Number(occupied?.count ?? 0),
      protected:    lane.system_required,
      destinations: destinations.filter(item => item.lane_key !== lane.lane_key && item.enabled && !item.archived),
    };
  }

  static async restore(id: string, actor = 'sulla'): Promise<WorkLaneDefinitionRecord | null> {
    const existing = await WorkLaneDefinitionModel.get(id);
    if (!existing || existing.reset_at) return null;
    const rows = await postgresClient.query<WorkLaneDefinitionRecord>(`
      UPDATE work_lane_definitions SET archived = false, enabled = true, archived_at = NULL,
        updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *
    `, [id, actor]);
    return rows[0] ?? null;
  }

  static async resetProjectOverride(projectId: string, laneKey: string, actor = 'sulla'): Promise<boolean> {
    const result = await postgresClient.queryWithResult(`
      UPDATE work_lane_definitions SET reset_at = now(), updated_at = now(), updated_by = $3
       WHERE scope = 'project' AND project_id = $1 AND lane_key = $2
         AND base_lane_key IS NOT NULL AND reset_at IS NULL
    `, [projectId, requireKey(laneKey), actor]);
    return (result.rowCount ?? 0) > 0;
  }

  static async reorder(scope: WorkLaneScope, orderedKeys: string[], projectId?: string, actor = 'sulla'): Promise<number> {
    if (scope === 'project' && !projectId) throw new Error('project_id is required for project lane reorder.');
    const keys = orderedKeys.map(requireKey);
    if (new Set(keys).size !== keys.length) throw new Error('ordered_lane_keys contains duplicates.');
    return postgresClient.transaction(async(client) => {
      let changed = 0;
      for (let position = 0; position < keys.length; position++) {
        const params = scope === 'project'
          ? [position, actor, keys[position], projectId]
          : [position, actor, keys[position]];
        const filter = scope === 'project' ? 'AND project_id = $4' : 'AND project_id IS NULL';
        let result = await client.query(`
          UPDATE work_lane_definitions SET position = $1, updated_at = now(), updated_by = $2
           WHERE lane_key = $3 AND scope = '${ scope }' ${ filter } AND reset_at IS NULL
        `, params);
        if (!result.rowCount && scope === 'project') {
          result = await client.query(`
            INSERT INTO work_lane_definitions (
              id, lane_key, scope, project_id, base_lane_key, display_name, description,
              color, icon, position, semantic_role, enabled, system_required, created_by
            )
            SELECT $1, lane_key, 'project', $2, lane_key, display_name, description,
              color, icon, $3, semantic_role, enabled, system_required, $4
              FROM work_lane_definitions
             WHERE scope = 'global_default' AND project_id IS NULL AND lane_key = $5
               AND reset_at IS NULL
            RETURNING id
          `, [generateId(), projectId, position, actor, keys[position]]);
        }
        if (!result.rowCount) throw new Error(`No active ${ scope } lane found for key: ${ keys[position] }`);
        changed += result.rowCount ?? 0;
      }
      return changed;
    });
  }

  static async seedDefaultsAndLegacyStatuses(actor = 'boot-seeder'): Promise<{ defaults: number; legacy: number }> {
    let defaults = 0;
    let legacy = 0;
    const existing = await postgresClient.query<{ lane_key: string }>(`
      SELECT lane_key FROM work_lane_definitions
       WHERE scope = 'global_default' AND reset_at IS NULL
    `);
    const keys = new Set(existing.map(row => row.lane_key));
    for (const lane of DEFAULT_WORK_LANES) {
      if (keys.has(lane.lane_key)) continue;
      await WorkLaneDefinitionModel.create({ ...lane, scope: 'global_default', actor });
      keys.add(lane.lane_key);
      defaults++;
    }
    const statuses = await postgresClient.query<{ status: string }>(`
      SELECT DISTINCT status FROM work_tasks WHERE status IS NOT NULL AND length(status) > 0 ORDER BY status
    `);
    let position = DEFAULT_WORK_LANES.length;
    for (const { status } of statuses) {
      if (keys.has(status)) continue;
      const legacyDisplayName = titleFromKey(status);
      // Legacy task statuses are unconstrained TEXT. Do not route these values
      // through the user-created key validator: trimming here would orphan
      // tasks whose status contains leading/trailing whitespace, and would
      // reject a valid whitespace-only status. The task rows themselves are
      // intentionally never rewritten.
      await postgresClient.query<WorkLaneDefinitionRecord>(`
        INSERT INTO work_lane_definitions (
          id, lane_key, scope, project_id, base_lane_key, display_name, description,
          color, icon, position, semantic_role, enabled, system_required, created_by
        ) VALUES ($1, $2, 'global_default', NULL, NULL, $3, '', NULL, NULL, $4, 'manual', true, false, $5)
        RETURNING *
      `, [
        generateId(), status,
        legacyDisplayName.trim() ? legacyDisplayName : 'Whitespace-only status',
        position++, actor,
      ]);
      keys.add(status);
      legacy++;
    }
    return { defaults, legacy };
  }

  private static async lockLane(client: PoolClient, id: string): Promise<WorkLaneDefinitionRecord | null> {
    const result = await client.query<WorkLaneDefinitionRecord>(
      'SELECT * FROM work_lane_definitions WHERE id = $1 FOR UPDATE', [id],
    );
    return result.rows[0] ?? null;
  }

  private static async requireDestination(client: PoolClient, lane: WorkLaneDefinitionRecord, key: string): Promise<void> {
    const result = lane.scope === 'project'
      ? await client.query<WorkLaneDefinitionRecord>(`
          SELECT * FROM (
            SELECT * FROM work_lane_definitions
             WHERE reset_at IS NULL AND lane_key = $1
               AND (scope = 'global_default' OR (scope = 'project' AND project_id = $2))
             ORDER BY CASE WHEN scope = 'project' THEN 0 ELSE 1 END LIMIT 1
          ) effective
          WHERE effective.archived = false AND effective.enabled = true
        `, [key, lane.project_id])
      : await client.query<WorkLaneDefinitionRecord>(`
          SELECT * FROM work_lane_definitions
           WHERE reset_at IS NULL AND archived = false AND enabled = true
             AND scope = 'global_default' AND lane_key = $1
             AND NOT EXISTS (
               SELECT 1
                 FROM work_tasks task
                 JOIN work_lane_definitions destination_override
                   ON destination_override.scope = 'project'
                  AND destination_override.project_id = task.project_id
                  AND destination_override.lane_key = $1
                  AND destination_override.reset_at IS NULL
                WHERE task.archived = false AND task.status = $2
                  AND (destination_override.archived = true OR destination_override.enabled = false)
                  AND NOT EXISTS (
                    SELECT 1 FROM work_lane_definitions source_override
                     WHERE source_override.scope = 'project'
                       AND source_override.project_id = task.project_id
                       AND source_override.lane_key = $2
                       AND source_override.reset_at IS NULL
                  )
             )
           LIMIT 1
        `, [key, lane.lane_key]);
    if (!result.rows[0]) throw new Error(`Destination lane is not active in this scope: ${ key }`);
  }
}

/**
 * Map a task status (its lane key) to a semantic role, honouring custom project
 * lanes via their resolved semantic_role and falling back to the built-in
 * status->role mapping. Pure, so it is exhaustively unit-testable (issue #711).
 */
export const DEFAULT_STATUS_SEMANTIC_ROLE: Record<string, WorkLaneSemanticRole> = {
  backlog:     'backlog',
  todo:        'execution',
  planning:    'planning',
  in_progress: 'execution',
  in_review:   'review',
  blocked:     'blocked',
  done:        'terminal',
  cancelled:   'terminal',
  parked:      'manual',
};

export function resolveRoleForStatus(
  status: string,
  effectiveLanes: readonly { lane_key: string; semantic_role?: WorkLaneSemanticRole | null }[] = [],
): WorkLaneSemanticRole {
  const match = effectiveLanes.find(lane => lane.lane_key === status);
  if (match?.semantic_role) return match.semantic_role;
  return DEFAULT_STATUS_SEMANTIC_ROLE[status] ?? 'execution';
}
