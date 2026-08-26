import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

export type AgentDefinitionStatus = 'draft' | 'production' | 'archive';

export interface ModelPriorityEntry {
  provider: string;
  model:    string;
}

export interface AgentDefinition {
  id:                   string;
  slug:                 string;
  name:                 string;
  description:          string;
  system_prompt:        string;
  soul_content:         string;
  allowed_tools:        string[];
  skill_refs:           string[];
  routine_refs:         string[];
  model_priority:       ModelPriorityEntry[];
  version:              string | null;
  status:               AgentDefinitionStatus;
  enabled:              boolean;
  source_template_slug: string | null;
  content_hash:         string | null;
  created_at:           string;
  updated_at:           string;
}

export interface AgentDefinitionInput {
  slug:                string;
  name:                string;
  description?:       string;
  systemPrompt?:      string;
  soulContent?:        string;
  allowedTools?:      string[];
  skillRefs?:         string[];
  routineRefs?:       string[];
  modelPriority?:     ModelPriorityEntry[];
  version?:            string | null;
  status?:             AgentDefinitionStatus;
  enabled?:            boolean;
  sourceTemplateSlug?: string | null;
  contentHash?:        string | null;
}

export interface AgentDefinitionPatch {
  name?:               string;
  description?:        string;
  systemPrompt?:       string;
  soulContent?:         string;
  allowedTools?:       string[];
  skillRefs?:           string[];
  routineRefs?:        string[];
  modelPriority?:      ModelPriorityEntry[];
  version?:             string | null;
  status?:              AgentDefinitionStatus;
  enabled?:             boolean;
  sourceTemplateSlug?: string | null;
  contentHash?:        string | null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

function toModelPriority(value: unknown): ModelPriorityEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(entry => ({
    provider: String(entry?.provider ?? '').trim(),
    model:    String(entry?.model ?? '').trim(),
  })).filter(entry => entry.provider && entry.model);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function rowToDefinition(row: any): AgentDefinition {
  return {
    id:                   String(row.id),
    slug:                 String(row.slug),
    name:                 String(row.name),
    description:          String(row.description ?? ''),
    system_prompt:        String(row.system_prompt ?? ''),
    soul_content:         String(row.soul_content ?? ''),
    allowed_tools:        toStringArray(row.allowed_tools),
    skill_refs:           toStringArray(row.skill_refs),
    routine_refs:         toStringArray(row.routine_refs),
    model_priority:       toModelPriority(row.model_priority),
    version:              row.version == null ? null : String(row.version),
    status:               row.status as AgentDefinitionStatus,
    enabled:              row.enabled !== false,
    source_template_slug: row.source_template_slug == null ? null : String(row.source_template_slug),
    content_hash:         row.content_hash == null ? null : String(row.content_hash),
    created_at:           toIso(row.created_at),
    updated_at:           toIso(row.updated_at),
  };
}

function required(value: string, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${ field } is required.`);
  return normalized;
}

function validateModelPriority(entries: ModelPriorityEntry[] = []): ModelPriorityEntry[] {
  return entries.map(entry => ({
    provider: required(entry.provider, 'model_priority.provider'),
    model:    required(entry.model, 'model_priority.model'),
  }));
}

export class AgentDefinitionModel {
  static async get(id: string): Promise<AgentDefinition | null> {
    const row = await postgresClient.queryOne('SELECT * FROM agent_definitions WHERE id = $1 LIMIT 1', [id]);
    return row ? rowToDefinition(row) : null;
  }

  static async findBySlug(slug: string): Promise<AgentDefinition | null> {
    const row = await postgresClient.queryOne('SELECT * FROM agent_definitions WHERE slug = $1 LIMIT 1', [slug]);
    return row ? rowToDefinition(row) : null;
  }

  static async list(status?: AgentDefinitionStatus): Promise<AgentDefinition[]> {
    const rows = status
      ? await postgresClient.query('SELECT * FROM agent_definitions WHERE status = $1 ORDER BY name ASC, slug ASC', [status])
      : await postgresClient.query('SELECT * FROM agent_definitions ORDER BY name ASC, slug ASC', []);
    return rows.map(rowToDefinition);
  }

  static async create(input: AgentDefinitionInput): Promise<AgentDefinition> {
    const slug = required(input.slug, 'slug');
    const name = required(input.name, 'name');
    const row = await postgresClient.queryOne(`
      INSERT INTO agent_definitions (
        id, slug, name, description, system_prompt, soul_content,
        allowed_tools, skill_refs, routine_refs, model_priority,
        version, status, enabled, source_template_slug, content_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      `agent-${ randomUUID() }`, slug, name, input.description ?? '', input.systemPrompt ?? '', input.soulContent ?? '',
      toStringArray(input.allowedTools), toStringArray(input.skillRefs), toStringArray(input.routineRefs),
      JSON.stringify(validateModelPriority(input.modelPriority)), input.version ?? null,
      input.status ?? 'draft', input.enabled !== false, input.sourceTemplateSlug ?? null, input.contentHash ?? null,
    ]);
    if (!row) throw new Error(`Failed to create agent definition ${ slug }.`);
    return rowToDefinition(row);
  }

  static async update(id: string, patch: AgentDefinitionPatch): Promise<AgentDefinition | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown, cast = '') => {
      sets.push(`${ column } = $${ params.length + 1 }${ cast }`);
      params.push(value);
    };
    if (patch.name !== undefined) add('name', required(patch.name, 'name'));
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.systemPrompt !== undefined) add('system_prompt', patch.systemPrompt);
    if (patch.soulContent !== undefined) add('soul_content', patch.soulContent);
    if (patch.allowedTools !== undefined) add('allowed_tools', toStringArray(patch.allowedTools));
    if (patch.skillRefs !== undefined) add('skill_refs', toStringArray(patch.skillRefs));
    if (patch.routineRefs !== undefined) add('routine_refs', toStringArray(patch.routineRefs));
    if (patch.modelPriority !== undefined) add('model_priority', JSON.stringify(validateModelPriority(patch.modelPriority)), '::jsonb');
    if (patch.version !== undefined) add('version', patch.version);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.enabled !== undefined) add('enabled', patch.enabled);
    if (patch.sourceTemplateSlug !== undefined) add('source_template_slug', patch.sourceTemplateSlug);
    if (patch.contentHash !== undefined) add('content_hash', patch.contentHash);
    if (sets.length === 0) return AgentDefinitionModel.get(id);
    sets.push('updated_at = now()');
    params.push(id);
    const row = await postgresClient.queryOne(`UPDATE agent_definitions SET ${ sets.join(', ') } WHERE id = $${ params.length } RETURNING *`, params);
    return row ? rowToDefinition(row) : null;
  }

  static async setStatus(id: string, status: AgentDefinitionStatus): Promise<AgentDefinition | null> {
    return AgentDefinitionModel.update(id, { status });
  }

  static async delete(id: string): Promise<boolean> {
    const row = await postgresClient.queryOne('DELETE FROM agent_definitions WHERE id = $1 RETURNING id', [id]);
    return !!row;
  }
}
