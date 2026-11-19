/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
  AGENT_EDITOR_WORKER_PROVIDERS,
  cloneAgentEditorCapabilities,
  cloneAgentEditorRouting,
  cloneModelCandidates,
  type AgentEditorCreateInput,
  type AgentEditorPatch,
} from '../../shared/agentEditor';

import type { ModelCandidate } from '../../agent/languagemodels/modelRouter';
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

export function editorCreateFromForm(
  form: AgentEditorFormState,
  modelChoice: AgentModelChoice,
  fallbacks: readonly ModelCandidate[] = [],
): AgentEditorCreateInput {
  return {
    slug:           form.slug,
    ...editorPatchFromForm(form),
    modelChoice,
    // IPC structured clone keeps `effort: undefined`, which the create contract rejects; send only set fields.
    modelFallbacks: normalizedModelChain(fallbacks),
  } as AgentEditorCreateInput;
}

export function editorDraftSignature(
  form: AgentEditorFormState,
  modelChoice: AgentModelChoice | undefined,
  fallbacks: readonly ModelCandidate[],
): string {
  return JSON.stringify({
    form:        editorPatchFromForm(form),
    modelChoice: modelChoice ? { ...modelChoice } : null,
    fallbacks:   cloneModelCandidates(fallbacks),
  });
}

/** Replace only the model portion of a saved editor baseline after late routing recovery. */
export function editorSnapshotWithModel(
  savedSnapshot: string,
  modelChoice: AgentModelChoice | undefined,
  fallbacks: readonly ModelCandidate[],
): string {
  try {
    const parsed = JSON.parse(savedSnapshot) as { form?: AgentEditorFormState };
    if (parsed.form) return editorDraftSignature(parsed.form, modelChoice, fallbacks);
  } catch {
    // An older or malformed local snapshot should remain comparable as-is.
  }
  return savedSnapshot;
}

/** Replace only the profile portion of a saved editor baseline after that profile was persisted. */
export function editorSnapshotWithForm(
  savedSnapshot: string,
  form: AgentEditorFormState,
): string {
  try {
    const parsed = JSON.parse(savedSnapshot) as { modelChoice?: AgentModelChoice | null; fallbacks?: ModelCandidate[] };
    return editorDraftSignature(form, parsed.modelChoice ?? undefined, parsed.fallbacks ?? []);
  } catch {
    // A malformed baseline stays as-is, so the editor keeps reporting unsaved edits.
  }
  return savedSnapshot;
}

/**
 * The saved model a baseline records, and the exact owner chain it implies:
 * a subscription pin plus its ordered fallbacks, or null for shared/class choices.
 * Undefined when the baseline cannot be read.
 */
export function editorSnapshotSavedModel(
  savedSnapshot: string,
): { modelChoice: AgentModelChoice; chain: ModelCandidate[] | null } | undefined {
  try {
    const parsed = JSON.parse(savedSnapshot) as { modelChoice?: AgentModelChoice | null; fallbacks?: ModelCandidate[] };
    const modelChoice = parsed.modelChoice ?? { mode: 'list' as const };
    const subscriptionPin = modelChoice.mode === 'pin' && (AGENT_EDITOR_WORKER_PROVIDERS as readonly string[]).includes(modelChoice.provider);
    const chain = subscriptionPin
      ? [{ provider: modelChoice.provider, model: modelChoice.model, ...(modelChoice.effort ? { effort: modelChoice.effort } : {}) }, ...(parsed.fallbacks ?? [])]
      : null;
    return { modelChoice, chain: chain && normalizedModelChain(chain) };
  } catch {
    return undefined;
  }
}

/** Provider, model and optional effort only, in order, for exact chain comparison. */
export function normalizedModelChain(chain: readonly ModelCandidate[]): ModelCandidate[] {
  return chain.map(row => ({ provider: row.provider, model: row.model, ...(row.effort ? { effort: row.effort } : {}) }));
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
