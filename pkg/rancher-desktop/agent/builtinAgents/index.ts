/**
 * Built-in agent catalog — the agents that ship with Sulla Desktop.
 *
 * builtin-agents.json is compiled into the app. It is NOT read at runtime to
 * build prompts: seedBuiltinAgents copies it into agent_definitions at boot,
 * and the database stays the only source of truth for agent prompts.
 *
 * Adding a built-in agent is a single edit: append one object to the
 * "agents" array in builtin-agents.json.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';

import bundle from './builtin-agents.json';

import type { AgentCostTier, AgentDefinition, ModelPriorityEntry } from '../database/models/AgentDefinitionModel';

export interface BuiltinAgentCard {
  whenToCall:    string;
  whenNotToCall: string;
  send:          string;
  returns:       string;
  costTier:      AgentCostTier | null;
  canCall:       string[];
}

/** One entry of builtin-agents.json. */
export interface BuiltinAgentSpec {
  slug:              string;
  name:              string;
  description:       string;
  provider:          string | null;
  model:             string | null;
  card:              BuiltinAgentCard;
  tools?:            string[];
  skills?:           string[];
  routines?:         string[];
  modelPriority?:    ModelPriorityEntry[];
  config?:           Record<string, unknown>;
  /** Extra prompt .md files beyond soul.md / goals.md / prompt.md. */
  extraPromptFiles?: Record<string, string>;
  soul?:             string;
  goals?:            string;
  prompt:            string;
}

/**
 * The content the seeder owns on a built-in row, shaped like the DB columns.
 * Status and enabled are deliberately absent: those are the human's choice.
 */
export interface BuiltinManagedContent {
  name:             string;
  description:      string;
  system_prompt:    string;
  prompt_content:   string;
  soul_content:     string;
  goals_content:    string;
  prompt_files:     Record<string, string>;
  allowed_tools:    string[];
  skill_refs:       string[];
  routine_refs:     string[];
  model_priority:   ModelPriorityEntry[];
  provider:         string | null;
  model:            string | null;
  config:           Record<string, unknown>;
  when_to_call:     string;
  when_not_to_call: string;
  send:             string;
  returns:          string;
  cost_tier:        AgentCostTier | null;
  can_call:         string[];
}

export const BUILTIN_HOME_TOKEN = '{{USER_HOME}}';

export const BUILTIN_CARD_FIELDS = ['when_to_call', 'when_not_to_call', 'send', 'returns', 'cost_tier', 'can_call'] as const;

const MANAGED_FIELDS: (keyof BuiltinManagedContent)[] = [
  'name', 'description', 'system_prompt', 'prompt_content', 'soul_content', 'goals_content', 'prompt_files',
  'allowed_tools', 'skill_refs', 'routine_refs', 'model_priority', 'provider', 'model', 'config',
  ...BUILTIN_CARD_FIELDS,
];

export function getBuiltinAgentSpecs(): BuiltinAgentSpec[] {
  return (bundle as { agents: BuiltinAgentSpec[] }).agents;
}

function renderTokens<T>(value: T, home: string): T {
  if (typeof value === 'string') return value.split(BUILTIN_HOME_TOKEN).join(home) as T;
  if (Array.isArray(value)) return value.map(item => renderTokens(item, home)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTokens(item, home)])) as T;
  }
  return value;
}

/** Render a bundle entry into the exact column values the seeder writes. */
export function renderBuiltinAgent(spec: BuiltinAgentSpec, home = os.homedir()): BuiltinManagedContent {
  const s = renderTokens(spec, home);
  const promptFiles: Record<string, string> = { ...(s.extraPromptFiles ?? {}) };
  if (s.soul) promptFiles['soul.md'] = s.soul;
  if (s.goals) promptFiles['goals.md'] = s.goals;
  if (s.prompt) promptFiles['prompt.md'] = s.prompt;
  return {
    name:             s.name,
    description:      s.description ?? '',
    system_prompt:    s.prompt ?? '',
    prompt_content:   s.prompt ?? '',
    soul_content:     s.soul ?? '',
    goals_content:    s.goals ?? '',
    prompt_files:     promptFiles,
    allowed_tools:    s.tools ?? [],
    skill_refs:       s.skills ?? [],
    routine_refs:     s.routines ?? [],
    model_priority:   s.modelPriority ?? [],
    provider:         s.provider ?? null,
    model:            s.model ?? null,
    config:           s.config ?? {},
    when_to_call:     s.card?.whenToCall ?? '',
    when_not_to_call: s.card?.whenNotToCall ?? '',
    send:             s.card?.send ?? '',
    returns:          s.card?.returns ?? '',
    cost_tier:        s.card?.costTier ?? null,
    can_call:         s.card?.canCall ?? [],
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${ value.map(canonicalJson).join(',') }]`;
  if (value && typeof value === 'object') {
    return `{${ Object.keys(value).sort().map(key => `${ JSON.stringify(key) }:${ canonicalJson((value as any)[key]) }`).join(',') }}`;
  }
  return JSON.stringify(value ?? null);
}

/** Stable hash of the managed content of a rendered spec or a live DB row. */
export function hashManagedContent(content: BuiltinManagedContent | AgentDefinition): string {
  const picked: Record<string, unknown> = {};
  for (const field of MANAGED_FIELDS) {
    const value = (content as any)[field];
    picked[field] = field === 'provider' || field === 'model' || field === 'cost_tier' ? (value || null) : value;
  }
  return `sha256:${ createHash('sha256').update(canonicalJson(picked)).digest('hex') }`;
}
