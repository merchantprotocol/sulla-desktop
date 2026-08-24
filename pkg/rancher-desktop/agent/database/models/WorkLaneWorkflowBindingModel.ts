import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

import type { PoolClient } from 'pg';

export type LaneBindingScope = 'epic' | 'project' | 'global' | 'core';
export type LaneResolutionSource = LaneBindingScope | 'manual' | 'none';

export interface LaneContract {
  laneKeys?:      string[];
  semanticRoles?: string[];
  input?:         string;
  output?:        string;
}

export const LANE_ENTRY_INPUT_ENVELOPE = 'project.lane-entry.v1';
export const LANE_OUTCOME_OUTPUT_ENVELOPE = 'project.lane-outcome.v1';

export interface LaneWorkflowBindingRecord {
  id:            string;
  profile_id:    string;
  scope:         LaneBindingScope;
  epic_id:       string | null;
  project_id:    string | null;
  lane_key:      string | null;
  semantic_role: string | null;
  workflow_id:   string;
  lane_contract: LaneContract;
  active:        boolean;
  archived:      boolean;
  created_by:    string | null;
  updated_by:    string | null;
  created_at:    string;
  updated_at:    string | null;
  archived_at:   string | null;
}

export interface SetLaneBindingInput {
  scope:         LaneBindingScope;
  workflowId:    string;
  laneKey?:      string;
  semanticRole?: string;
  epicId?:       string;
  projectId?:    string;
  profileId?:    string;
  actor?:        string;
}

export interface ListLaneBindingsInput {
  profileId?:       string;
  scope?:           LaneBindingScope;
  epicId?:          string;
  projectId?:       string;
  laneKey?:         string;
  semanticRole?:    string;
  includeArchived?: boolean;
}

export interface LaneBindingResolution {
  binding:          LaneWorkflowBindingRecord | null;
  workflowId:       string | null;
  source:           LaneResolutionSource;
  fallbackReason:   string | null;
  laneContract:     LaneContract;
  workflowSnapshot: Record<string, unknown>;
}

export interface LaneEntryAutomationRecord {
  id:                string;
  task_id:           string;
  generation:        number;
  previous_lane_key: string | null;
  lane_key:          string;
  binding_id:        string | null;
  workflow_id:       string | null;
  resolution_source: LaneResolutionSource;
  fallback_reason:   string | null;
  binding_snapshot:  Record<string, unknown>;
  workflow_snapshot: Record<string, unknown>;
  execution_id:      string | null;
  status:            'pending' | 'running' | 'completed' | 'failed' | 'unautomated';
  outcome:           Record<string, unknown> | null;
  actor:             string | null;
  created_at:        string;
  started_at:        string | null;
  completed_at:      string | null;
}

interface WorkflowRow {
  id:         string;
  definition: Record<string, any>;
  enabled:    boolean;
  status:     string;
  system:     boolean;
}

function cleanOptional(value?: string): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}

function workflowLaneContract(workflow: WorkflowRow): LaneContract {
  const raw = workflow.definition?.laneContract ?? workflow.definition?.metadata?.laneContract ?? {};
  return raw && typeof raw === 'object' ? raw as LaneContract : {};
}

function compatible(contract: LaneContract, laneKey: string, semanticRole: string): boolean {
  const keys = contract.laneKeys ?? [];
  const roles = contract.semanticRoles ?? [];
  return contract.input === LANE_ENTRY_INPUT_ENVELOPE &&
    contract.output === LANE_OUTCOME_OUTPUT_ENVELOPE &&
    (keys.length === 0 || keys.includes(laneKey)) &&
    (roles.length === 0 || roles.includes(semanticRole));
}

export class WorkLaneWorkflowBindingModel {
  static async list(input: ListLaneBindingsInput = {}): Promise<LaneWorkflowBindingRecord[]> {
    const conditions = ['profile_id = $1'];
    const values: unknown[] = [input.profileId?.trim() || 'default'];
    const add = (column: string, value: string | undefined) => {
      if (!value?.trim()) return;
      values.push(value.trim());
      conditions.push(`${ column } = $${ values.length }`);
    };
    add('scope', input.scope);
    add('epic_id', input.epicId);
    add('project_id', input.projectId);
    add('lane_key', input.laneKey);
    add('semantic_role', input.semanticRole);
    if (!input.includeArchived) conditions.push('active = true AND archived = false');
    return postgresClient.query<LaneWorkflowBindingRecord>(`
      SELECT * FROM work_lane_workflow_bindings
       WHERE ${ conditions.join(' AND ') }
       ORDER BY created_at DESC
    `, values);
  }

  static async set(input: SetLaneBindingInput): Promise<LaneWorkflowBindingRecord> {
    const laneKey = cleanOptional(input.laneKey);
    const semanticRole = cleanOptional(input.semanticRole);
    const epicId = cleanOptional(input.epicId);
    const projectId = cleanOptional(input.projectId);
    if (input.scope === 'epic' && (!epicId || !laneKey)) throw new Error('epicId and laneKey are required for epic bindings.');
    if (input.scope === 'project' && (!projectId || !laneKey)) throw new Error('projectId and laneKey are required for project bindings.');
    if (input.scope === 'global' && !laneKey && !semanticRole) throw new Error('laneKey or semanticRole is required for global bindings.');
    if (input.scope === 'core' && !semanticRole) throw new Error('semanticRole is required for core bindings.');

    const workflow = await WorkLaneWorkflowBindingModel.requireWorkflow(input.workflowId);
    if (input.scope === 'core' && (!workflow.system || !['system', 'core-seeder'].includes(input.actor ?? ''))) {
      throw new Error('Protected core bindings may only be installed by the core seeder with a system workflow.');
    }
    const lane = await WorkLaneWorkflowBindingModel.requireLane(input.scope, laneKey, semanticRole, epicId, projectId);
    const contract = workflowLaneContract(workflow);
    if (!compatible(contract, lane.lane_key, lane.semantic_role)) {
      throw new Error(`Workflow ${ workflow.id } is incompatible with lane ${ lane.lane_key } (${ lane.semantic_role }).`);
    }

    const profileId = input.profileId?.trim() || 'default';
    return postgresClient.transaction(async(client) => {
      await client.query(`
        UPDATE work_lane_workflow_bindings
           SET active = false, archived = true, archived_at = now(), updated_at = now(), updated_by = $1
         WHERE profile_id = $2 AND scope = $3
           AND epic_id IS NOT DISTINCT FROM $4 AND project_id IS NOT DISTINCT FROM $5
           AND lane_key IS NOT DISTINCT FROM $6 AND semantic_role IS NOT DISTINCT FROM $7
           AND active = true AND archived = false
      `, [input.actor ?? 'sulla', profileId, input.scope, epicId, projectId, laneKey, semanticRole]);
      const inserted = await client.query<LaneWorkflowBindingRecord>(`
        INSERT INTO work_lane_workflow_bindings (
          id, profile_id, scope, epic_id, project_id, lane_key, semantic_role,
          workflow_id, lane_contract, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
        RETURNING *
      `, [`binding-${ randomUUID() }`, profileId, input.scope, epicId, projectId, laneKey,
        semanticRole, workflow.id, JSON.stringify(contract), input.actor ?? 'sulla']);
      return inserted.rows[0];
    });
  }

  static async resolve(taskId: string, laneKey: string, profileId = 'default'): Promise<LaneBindingResolution> {
    const context = await postgresClient.queryOne<{
      project_id: string; epic_id: string; semantic_role: string; system_required: boolean;
    }>(`
      SELECT t.project_id, t.epic_id, lane.semantic_role, lane.system_required
        FROM work_tasks t
        JOIN LATERAL (
          SELECT semantic_role, system_required FROM work_lane_definitions
           WHERE reset_at IS NULL AND archived = false AND enabled = true AND lane_key = $2
             AND (scope = 'global_default' OR (scope = 'project' AND project_id = t.project_id))
           ORDER BY CASE WHEN scope = 'project' THEN 0 ELSE 1 END LIMIT 1
        ) lane ON true
       WHERE t.id = $1 AND t.archived = false
    `, [taskId, laneKey]);
    if (!context) throw new Error(`No active task/lane context found for ${ taskId } in ${ laneKey }.`);

    const candidates = await postgresClient.query<LaneWorkflowBindingRecord>(`
      SELECT * FROM work_lane_workflow_bindings
       WHERE profile_id = $1 AND active = true AND archived = false
         AND (
           (scope = 'epic' AND epic_id = $2 AND lane_key = $4)
           OR (scope = 'project' AND project_id = $3 AND lane_key = $4)
           OR (scope = 'global' AND (lane_key = $4 OR (lane_key IS NULL AND semantic_role = $5)))
           OR (scope = 'core' AND semantic_role = $5)
         )
       ORDER BY CASE scope WHEN 'epic' THEN 0 WHEN 'project' THEN 1 WHEN 'global' THEN 2 ELSE 3 END,
         CASE WHEN lane_key = $4 THEN 0 ELSE 1 END, created_at DESC
    `, [profileId, context.epic_id, context.project_id, laneKey, context.semantic_role]);

    let fallbackReason: string | null = null;
    for (const binding of candidates) {
      const workflow = await WorkLaneWorkflowBindingModel.getWorkflow(binding.workflow_id);
      if (!workflow || !workflow.enabled || workflow.status === 'archive') {
        fallbackReason ??= `Binding ${ binding.id } references an unavailable workflow.`;
        continue;
      }
      const contract = workflowLaneContract(workflow);
      if (!compatible(contract, laneKey, context.semantic_role)) {
        fallbackReason ??= `Binding ${ binding.id } is no longer compatible with this lane.`;
        continue;
      }
      return {
        binding,
        workflowId:       workflow.id,
        source:           binding.scope,
        fallbackReason,
        laneContract:     contract,
        workflowSnapshot: workflow.definition,
      };
    }
    const manual = context.semantic_role === 'manual' && !context.system_required;
    return {
      binding:          null,
      workflowId:       null,
      source:           manual ? 'manual' : 'none',
      fallbackReason,
      laneContract:     {},
      workflowSnapshot: {},
    };
  }

  static async remove(id: string, actor = 'sulla'): Promise<LaneWorkflowBindingRecord | null> {
    const rows = await postgresClient.query<LaneWorkflowBindingRecord>(`
      UPDATE work_lane_workflow_bindings
         SET active = false, archived = true, archived_at = now(), updated_at = now(), updated_by = $2
       WHERE id = $1 AND active = true AND archived = false AND scope <> 'core'
       RETURNING *
    `, [id, actor]);
    if (rows[0]) return rows[0];
    const existing = await postgresClient.queryOne<LaneWorkflowBindingRecord>(
      'SELECT * FROM work_lane_workflow_bindings WHERE id = $1', [id]);
    if (existing?.scope === 'core') throw new Error('Protected core bindings cannot be removed.');
    return null;
  }

  static async listLaneEntries(taskId: string): Promise<LaneEntryAutomationRecord[]> {
    return postgresClient.query<LaneEntryAutomationRecord>(`
      SELECT * FROM work_lane_entry_automations WHERE task_id = $1 ORDER BY generation DESC
    `, [taskId]);
  }

  static async markStarted(id: string, executionId: string): Promise<LaneEntryAutomationRecord | null> {
    const rows = await postgresClient.query<LaneEntryAutomationRecord>(`
      UPDATE work_lane_entry_automations
         SET execution_id = $2, status = 'running', started_at = now()
       WHERE id = $1 AND status = 'pending' AND execution_id IS NULL
       RETURNING *
    `, [id, executionId]);
    return rows[0] ?? null;
  }

  static async markOutcome(id: string, status: 'completed' | 'failed', outcome: Record<string, unknown>):
  Promise<LaneEntryAutomationRecord | null> {
    const rows = await postgresClient.query<LaneEntryAutomationRecord>(`
      UPDATE work_lane_entry_automations
         SET status = $2, outcome = $3::jsonb, completed_at = now()
       WHERE id = $1 AND status IN ('pending', 'running')
       RETURNING *
    `, [id, status, JSON.stringify(outcome)]);
    return rows[0] ?? null;
  }

  static async claimLaneEntry(taskId: string, laneKey: string, actor = 'sulla', profileId = 'default'):
  Promise<{ created: boolean; entry: LaneEntryAutomationRecord }> {
    return postgresClient.transaction(async(client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lane-entry:${ taskId }`]);
      const prior = await client.query<LaneEntryAutomationRecord>(`
        SELECT * FROM work_lane_entry_automations WHERE task_id = $1 ORDER BY generation DESC LIMIT 1
      `, [taskId]);
      if (prior.rows[0]?.lane_key === laneKey) return { created: false, entry: prior.rows[0] };

      const resolution = await WorkLaneWorkflowBindingModel.resolve(taskId, laneKey, profileId);
      const generation = (prior.rows[0]?.generation ?? 0) + 1;
      const status = resolution.workflowId ? 'pending' : 'unautomated';
      const inserted = await client.query<LaneEntryAutomationRecord>(`
        INSERT INTO work_lane_entry_automations (
          id, task_id, generation, previous_lane_key, lane_key, binding_id, workflow_id,
          resolution_source, fallback_reason, binding_snapshot, workflow_snapshot, status, actor
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
        ON CONFLICT (task_id, generation) DO NOTHING
        RETURNING *
      `, [`lane-entry-${ randomUUID() }`, taskId, generation, prior.rows[0]?.lane_key ?? null, laneKey,
        resolution.binding?.id ?? null, resolution.workflowId, resolution.source, resolution.fallbackReason,
        JSON.stringify(resolution.binding ?? {}), JSON.stringify(resolution.workflowSnapshot), status, actor]);
      if (inserted.rows[0]) return { created: true, entry: inserted.rows[0] };
      const winner = await client.query<LaneEntryAutomationRecord>(`
        SELECT * FROM work_lane_entry_automations WHERE task_id = $1 AND generation = $2
      `, [taskId, generation]);
      return { created: false, entry: winner.rows[0] };
    });
  }

  private static async getWorkflow(id: string): Promise<WorkflowRow | null> {
    return postgresClient.queryOne<WorkflowRow>('SELECT id, definition, enabled, status, system FROM workflows WHERE id = $1', [id]);
  }

  private static async requireWorkflow(id: string): Promise<WorkflowRow> {
    const workflow = await WorkLaneWorkflowBindingModel.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${ id }`);
    if (!workflow.enabled || workflow.status === 'archive') throw new Error(`Workflow is not available: ${ id }`);
    return workflow;
  }

  private static async requireLane(scope: LaneBindingScope, laneKey: string | null, semanticRole: string | null,
    epicId: string | null, projectId: string | null): Promise<{ lane_key: string; semantic_role: string }> {
    let resolvedProjectId = projectId;
    if (scope === 'epic') {
      const epic = await postgresClient.queryOne<{ project_id: string }>('SELECT project_id FROM work_epics WHERE id = $1 AND archived = false', [epicId]);
      if (!epic) throw new Error(`Epic not found: ${ epicId }`);
      resolvedProjectId = epic.project_id;
    }
    if (scope === 'project') {
      const project = await postgresClient.queryOne('SELECT id FROM work_projects WHERE id = $1 AND archived = false', [projectId]);
      if (!project) throw new Error(`Project not found: ${ projectId }`);
    }
    if (laneKey) {
      const lane = await postgresClient.queryOne<{ lane_key: string; semantic_role: string }>(`
        SELECT lane_key, semantic_role FROM work_lane_definitions
         WHERE lane_key = $1 AND reset_at IS NULL AND archived = false AND enabled = true
           AND (scope = 'global_default' OR (scope = 'project' AND project_id = $2))
         ORDER BY CASE WHEN scope = 'project' THEN 0 ELSE 1 END LIMIT 1
      `, [laneKey, resolvedProjectId]);
      if (!lane) throw new Error(`Active lane not found: ${ laneKey }`);
      return lane;
    }
    return { lane_key: `role:${ semanticRole }`, semantic_role: semanticRole! };
  }
}
