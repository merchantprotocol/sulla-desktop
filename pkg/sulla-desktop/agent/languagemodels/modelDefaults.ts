// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Defaults for new chats and the heartbeat (Preferences → AI models → Defaults). Stored in the
 * `modelDefaults` setting. The old `heartbeatProvider` / `heartbeatModelId` settings are migrated on the
 * first read and left in place, so anything that still reads them keeps working.
 */

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { agentDefinitionService } from '../services/AgentDefinitionService';
import { resolveRoutableAgent, SULLA_ROUTE_AGENT_ID, DEFAULT_ROUTE_GRAPH_AGENT_ID, type RoutableAgent } from '../services/ChatAgentRouting';
import { isKnownProvider } from './modelRouter';
import { isAgentModelChoice } from './threadModelChoice';
import { MODEL_DEFAULT_KEYS, type DefaultAgentOption, type ModelDefaultChoice, type ModelDefaults, type ModelDefaultsState } from './modelDefaultsTypes';
import type { AgentModelChoice } from './modelRoutingTypes';

export const MODEL_DEFAULTS_SETTING = 'modelDefaults';
export const HEARTBEAT_AGENT_ID = 'heartbeat';

const SULLA_WHEN_TO_CALL = 'Your everyday assistant: answers directly and hands work to the right specialist';
/** Legacy heartbeatModelId tier names → model classes. */
const LEGACY_TIERS: Record<string, AgentModelChoice> = {
  fast:     { mode: 'class', class: 'fast' },
  balanced: { mode: 'class', class: 'standard' },
  powerful: { mode: 'class', class: 'frontier' },
};

/** Shape check only (no lookups): a saved value that fails it is replaced by the default. */
export function isModelDefaultChoice(value: unknown): value is ModelDefaultChoice {
  const v = value as Record<string, unknown> | null | undefined;
  if (v?.kind === 'agent') return typeof v.agentId === 'string' && !!v.agentId.trim();
  return v?.kind === 'model' && isAgentModelChoice(v.choice);
}

/**
 * The heartbeat default implied by the old Heartbeat model settings, or null when they were left on
 * "default" (use the main model). Tier names become a class; an exact model id becomes a pin; a provider
 * with no model used the legacy default tier, Fast.
 */
export function legacyHeartbeatDefault(provider: unknown, model: unknown): ModelDefaultChoice | null {
  const p = typeof provider === 'string' ? provider.trim() : '';
  const m = typeof model === 'string' ? model.trim() : '';
  if (!p || p === 'default' || !isKnownProvider(p)) return null;
  if (!m || m === 'default' || m === p) return { kind: 'model', choice: { ...LEGACY_TIERS.fast } };
  if (LEGACY_TIERS[m]) return { kind: 'model', choice: { ...LEGACY_TIERS[m] } };
  return { kind: 'model', choice: { mode: 'pin', provider: p, model: m } };
}

/** Shipped defaults: Sulla answers new chats; the Heartbeat agent runs the heartbeat (Sulla if it's missing or off). */
export async function shippedModelDefaults(): Promise<ModelDefaults> {
  const heartbeat = await resolveRoutableAgent(HEARTBEAT_AGENT_ID).catch(() => null);
  return {
    chat:      { kind: 'agent', agentId: SULLA_ROUTE_AGENT_ID },
    heartbeat: { kind: 'agent', agentId: heartbeat ? HEARTBEAT_AGENT_ID : SULLA_ROUTE_AGENT_ID },
  };
}

export async function getModelDefaults(): Promise<ModelDefaults> {
  const saved = await SullaSettingsModel.get(MODEL_DEFAULTS_SETTING, null) as Partial<ModelDefaults> | null;
  if (saved && isModelDefaultChoice(saved.chat) && isModelDefaultChoice(saved.heartbeat)) return { chat: saved.chat, heartbeat: saved.heartbeat };

  // First read (or a damaged value): start from the shipped defaults, keep any valid saved row, and carry
  // over the old heartbeat model settings.
  const next = await shippedModelDefaults();
  const legacy = legacyHeartbeatDefault(
    await SullaSettingsModel.get('heartbeatProvider', 'default'),
    await SullaSettingsModel.get('heartbeatModelId', ''),
  );
  if (legacy) next.heartbeat = legacy;
  for (const key of MODEL_DEFAULT_KEYS) if (isModelDefaultChoice(saved?.[key])) next[key] = saved![key]!;
  await SullaSettingsModel.set(MODEL_DEFAULTS_SETTING, next, 'json');
  return next;
}

/** Full validation for a value the human picked: the agent must exist and be enabled; a pin needs a known provider. */
export async function validateModelDefault(value: unknown): Promise<ModelDefaultChoice> {
  if (!isModelDefaultChoice(value)) throw new Error('Invalid model default');
  if (value.kind === 'agent') {
    const agentId = value.agentId.trim();
    if (!await resolveRoutableAgent(agentId)) throw new Error('Default agent must exist and be enabled');
    return { kind: 'agent', agentId };
  }
  const choice = value.choice;
  if (choice.mode === 'pin') {
    if (!isKnownProvider(choice.provider)) throw new Error(`Unknown model provider: ${ choice.provider }`);
    return { kind: 'model', choice: { mode: 'pin', provider: choice.provider, model: choice.model.trim() } };
  }
  return { kind: 'model', choice: choice.mode === 'class' ? { mode: 'class', class: choice.class } : { mode: 'list' } };
}

export async function setModelDefaults(patch: Partial<ModelDefaults>): Promise<ModelDefaults> {
  const current = await getModelDefaults();
  const next: ModelDefaults = { ...current };
  for (const key of MODEL_DEFAULT_KEYS) if (patch?.[key] !== undefined) next[key] = await validateModelDefault(patch[key]);
  await SullaSettingsModel.set(MODEL_DEFAULTS_SETTING, next, 'json');
  return next;
}

export async function resetModelDefaults(): Promise<ModelDefaults> {
  const value = await shippedModelDefaults();
  await SullaSettingsModel.set(MODEL_DEFAULTS_SETTING, value, 'json');
  return value;
}

function firstClause(text: string): string { return text.split(/;\s*/)[0].trim() }

/** Enabled agents for the dropdown: Sulla first, then the Agent Directory. */
export async function enabledDefaultAgents(): Promise<DefaultAgentOption[]> {
  const definitions = await agentDefinitionService.list().catch(() => []);
  const rest = definitions
    .filter(a => a.enabled && a.status !== 'archive' && a.slug !== SULLA_ROUTE_AGENT_ID && a.slug !== DEFAULT_ROUTE_GRAPH_AGENT_ID)
    .map(a => ({
      slug:        a.slug,
      name:        a.name || a.slug,
      whenToCall:  firstClause(a.when_to_call || a.description || ''),
      modelChoice: a.model_choice ?? (a.provider && a.model ? { mode: 'pin' as const, provider: a.provider, model: a.model } : { mode: 'list' as const }),
    }));
  return [{ slug: SULLA_ROUTE_AGENT_ID, name: 'Sulla', whenToCall: SULLA_WHEN_TO_CALL, modelChoice: { mode: 'list' } }, ...rest];
}

export async function modelDefaultsState(): Promise<ModelDefaultsState> {
  const [defaults, recommended, agents] = await Promise.all([getModelDefaults(), shippedModelDefaults(), enabledDefaultAgents()]);
  return { defaults, recommended, agents };
}

export interface ResolvedDefault {
  /** The agent that runs: the chosen agent, or Sulla for a model default or a chosen agent that is gone or off. */
  agent:        RoutableAgent;
  /** Set only for a model default: stored on the thread so BaseNode routes Sulla on it. */
  modelChoice?: AgentModelChoice;
  /** True when the chosen agent is missing or turned off, so Sulla stands in. */
  fellBack:     boolean;
}

export async function resolveDefaultChoice(value: ModelDefaultChoice): Promise<ResolvedDefault> {
  const sulla = (await resolveRoutableAgent(SULLA_ROUTE_AGENT_ID))!;
  if (value.kind === 'model') return { agent: sulla, modelChoice: value.choice, fellBack: false };
  const agent = await resolveRoutableAgent(value.agentId).catch(() => null);
  return { agent: agent ?? sulla, fellBack: !agent };
}
