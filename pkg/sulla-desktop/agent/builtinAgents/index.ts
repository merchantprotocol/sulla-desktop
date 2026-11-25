// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Built-in agent catalog — the agents that ship with Sulla Desktop.
 *
 * builtin-agents.json is compiled into the app. It is NOT read at runtime to
 * build prompts: seedBuiltinAgents copies it into agent_definitions at boot,
 * and the database stays the only source of truth for agent prompts.
 *
 * Adding a built-in agent is a single edit: append one object to the
 * "agents" array in builtin-agents.json.
 *
 * Shipped prompts are generic. Anything specific to the installing user is a
 * token rendered at seed time: {{USER_HOME}} (home directory) and
 * {{GIT_COMMIT_COMMAND}} (a commit command carrying their git identity).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import bundle from './builtin-agents.json';
import { AgentModelCategoryPolicy } from '../languagemodels/AgentModelCategoryPolicy';

import type { AgentCostTier, AgentDefinition, AgentModelSlot, ModelPriorityEntry } from '../database/models/AgentDefinitionModel';

export interface BuiltinAgentCard {
  whenToCall:    string;
  whenNotToCall: string;
  send:          string;
  returns:       string;
  costTier:      AgentCostTier | null;
  canCall:       string[];
  /**
   * This agent may be selected as the first persona for a new chat. Not managed content.
   * An explicit editor choice of null is stored as config.frontDoorChosen, which the
   * managed hash ignores, so a null-only edit still matches builtin_hash and prompt
   * upgrades continue. The seeder fills front_door only while it is unset and that
   * marker is absent.
   */
  frontDoor?:    boolean;
}

/** One entry of builtin-agents.json. */
export interface BuiltinAgentSpec {
  slug:              string;
  /** Defaults to visible for older bundles; worker bundles explicitly set false. */
  agentAwareness?:   boolean;
  name:              string;
  description:       string;
  provider:          string | null;
  model?:            string | null;
  modelSlot?:         AgentModelSlot | null;
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
  model_slot:       AgentModelSlot | null;
  config:           Record<string, unknown>;
  when_to_call:     string;
  when_not_to_call: string;
  send:             string;
  returns:          string;
  cost_tier:        AgentCostTier | null;
  can_call:         string[];
  agent_awareness:  boolean;
}

export const BUILTIN_HOME_TOKEN = '{{USER_HOME}}';
export const BUILTIN_GIT_COMMIT_TOKEN = '{{GIT_COMMIT_COMMAND}}';

export interface GitIdentity {
  name:  string;
  email: string;
}

export const BUILTIN_CARD_FIELDS = ['when_to_call', 'when_not_to_call', 'send', 'returns', 'cost_tier', 'can_call'] as const;

/** Explicit "front door not set" recorded on config. Absent from the managed hash. */
export const FRONT_DOOR_CHOSEN_KEY = 'frontDoorChosen';

/** Retired legacy manager identities. These were never bundle built-ins, so they do not belong
 * in builtin-agents.json's historical "retired" list; all registration paths must reject them. */
export const RETIRED_CODING_MANAGER_SLUGS = [
  'coding-manager-sol',
  'coding-manager-grok',
  'coding-manager-gpt',
] as const;

/** The observation-memory writer. Observation memory is removed, so it is archived on every boot. */
export const RETIRED_OBSERVATION_AGENT_SLUGS = ['observation-curator'] as const;

export function isRetiredCodingManagerSlug(slug: string): boolean {
  return (RETIRED_CODING_MANAGER_SLUGS as readonly string[]).includes(slug);
}

const MANAGED_FIELDS: (keyof BuiltinManagedContent)[] = [
  'name', 'description', 'system_prompt', 'prompt_content', 'soul_content', 'goals_content', 'prompt_files',
  'allowed_tools', 'skill_refs', 'routine_refs', 'model_priority', 'provider', 'model', 'model_slot', 'config',
  ...BUILTIN_CARD_FIELDS, 'agent_awareness',
];

export function getBuiltinAgentSpecs(): BuiltinAgentSpec[] {
  return (bundle as { agents: BuiltinAgentSpec[] }).agents;
}

/** Slugs the bundle used to ship and no longer does (see retireBuiltinAgents). */
export function getRetiredBuiltinSlugs(): string[] {
  return (bundle as { retired?: string[] }).retired ?? [];
}

/** [user] name/email from a git config file's text; later keys win, like git. */
export function parseGitUserConfig(text: string): Partial<GitIdentity> {
  const found: Partial<GitIdentity> = {};
  let inUser = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*([^\]\s"]+)[^\]]*\]/.exec(line);
    if (section) {
      inUser = section[1].toLowerCase() === 'user' && !/\s"/.test(line);
      continue;
    }
    const entry = inUser ? /^(name|email)\s*=\s*(.*)$/i.exec(line) : null;
    if (!entry) continue;
    const value = entry[2].replace(/\s[#;].*$/, '').trim().replace(/^"(.*)"$/, '$1').trim();
    if (value) found[entry[1].toLowerCase() as keyof GitIdentity] = value;
  }
  return found;
}

/**
 * The installing user's global git identity, read from their git config files
 * (no git subprocess). Empty strings when none is configured.
 */
export function readGitIdentity(home = os.homedir()): GitIdentity {
  const files = [
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config'),
    path.join(home, '.gitconfig'),
  ];
  const identity: GitIdentity = { name: '', email: '' };
  for (const file of files) {
    try {
      Object.assign(identity, parseGitUserConfig(fs.readFileSync(file, 'utf8')));
    } catch {
      // Missing or unreadable config: keep what we have.
    }
  }
  return identity;
}

/** The commit command shipped prompts tell coding workers to use. */
export function gitCommitCommand(identity: GitIdentity): string {
  // Drop shell-active characters so the rendered command is safe to paste.
  const clean = (value: string) => value.replace(/["\\`$]/g, '');
  if (!identity.name || !identity.email) return 'git commit -m "<message>"';
  return `git -c user.name="${ clean(identity.name) }" -c user.email="${ clean(identity.email) }" commit -m "<message>"`;
}

function renderTokens<T>(value: T, tokens: [string, string][]): T {
  if (typeof value === 'string') return tokens.reduce((text, [token, rendered]) => text.split(token).join(rendered), value as string) as T;
  if (Array.isArray(value)) return value.map(item => renderTokens(item, tokens)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTokens(item, tokens)])) as T;
  }
  return value;
}

/** Render a bundle entry into the exact column values the seeder writes. */
export function renderBuiltinAgent(spec: BuiltinAgentSpec, home = os.homedir(), git: GitIdentity = readGitIdentity(home)): BuiltinManagedContent {
  const s = renderTokens(spec, [[BUILTIN_HOME_TOKEN, home], [BUILTIN_GIT_COMMIT_TOKEN, gitCommitCommand(git)]]);
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
    model_slot:       s.modelSlot ?? null,
    config:           s.config ?? {},
    when_to_call:     s.card?.whenToCall ?? '',
    when_not_to_call: s.card?.whenNotToCall ?? '',
    send:             s.card?.send ?? '',
    returns:          s.card?.returns ?? '',
    cost_tier:        s.card?.costTier ?? null,
    can_call:         s.card?.canCall ?? [],
    agent_awareness:  s.agentAwareness !== false,
  };
}

/**
 * Managed fields AgentDefinitionModel never stores as written: the model category
 * policy nulls provider, model and model_slot and empties model_priority on every
 * create, update and read. The agent's model lives in model_choice/config.modelChoice
 * (and any owner worker binding), which the seeder preserves and never hashes.
 */
const POLICY_REWRITTEN_FIELDS = new Set<string>(['provider', 'model', 'model_slot', 'model_priority']);

/**
 * Current builtin_hash format: content as the definition model stores and returns it.
 * Older 'sha256:' hashes covered the raw bundle and never equal a stored row's hash,
 * so those rows are never refreshed; the seeder only re-stamps one that already
 * equals the current bundle.
 */
const MANAGED_HASH_PREFIX = 'sha256-v2:';

/** Hashes the persisted form of bundled agent content, including older format rows. */
export class BuiltinAgentHasher {
  static hashManagedContent(content: BuiltinManagedContent | AgentDefinition): string {
    return this.hashFields(content, MANAGED_FIELDS);
  }

  static hashManagedContentBeforeAgentAwareness(content: BuiltinManagedContent | AgentDefinition): string {
    return this.hashFields(content, MANAGED_FIELDS.filter(field => field !== 'agent_awareness'));
  }

  private static hashFields(content: BuiltinManagedContent | AgentDefinition, fields: readonly (keyof BuiltinManagedContent)[]): string {
    const picked: Record<string, unknown> = {};
    for (const field of fields) {
      if (POLICY_REWRITTEN_FIELDS.has(field)) continue;
      const value = (content as any)[field];
      picked[field] = field === 'config' ? this.managedConfig(value) : field === 'cost_tier' ? (value || null) : value;
    }
    return `${ MANAGED_HASH_PREFIX }${ createHash('sha256').update(this.canonicalJson(picked)).digest('hex') }`;
  }

  private static managedConfig(config: unknown): Record<string, unknown> {
    const base = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {};
    const stored = new AgentModelCategoryPolicy().config(base, { mode: 'class', class: 'standard' });
    const { modelChoice: _modelChoice, [FRONT_DOOR_CHOSEN_KEY]: _frontDoorChoice, ...rest } = stored;
    return rest;
  }

  private static canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${ value.map(item => this.canonicalJson(item)).join(',') }]`;
    if (value && typeof value === 'object') return `{${ Object.keys(value).sort().map(key => `${ JSON.stringify(key) }:${ this.canonicalJson((value as any)[key]) }`).join(',') }}`;
    return JSON.stringify(value ?? null);
  }
}
