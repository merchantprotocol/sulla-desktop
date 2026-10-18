import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

export type AgentDefinitionStatus = 'draft' | 'production' | 'archive';
export type AgentSourceKind = 'local' | 'filesystem-import' | 'marketplace';
export type AgentCostTier = 'low' | 'medium' | 'high';
export type AgentRunLocation = 'vm' | 'container';

export const DEFAULT_AGENT_RUN_LOCATION: AgentRunLocation = 'container';

export const AGENT_COST_TIERS: readonly AgentCostTier[] = ['low', 'medium', 'high'];

export interface ModelPriorityEntry {
  provider: string;
  model:    string;
}

export interface AgentDefinition {
  id:                      string;
  slug:                    string;
  name:                    string;
  description:             string;
  system_prompt:           string;
  soul_content:            string;
  allowed_tools:           string[];
  skill_refs:              string[];
  routine_refs:            string[];
  model_priority:          ModelPriorityEntry[];
  version:                 string | null;
  status:                  AgentDefinitionStatus;
  enabled:                 boolean;
  source_template_slug:    string | null;
  content_hash:            string | null;
  config:                  Record<string, unknown>;
  prompt_content:          string;
  goals_content:           string;
  prompt_files:            Record<string, string>;
  provider:                string | null;
  model:                   string | null;
  source_kind:             AgentSourceKind;
  marketplace_template_id: string | null;
  marketplace_slug:        string | null;
  marketplace_version:     string | null;
  marketplace_author:      string | null;
  /** Directory card: situations where this agent is the right call. */
  when_to_call:            string;
  /** Directory card: situations where another agent fits better. */
  when_not_to_call:        string;
  /** Directory card: what a caller must put in the brief. */
  send:                    string;
  /** Directory card: what the caller gets back. */
  returns:                 string;
  cost_tier:               AgentCostTier | null;
  /** Agent slugs this agent may call. Empty means it calls no one. */
  can_call:                string[];
  /** Reflex may route a new chat straight to this agent. NULL = not set. */
  front_door:              boolean | null;
  /** Seeded from the bundled built-in catalog (agent/builtinAgents). */
  is_builtin:              boolean;
  /** Hash of the managed content the built-in seeder last wrote. */
  builtin_hash:            string | null;
  run_location:            AgentRunLocation;
  created_at:              string;
  updated_at:              string;
}

export interface AgentDefinitionInput {
  slug:                   string;
  name:                   string;
  description?:           string;
  systemPrompt?:          string;
  soulContent?:           string;
  allowedTools?:          string[];
  skillRefs?:             string[];
  routineRefs?:           string[];
  modelPriority?:         ModelPriorityEntry[];
  version?:               string | null;
  status?:                AgentDefinitionStatus;
  enabled?:               boolean;
  sourceTemplateSlug?:    string | null;
  contentHash?:           string | null;
  config?:                Record<string, unknown>;
  promptContent?:         string;
  goalsContent?:          string;
  promptFiles?:           Record<string, string>;
  provider?:              string | null;
  model?:                 string | null;
  sourceKind?:            AgentSourceKind;
  marketplaceTemplateId?: string | null;
  marketplaceSlug?:       string | null;
  marketplaceVersion?:    string | null;
  marketplaceAuthor?:     string | null;
  whenToCall?:            string;
  whenNotToCall?:         string;
  send?:                  string;
  returns?:               string;
  costTier?:              AgentCostTier | null;
  canCall?:               string[];
  frontDoor?:             boolean | null;
  isBuiltin?:             boolean;
  builtinHash?:           string | null;
  runLocation?:           AgentRunLocation;
}

export interface AgentDefinitionPatch {
  name?:                  string;
  description?:           string;
  systemPrompt?:          string;
  soulContent?:           string;
  allowedTools?:          string[];
  skillRefs?:             string[];
  routineRefs?:           string[];
  modelPriority?:         ModelPriorityEntry[];
  version?:               string | null;
  status?:                AgentDefinitionStatus;
  enabled?:               boolean;
  sourceTemplateSlug?:    string | null;
  contentHash?:           string | null;
  config?:                Record<string, unknown>;
  promptContent?:         string;
  goalsContent?:          string;
  promptFiles?:           Record<string, string>;
  provider?:              string | null;
  model?:                 string | null;
  sourceKind?:            AgentSourceKind;
  marketplaceTemplateId?: string | null;
  marketplaceSlug?:       string | null;
  marketplaceVersion?:    string | null;
  marketplaceAuthor?:     string | null;
  whenToCall?:            string;
  whenNotToCall?:         string;
  send?:                  string;
  returns?:               string;
  costTier?:              AgentCostTier | null;
  canCall?:               string[];
  frontDoor?:             boolean | null;
  isBuiltin?:             boolean;
  builtinHash?:           string | null;
  runLocation?:           AgentRunLocation;
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

function toCostTier(value: unknown): AgentCostTier | null {
  const tier = String(value ?? '').trim().toLowerCase();
  return (AGENT_COST_TIERS as readonly string[]).includes(tier) ? tier as AgentCostTier : null;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function toObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function rowToDefinition(row: any): AgentDefinition {
  return {
    id:                      String(row.id),
    slug:                    String(row.slug),
    name:                    String(row.name),
    description:             String(row.description ?? ''),
    system_prompt:           String(row.system_prompt ?? ''),
    soul_content:            String(row.soul_content ?? ''),
    allowed_tools:           toStringArray(row.allowed_tools),
    skill_refs:              toStringArray(row.skill_refs),
    routine_refs:            toStringArray(row.routine_refs),
    model_priority:          toModelPriority(row.model_priority),
    version:                 row.version == null ? null : String(row.version),
    status:                  row.status as AgentDefinitionStatus,
    enabled:                 row.enabled !== false,
    source_template_slug:    row.source_template_slug == null ? null : String(row.source_template_slug),
    content_hash:            row.content_hash == null ? null : String(row.content_hash),
    config:                  toObject(row.config),
    prompt_content:          String(row.prompt_content ?? ''),
    goals_content:           String(row.goals_content ?? ''),
    prompt_files:            toObject(row.prompt_files) as Record<string, string>,
    provider:                row.provider == null ? null : String(row.provider),
    model:                   row.model == null ? null : String(row.model),
    source_kind:             (row.source_kind ?? 'local') as AgentSourceKind,
    marketplace_template_id: row.marketplace_template_id == null ? null : String(row.marketplace_template_id),
    marketplace_slug:        row.marketplace_slug == null ? null : String(row.marketplace_slug),
    marketplace_version:     row.marketplace_version == null ? null : String(row.marketplace_version),
    marketplace_author:      row.marketplace_author == null ? null : String(row.marketplace_author),
    when_to_call:            String(row.when_to_call ?? ''),
    when_not_to_call:        String(row.when_not_to_call ?? ''),
    send:                    String(row.send ?? ''),
    returns:                 String(row.returns ?? ''),
    cost_tier:               toCostTier(row.cost_tier),
    can_call:                toStringArray(row.can_call),
    front_door:              typeof row.front_door === 'boolean' ? row.front_door : null,
    is_builtin:              row.is_builtin === true,
    builtin_hash:            row.builtin_hash == null ? null : String(row.builtin_hash),
    run_location:            row.run_location === 'vm' ? 'vm' : DEFAULT_AGENT_RUN_LOCATION,
    created_at:              toIso(row.created_at),
    updated_at:              toIso(row.updated_at),
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
        version, status, enabled, source_template_slug, content_hash,
        config, prompt_content, goals_content, prompt_files, provider, model,
        source_kind, marketplace_template_id, marketplace_slug, marketplace_version, marketplace_author,
        when_to_call, when_not_to_call, send, returns, cost_tier, can_call, is_builtin, builtin_hash, front_door, run_location
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,
        $16::jsonb,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
      RETURNING *
    `, [
      `agent-${ randomUUID() }`, slug, name, input.description ?? '', input.systemPrompt ?? '', input.soulContent ?? '',
      toStringArray(input.allowedTools), toStringArray(input.skillRefs), toStringArray(input.routineRefs),
      JSON.stringify(validateModelPriority(input.modelPriority)), input.version ?? null,
      input.status ?? 'draft', input.enabled !== false, input.sourceTemplateSlug ?? null, input.contentHash ?? null,
      JSON.stringify(input.config ?? {}), input.promptContent ?? input.systemPrompt ?? '', input.goalsContent ?? '',
      JSON.stringify(input.promptFiles ?? {}), input.provider ?? null, input.model ?? null,
      input.sourceKind ?? 'local', input.marketplaceTemplateId ?? null, input.marketplaceSlug ?? null,
      input.marketplaceVersion ?? null, input.marketplaceAuthor ?? null,
      input.whenToCall ?? '', input.whenNotToCall ?? '', input.send ?? '', input.returns ?? '',
      toCostTier(input.costTier), toStringArray(input.canCall), input.isBuiltin === true, input.builtinHash ?? null,
      typeof input.frontDoor === 'boolean' ? input.frontDoor : null,
      input.runLocation ?? DEFAULT_AGENT_RUN_LOCATION,
    ]);
    if (!row) throw new Error(`Failed to create agent definition ${ slug }.`);
    return rowToDefinition(row);
  }

  /**
   * Apply a patch. When expectedUpdatedAt is given the write only lands if the
   * row has not changed since it was read (compare-and-set on updated_at);
   * otherwise null is returned and nothing is written.
   */
  static async update(id: string, patch: AgentDefinitionPatch, expectedUpdatedAt?: string): Promise<AgentDefinition | null> {
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
    if (patch.config !== undefined) add('config', JSON.stringify(patch.config), '::jsonb');
    if (patch.promptContent !== undefined) add('prompt_content', patch.promptContent);
    if (patch.goalsContent !== undefined) add('goals_content', patch.goalsContent);
    if (patch.promptFiles !== undefined) add('prompt_files', JSON.stringify(patch.promptFiles), '::jsonb');
    if (patch.provider !== undefined) add('provider', patch.provider);
    if (patch.model !== undefined) add('model', patch.model);
    if (patch.sourceKind !== undefined) add('source_kind', patch.sourceKind);
    if (patch.marketplaceTemplateId !== undefined) add('marketplace_template_id', patch.marketplaceTemplateId);
    if (patch.marketplaceSlug !== undefined) add('marketplace_slug', patch.marketplaceSlug);
    if (patch.marketplaceVersion !== undefined) add('marketplace_version', patch.marketplaceVersion);
    if (patch.marketplaceAuthor !== undefined) add('marketplace_author', patch.marketplaceAuthor);
    if (patch.whenToCall !== undefined) add('when_to_call', patch.whenToCall);
    if (patch.whenNotToCall !== undefined) add('when_not_to_call', patch.whenNotToCall);
    if (patch.send !== undefined) add('send', patch.send);
    if (patch.returns !== undefined) add('returns', patch.returns);
    if (patch.costTier !== undefined) add('cost_tier', toCostTier(patch.costTier));
    if (patch.canCall !== undefined) add('can_call', toStringArray(patch.canCall));
    if (patch.frontDoor !== undefined) add('front_door', typeof patch.frontDoor === 'boolean' ? patch.frontDoor : null);
    if (patch.isBuiltin !== undefined) add('is_builtin', patch.isBuiltin);
    if (patch.builtinHash !== undefined) add('builtin_hash', patch.builtinHash);
    if (patch.runLocation !== undefined) add('run_location', patch.runLocation === 'container' ? 'container' : 'vm');
    if (sets.length === 0) return AgentDefinitionModel.get(id);
    sets.push("user_edited = CASE WHEN source_kind = 'marketplace' THEN true ELSE user_edited END");
    sets.push('updated_at = now()');
    params.push(id);
    let where = `id = $${ params.length }`;
    if (expectedUpdatedAt) {
      params.push(expectedUpdatedAt);
      // JS dates carry ms only; allow for the dropped microseconds.
      where += ` AND abs(extract(epoch FROM updated_at - $${ params.length }::timestamptz)) < 0.002`;
    }
    const row = await postgresClient.queryOne(`UPDATE agent_definitions SET ${ sets.join(', ') } WHERE ${ where } RETURNING *`, params);
    return row ? rowToDefinition(row) : null;
  }

  /**
   * Set front_door only while it is still unset (NULL), so a human's choice
   * always wins. Returns true when the row was filled.
   */
  static async fillFrontDoor(slug: string, frontDoor: boolean): Promise<boolean> {
    const row = await postgresClient.queryOne(
      'UPDATE agent_definitions SET front_door = $2 WHERE slug = $1 AND front_door IS NULL RETURNING id',
      [slug, frontDoor],
    );
    return !!row;
  }

  static async setStatus(id: string, status: AgentDefinitionStatus): Promise<AgentDefinition | null> {
    return AgentDefinitionModel.update(id, { status });
  }

  static async delete(id: string): Promise<boolean> {
    const row = await postgresClient.queryOne('DELETE FROM agent_definitions WHERE id = $1 RETURNING id', [id]);
    return !!row;
  }

  /** Import-once semantics: an existing DB row always wins over legacy files. */
  static async importIfMissing(input: AgentDefinitionInput): Promise<AgentDefinition> {
    const existing = await AgentDefinitionModel.findBySlug(input.slug);
    if (existing) return existing;
    return AgentDefinitionModel.create(input);
  }
}
