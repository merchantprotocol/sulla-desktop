import { postgresClient } from '../PostgresClient';

import type { PoolClient } from 'pg';

export type ProjectViewType = 'board' | 'table' | 'gantt' | 'calendar' | 'list';

export interface ProjectViewConfiguration {
  search?:        string;
  filters?:       Record<string, string[]>;
  sort?:          { field: string; direction: 'asc' | 'desc' };
  groupBy?:       string;
  visibleFields?: string[];
  zoom?:          'day' | 'week' | 'month';
  dateAnchor?:    string;
  collapsedIds?:  string[];
}

export interface WorkProjectViewRecord {
  id:            string;
  project_id:    string | null;
  name:          string;
  view_type:     ProjectViewType;
  configuration: ProjectViewConfiguration;
  is_default:    boolean;
  created_by:    string;
  created_at:    string;
  updated_at:    string;
  archived:      boolean;
}

export interface SaveProjectViewInput {
  id?:            string;
  project_id?:    string | null;
  name?:          string;
  view_type:      ProjectViewType;
  configuration?: ProjectViewConfiguration;
  is_default?:    boolean;
  actor?:         string;
}

function viewId(): string {
  return `view_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 8) }`;
}

export class WorkProjectViewModel {
  static async list(projectId?: string | null): Promise<WorkProjectViewRecord[]> {
    return postgresClient.query<WorkProjectViewRecord>(`
      SELECT * FROM work_project_views
      WHERE archived = false AND (project_id IS NULL OR project_id = $1)
      ORDER BY project_id NULLS FIRST, is_default DESC, updated_at DESC`, [projectId ?? null]);
  }

  static async resolve(projectId?: string | null): Promise<WorkProjectViewRecord | null> {
    const rows = await postgresClient.query<WorkProjectViewRecord>(`
      SELECT * FROM work_project_views
      WHERE archived = false AND is_default = true
        AND (project_id = $1 OR project_id IS NULL)
      ORDER BY project_id NULLS LAST LIMIT 1`, [projectId ?? null]);
    return rows[0] ?? null;
  }

  static async save(input: SaveProjectViewInput): Promise<WorkProjectViewRecord> {
    return postgresClient.transaction(async(client) => {
      if (input.project_id) {
        const project = await client.query('SELECT id FROM work_projects WHERE id = $1 AND archived = false', [input.project_id]);
        if (!project.rows[0]) throw new Error(`No active project found with id: ${ input.project_id }`);
      }
      if (input.is_default) {
        const current = input.id
          ? null
          : await client.query<{ id: string }>(`
          SELECT id FROM work_project_views
          WHERE archived = false AND is_default = true
            AND project_id IS NOT DISTINCT FROM $1
          LIMIT 1 FOR UPDATE`, [input.project_id ?? null]);
        const id = input.id ?? current?.rows[0]?.id ?? viewId();
        await client.query(`UPDATE work_project_views SET is_default = false, updated_at = now()
          WHERE archived = false AND project_id IS NOT DISTINCT FROM $1`, [input.project_id ?? null]);
        return WorkProjectViewModel.upsert(client, id, input);
      }
      return WorkProjectViewModel.upsert(client, input.id ?? viewId(), input);
    });
  }

  private static async upsert(client: PoolClient, id: string, input: SaveProjectViewInput): Promise<WorkProjectViewRecord> {
    const rows = await client.query<WorkProjectViewRecord>(`
        INSERT INTO work_project_views
          (id, project_id, name, view_type, configuration, is_default, created_by)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, view_type = EXCLUDED.view_type,
          configuration = EXCLUDED.configuration, is_default = EXCLUDED.is_default,
          updated_at = now()
        RETURNING *`, [id, input.project_id ?? null, input.name ?? 'Default', input.view_type,
      JSON.stringify(input.configuration ?? {}), input.is_default ?? false, input.actor ?? 'human']);
    return rows.rows[0];
  }
}
