import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

import type { LaneContract } from './WorkLaneWorkflowBindingModel';

export const CORE_PROJECT_PIPELINE_TEMPLATE_ID = 'core-project-template-default';

export interface ProjectPipelineTemplateRecord {
  id:          string;
  template_key:string;
  name:        string;
  description: string;
  version:     number;
  system:      boolean;
  locked:      boolean;
  enabled:     boolean;
  created_by:  string | null;
  updated_by:  string | null;
  created_at:  string;
  updated_at:  string | null;
  archived_at: string | null;
}

export interface ProjectPipelineTemplateStageRecord {
  id:                  string;
  template_id:         string;
  stage_key:           string;
  display_name:        string;
  description:         string;
  position:            number;
  semantic_role:       string | null;
  bundled_workflow_id: string | null;
  entry_policy:        Record<string, unknown>;
  wip_limit:           number | null;
}

export interface ProjectPipelineTemplate extends ProjectPipelineTemplateRecord {
  stages: ProjectPipelineTemplateStageRecord[];
}

export interface CreateProjectPipelineTemplateInput {
  templateKey: string;
  name: string;
  description?: string;
  stages: Array<{
    stageKey: string;
    displayName: string;
    description?: string;
    position: number;
    semanticRole?: string | null;
    workflowId?: string | null;
    entryPolicy?: Record<string, unknown>;
    wipLimit?: number | null;
  }>;
  actor?: string;
}

function required(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${ field } is required.`);
  return normalized;
}

export class WorkProjectPipelineTemplateModel {
  static async list(includeArchived = false): Promise<ProjectPipelineTemplateRecord[]> {
    return postgresClient.query<ProjectPipelineTemplateRecord>(`
      SELECT * FROM work_project_pipeline_templates
       WHERE ($1::boolean OR archived_at IS NULL) AND enabled = true
       ORDER BY system DESC, name ASC, id ASC
    `, [includeArchived]);
  }

  static async get(id: string): Promise<ProjectPipelineTemplate | null> {
    const template = await postgresClient.queryOne<ProjectPipelineTemplateRecord>(
      'SELECT * FROM work_project_pipeline_templates WHERE id = $1 LIMIT 1', [id],
    );
    if (!template) return null;
    const stages = await postgresClient.query<ProjectPipelineTemplateStageRecord>(`
      SELECT * FROM work_project_pipeline_template_stages
       WHERE template_id = $1 ORDER BY position ASC, stage_key ASC
    `, [id]);
    return { ...template, stages };
  }

  static async create(input: CreateProjectPipelineTemplateInput): Promise<ProjectPipelineTemplate> {
    const key = required(input.templateKey, 'template_key');
    const name = required(input.name, 'name');
    if (input.stages.length === 0) throw new Error('A pipeline template requires at least one stage.');
    const keys = input.stages.map(stage => required(stage.stageKey, 'stage_key'));
    if (new Set(keys).size !== keys.length) throw new Error('Pipeline template stage keys must be unique.');
    const positions = input.stages.map(stage => stage.position);
    if (new Set(positions).size !== positions.length) throw new Error('Pipeline template stage positions must be unique.');

    const id = `pipeline-template-${ randomUUID() }`;
    await postgresClient.transaction(async(client) => {
      await client.query(`
        INSERT INTO work_project_pipeline_templates
          (id, template_key, name, description, system, locked, enabled, created_by)
        VALUES ($1,$2,$3,$4,false,false,true,$5)
      `, [id, key, name, input.description ?? '', input.actor ?? 'sulla']);
      for (const stage of input.stages) {
        await client.query(`
          INSERT INTO work_project_pipeline_template_stages (
            id, template_id, stage_key, display_name, description, position,
            semantic_role, bundled_workflow_id, entry_policy, wip_limit
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
        `, [`pipeline-template-stage-${ randomUUID() }`, id, stage.stageKey.trim(),
          required(stage.displayName, 'display_name'), stage.description ?? '', stage.position,
          stage.semanticRole ?? null, stage.workflowId ?? null,
          JSON.stringify(stage.entryPolicy ?? {}), stage.wipLimit ?? null]);
      }
    });
    return (await WorkProjectPipelineTemplateModel.get(id))!;
  }

  static async archive(id: string, actor = 'sulla'): Promise<ProjectPipelineTemplateRecord | null> {
    const current = await postgresClient.queryOne<ProjectPipelineTemplateRecord>(
      'SELECT * FROM work_project_pipeline_templates WHERE id = $1 LIMIT 1', [id],
    );
    if (!current) return null;
    if (current.locked || current.system) throw new Error(`Core pipeline template ${ id } cannot be archived.`);
    return postgresClient.queryOne<ProjectPipelineTemplateRecord>(`
      UPDATE work_project_pipeline_templates
         SET enabled = false, archived_at = now(), updated_at = now(), updated_by = $2
       WHERE id = $1 RETURNING *
    `, [id, actor]);
  }

  static async applyToProject(projectId: string, templateId = CORE_PROJECT_PIPELINE_TEMPLATE_ID, actor = 'sulla'):
  Promise<ProjectPipelineTemplate> {
    const template = await WorkProjectPipelineTemplateModel.get(templateId);
    if (!template || !template.enabled || template.archived_at) throw new Error(`Active pipeline template not found: ${ templateId }`);

    await postgresClient.transaction(async(client) => {
      const project = (await client.query<{ id: string }>(
        'SELECT id FROM work_projects WHERE id = $1 AND archived = false FOR UPDATE', [projectId],
      )).rows[0];
      if (!project) throw new Error(`Project not found: ${ projectId }`);
      const taskCount = Number((await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM work_tasks WHERE project_id = $1 AND archived = false', [projectId],
      )).rows[0]?.count ?? '0');
      if (taskCount > 0) throw new Error('A pipeline template can only be applied before a project has active tasks.');

      await client.query(`
        UPDATE work_lane_definitions
           SET reset_at = now(), enabled = false, updated_at = now(), updated_by = $2
         WHERE scope = 'project' AND project_id = $1 AND reset_at IS NULL
      `, [projectId, actor]);
      await client.query(`
        UPDATE work_lane_workflow_bindings
           SET active = false, archived = true, archived_at = now(), updated_at = now(), updated_by = $2
         WHERE scope = 'project' AND project_id = $1 AND active = true AND archived = false
      `, [projectId, actor]);

      for (const stage of template.stages) {
        await client.query(`
          INSERT INTO work_lane_definitions (
            id, lane_key, scope, project_id, display_name, description, position,
            semantic_role, enabled, system_required, created_by
          ) VALUES ($1,$2,'project',$3,$4,$5,$6,$7,true,false,$8)
        `, [`lane-${ randomUUID() }`, stage.stage_key, projectId, stage.display_name,
          stage.description, stage.position, stage.semantic_role ?? 'manual', actor]);

        if (!stage.bundled_workflow_id) continue;
        const workflow = (await client.query<{ id: string; definition: Record<string, any> }>(`
          SELECT id, definition FROM workflows
           WHERE id = $1 AND status <> 'archive' LIMIT 1
        `, [stage.bundled_workflow_id])).rows[0];
        if (!workflow) throw new Error(`Template workflow is unavailable: ${ stage.bundled_workflow_id }`);
        const contract = (workflow.definition?.laneContract ?? workflow.definition?.metadata?.laneContract ?? {}) as LaneContract;
        if (contract.input !== 'project.lane-entry.v1' || contract.output !== 'project.lane-outcome.v1') {
          throw new Error(`Template workflow has no compatible project lane contract: ${ workflow.id }`);
        }
        await client.query(`
          INSERT INTO work_lane_workflow_bindings (
            id, profile_id, scope, project_id, lane_key, workflow_id, lane_contract, created_by
          ) VALUES ($1,'default','project',$2,$3,$4,$5::jsonb,$6)
        `, [`binding-${ randomUUID() }`, projectId, stage.stage_key, workflow.id, JSON.stringify(contract), actor]);
      }
      await client.query('UPDATE work_projects SET pipeline_template_id = $2, updated_at = now() WHERE id = $1',
        [projectId, template.id]);
    });
    return template;
  }
}
