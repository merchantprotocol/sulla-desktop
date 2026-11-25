/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type {
  AgentCostTier,
  AgentModelSlot,
} from '../agent/database/models/AgentDefinitionModel';
import type { ModelCandidate } from '../agent/languagemodels/modelRouter';
import type { AgentModelChoice } from '../agent/languagemodels/modelRoutingTypes';

export const AGENT_EDITOR_WORKER_PROVIDERS = [
  'codex',
  'claude-code',
  'grok',
] as const;

export type AgentEditorWorkerProvider =
  (typeof AGENT_EDITOR_WORKER_PROVIDERS)[number];

export interface AgentEditorRoutingFields {
  whenToCall:    string;
  whenNotToCall: string;
  send:          string;
  returns:       string;
  costTier:      AgentCostTier | null;
  canCall:       string[];
  frontDoor:     boolean | null;
}

export interface AgentEditorCapabilityFields {
  allowedTools: string[];
  skillRefs:    string[];
  routineRefs:  string[];
}

export interface AgentEditorDefinitionFields
  extends AgentEditorRoutingFields,
  AgentEditorCapabilityFields {
  name:         string;
  description:  string;
  prompt:       string;
  agentAwareness: boolean;
  modelSlot:    AgentModelSlot;
  modelChoice?: AgentModelChoice;
  enabled:      boolean;
  provider?:    string;
  runLocation?: 'vm' | 'container';
}

export interface AgentEditorCreateInput extends AgentEditorDefinitionFields {
  slug:           string;
  modelFallbacks: ModelCandidate[];
}

/** Renderer-facing request shape. Main normalizes omitted fields before writing. */
export type AgentEditorCreateRequest = Partial<AgentEditorDefinitionFields> &
  Pick<AgentEditorDefinitionFields, 'name' | 'prompt'> & {
    slug:            string;
    modelFallbacks?: ModelCandidate[];
  };

export interface AgentEditorPatch extends Partial<AgentEditorDefinitionFields> {
  expectedUpdatedAt?: string;
}

export interface AgentTryTabPayload {
  mode:           'chat';
  title:          string;
  initialAgentId: string;
}

export const DEFAULT_AGENT_EDITOR_ROUTING: AgentEditorRoutingFields = {
  whenToCall:    '',
  whenNotToCall: '',
  send:          '',
  returns:       '',
  costTier:      null,
  canCall:       [],
  frontDoor:     null,
};

export const DEFAULT_AGENT_EDITOR_CAPABILITIES: AgentEditorCapabilityFields = {
  allowedTools: [],
  skillRefs:    [],
  routineRefs:  [],
};

export function cloneStringList(
  value: readonly string[] | null | undefined,
): string[] {
  return value ? [...value] : [];
}

export function cloneAgentEditorRouting(
  value: Partial<AgentEditorRoutingFields> | null | undefined,
): AgentEditorRoutingFields {
  return {
    whenToCall: value?.whenToCall ?? DEFAULT_AGENT_EDITOR_ROUTING.whenToCall,
    whenNotToCall:
      value?.whenNotToCall ?? DEFAULT_AGENT_EDITOR_ROUTING.whenNotToCall,
    send:      value?.send ?? DEFAULT_AGENT_EDITOR_ROUTING.send,
    returns:   value?.returns ?? DEFAULT_AGENT_EDITOR_ROUTING.returns,
    costTier:  value?.costTier ?? DEFAULT_AGENT_EDITOR_ROUTING.costTier,
    canCall:   cloneStringList(value?.canCall),
    frontDoor: value?.frontDoor ?? DEFAULT_AGENT_EDITOR_ROUTING.frontDoor,
  };
}

export function cloneAgentEditorCapabilities(
  value: Partial<AgentEditorCapabilityFields> | null | undefined,
): AgentEditorCapabilityFields {
  return {
    allowedTools: cloneStringList(value?.allowedTools),
    skillRefs:    cloneStringList(value?.skillRefs),
    routineRefs:  cloneStringList(value?.routineRefs),
  };
}

export function agentEditorTeamLabel(canCall: readonly string[]): string {
  if (canCall.length === 0) return 'Default team · unrestricted';
  if (canCall.includes('*')) return 'Everyone';
  return `${ canCall.length } selected`;
}

/** Option value for the empty canCall list (existing default team, not "no one"). */
export const AGENT_EDITOR_DEFAULT_TEAM = '__default__';

/**
 * Next canCall list from a multi-select change. Kept members keep their saved
 * order and unlisted references stay unless deselected. Picking the default
 * team or the wildcard replaces the other entries; picking a member while the
 * default or wildcard is selected replaces that choice.
 */
export function nextAgentEditorTeam(
  previous: readonly string[],
  selected: readonly string[],
): string[] {
  const picked = new Set(selected);
  const wasDefault = previous.length === 0;
  if (picked.has(AGENT_EDITOR_DEFAULT_TEAM) && !wasDefault) return [];
  picked.delete(AGENT_EDITOR_DEFAULT_TEAM);
  if (picked.has('*') && !previous.includes('*')) return ['*'];
  if (previous.includes('*') && picked.size > 1) picked.delete('*');
  return [
    ...previous.filter(value => picked.has(value)),
    ...[...picked].filter(value => !previous.includes(value)),
  ];
}

/** Try opens a normal chat; chat selection and runtime routing key agents by slug. */
export function agentTryTabPayload(
  agentSlug: string,
  title: string,
): AgentTryTabPayload {
  return {
    mode:           'chat',
    title,
    initialAgentId: agentSlug,
  };
}

export function cloneModelCandidates(
  value: readonly ModelCandidate[] | null | undefined,
): ModelCandidate[] {
  return value?.map((candidate) => ({ ...candidate })) ?? [];
}
