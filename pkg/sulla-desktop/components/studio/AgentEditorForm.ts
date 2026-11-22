/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
  cloneAgentEditorCapabilities,
  cloneAgentEditorRouting,
  type AgentEditorCreateRequest,
  type AgentEditorPatch,
} from '../../shared/agentEditor';

import type { AgentModelTiers } from '../../agent/languagemodels/agentModelTiers';
import type { AgentModelChoice } from '../../agent/languagemodels/modelRoutingTypes';
import type { AgentDefinitionResponse } from '../../main/agentsIpc';

export interface AgentEditorFormState {
  slug:          string;
  name:          string;
  description:   string;
  prompt:        string;
  modelSlot:     'primary' | 'secondary' | 'subconscious';
  enabled:       boolean;
  whenToCall:    string;
  whenNotToCall: string;
  send:          string;
  returns:       string;
  costTier:      'low' | 'medium' | 'high' | null;
  canCall:       string[];
  frontDoor:     boolean | null;
  allowedTools:  string[];
  skillRefs:     string[];
  routineRefs:   string[];
}

export function emptyAgentEditorForm(): AgentEditorFormState {
  return {
    slug:        '',
    name:        '',
    description: '',
    prompt:      '',
    modelSlot:   'secondary',
    enabled:     true,
    ...cloneAgentEditorRouting(undefined),
    ...cloneAgentEditorCapabilities(undefined),
  };
}

export function editorFormFromAgent(
  agent: AgentDefinitionResponse,
): AgentEditorFormState {
  return {
    slug:        agent.slug,
    name:        agent.name,
    description: agent.description ?? '',
    prompt:      agent.prompt ?? '',
    modelSlot:   agent.modelSlot ?? 'secondary',
    enabled:     agent.enabled !== false,
    ...cloneAgentEditorRouting(agent),
    ...cloneAgentEditorCapabilities(agent),
  };
}

export function editorPatchFromForm(
  form: AgentEditorFormState,
): AgentEditorPatch {
  return {
    name:          form.name,
    description:   form.description,
    prompt:        form.prompt,
    modelSlot:     form.modelSlot,
    enabled:       form.enabled,
    whenToCall:    form.whenToCall,
    whenNotToCall: form.whenNotToCall,
    send:          form.send,
    returns:       form.returns,
    costTier:      form.costTier,
    canCall:       [...form.canCall],
    frontDoor:     form.frontDoor,
    allowedTools:  [...form.allowedTools],
    skillRefs:     [...form.skillRefs],
    routineRefs:   [...form.routineRefs],
  };
}

export function editorProfileSignature(form: AgentEditorFormState): string {
  return JSON.stringify([form.slug, editorPatchFromForm(form)]);
}

export function editorCreateFromForm(
  form: AgentEditorFormState,
  modelChoice: AgentModelChoice,
  modelTiers: AgentModelTiers | null,
): AgentEditorCreateRequest {
  return {
    slug: form.slug,
    ...editorPatchFromForm(form),
    name: form.name,
    prompt: form.prompt,
    modelChoice,
    ...(modelTiers ? { modelTiers } : {}),
  };
}

export function validateEditorDraft(form: AgentEditorFormState): string | null {
  if (!form.name.trim()) return 'Name is required.';
  if (!form.slug.trim()) return 'Slug is required.';
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(form.slug.trim())) {
    return 'Slug must use lowercase letters, numbers, dots, underscores, or hyphens.';
  }

  for (const [label, values] of [
    ['team', form.canCall],
    ['tools', form.allowedTools],
    ['skills', form.skillRefs],
    ['routines', form.routineRefs],
  ] as const) {
    if (new Set(values).size !== values.length) { return `${ label } contains duplicate entries.` }
  }
  return null;
}
