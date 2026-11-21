// SPDX-License-Identifier: GPL-2.0-or-later
import yaml from 'yaml';

import { candidateKey, cleanAgentModelTiers, formatModelCandidate, tierEntries, tiersFromCandidates, type AgentModelTiers } from '@pkg/agent/languagemodels/agentModelTiers';

import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import type { WorkerModelBinding } from '@pkg/agent/languagemodels/workerModelBindings';

/** Normalize already-published agent packages, without rewriting their Files versions. */
export function readAgentPackage(files: Record<string, string>, slug: string): { anchor: string; manifest: Record<string, any> } {
  if (files['agent.json']) return parsedAgentPackage('agent.json', JSON.parse(files['agent.json']));
  const anchor = files['agent.yaml'] ? 'agent.yaml' : files['agent.yml'] ? 'agent.yml' : '';
  if (!anchor) throw new Error(`${ slug } is missing agent.json (or agent.yaml)`);
  const value = yaml.parse(files[anchor]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${ slug } has an invalid ${ anchor }`);
  if (value.apiVersion) return parsedAgentPackage(anchor, value);
  if (value.slug !== slug || typeof value.name !== 'string' || !value.name.trim() || typeof value.systemPrompt !== 'string' || !value.systemPrompt.trim()) {
    throw new Error(`${ slug } requires a matching slug, name, and systemPrompt in ${ anchor }`);
  }
  const directory = Object.fromEntries(['whenToCall', 'whenNotToCall', 'send', 'returns', 'costTier', 'canCall', 'frontDoor'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  return parsedAgentPackage(anchor, {
    apiVersion: 'sulla/v3', kind: 'Agent', manifestVersion: 1,
    metadata: { slug, title: value.name, description: value.description ?? '', version: value.version ?? '1.0.0' },
    spec: { prompt: value.systemPrompt, soul: value.soulContent ?? '', tools: value.allowedTools ?? [], skills: value.skillRefs ?? [],
      provider: value.provider, model: value.model, modelChoice: value.modelChoice, modelSlot: value.modelSlot,
      ...(value.models !== undefined ? { models: value.models } : {}),
      config: value.config ?? {}, promptFiles: {}, directory },
  });
}

function parsedAgentPackage(anchor: string, manifest: Record<string, any>) {
  if (manifest?.spec?.models !== undefined) agentPackageModels(manifest);
  return { anchor, manifest };
}

/**
 * The models an agent package declares. `pin` is the legacy single exact model (flat binding, legacy
 * launch behaviour); `tiers` is `spec.models.tiers`. Undefined: the agent inherits shared routing.
 */
export type AgentPackageModels =
  | { kind: 'pin'; candidates: [ModelCandidate] }
  | { kind: 'tiers'; candidates: ModelCandidate[]; modelTiers: AgentModelTiers };

const MODELS_KEYS = new Set(['version', 'tiers', 'crossCompanyFallback', 'allowLaunchOverride', 'preset']);
const TIER_KEYS = new Set(['candidates', 'pick']);
const CANDIDATE_KEYS = new Set(['provider', 'model', 'effort']);

function unknownKey(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  const extra = Object.keys(value).find(key => !allowed.has(key));
  if (extra) throw new Error(`${ field }.${ extra } is not a supported agent model setting`);
}

/** Validate `spec.models` with errors that name the exact field. */
function packageModelTiers(models: unknown): AgentModelTiers {
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('spec.models must be an object with a tiers list');
  const value = models as Record<string, any>;
  unknownKey(value, MODELS_KEYS, 'spec.models');
  if (value.version !== undefined && value.version !== 1) throw new Error('spec.models.version must be 1');
  if (!Array.isArray(value.tiers) || !value.tiers.length || value.tiers.length > 10) throw new Error('spec.models.tiers must list one to ten tiers');
  value.tiers.forEach((tier: any, t: number) => {
    const field = `spec.models.tiers[${ t }]`;
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) throw new Error(`${ field } must be an object with candidates`);
    unknownKey(tier, TIER_KEYS, field);
    if (!Array.isArray(tier.candidates) || !tier.candidates.length || tier.candidates.length > 10) throw new Error(`${ field }.candidates must list one to ten models`);
    tier.candidates.forEach((candidate: any, c: number) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`${ field }.candidates[${ c }] must be an object with provider and model`);
      unknownKey(candidate, CANDIDATE_KEYS, `${ field }.candidates[${ c }]`);
    });
  });
  try {
    return cleanAgentModelTiers({ ...value, version: 1 });
  } catch (error) {
    throw new Error(`spec.models: ${ error instanceof Error ? error.message : String(error) }`);
  }
}

/** Every model representation in the package, reconciled; contradictory representations are rejected. */
export function agentPackageModels(manifest: Record<string, any>): AgentPackageModels | undefined {
  const pin = explicitAgentPackageModel(manifest);
  const spec = manifest.spec;
  if (spec.models === undefined) return pin ? { kind: 'pin', candidates: [pin] } : undefined;
  const modelTiers = packageModelTiers(spec.models);
  const candidates = tierEntries(modelTiers).map(entry => entry.candidate);
  // A legacy pin may accompany tiers for older readers, but only as Tier 1's first model.
  if (pin && candidateKey(pin) !== candidateKey(candidates[0])) {
    const field = spec.modelChoice?.mode === 'pin' ? 'spec.modelChoice' : 'spec.provider/spec.model';
    throw new Error(`${ field } (${ formatModelCandidate(pin) }) conflicts with spec.models.tiers[0].candidates[0] (${ formatModelCandidate(candidates[0]) }). Remove the legacy pin or make it match.`);
  }
  return { kind: 'tiers', candidates, modelTiers };
}

/**
 * Add the exact installation mapping to an exported agent manifest, without its subscription
 * accounts: a flat single-model mapping stays a legacy pin; anything else becomes `spec.models`.
 */
export function withAgentPackageModels(manifest: Record<string, any>, binding?: Pick<WorkerModelBinding, 'candidates' | 'modelTiers'>): Record<string, any> {
  if (!binding?.candidates?.length) return manifest;
  const { models: _models, provider: _provider, model: _model, ...spec } = manifest.spec ?? {};
  const first = binding.modelTiers ? tierEntries(binding.modelTiers)[0].candidate : binding.candidates[0];
  const pin = { mode: 'pin', provider: first.provider, model: first.model, ...(first.effort ? { effort: first.effort } : {}) };
  if (!binding.modelTiers && binding.candidates.length === 1) return { ...manifest, spec: { ...spec, modelChoice: pin } };
  const modelTiers = cleanAgentModelTiers(binding.modelTiers ?? tiersFromCandidates(binding.candidates));
  return { ...manifest, spec: { ...spec, modelChoice: pin, models: modelTiers } };
}

/** Return only an exact package-requested model; class/list choices stay with global routing. */
export function explicitAgentPackageModel(manifest: Record<string, any>): ModelCandidate | undefined {
  const spec = manifest.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Agent package has an invalid spec');
  const choice = spec.modelChoice;
  if (choice !== undefined && !['pin', 'list', 'class'].includes(choice?.mode)) throw new Error('spec.modelChoice.mode must be pin, list, or class');
  const candidate = choice?.mode === 'pin'
    ? { provider: choice.provider, model: choice.model, ...(choice.effort !== undefined ? { effort: choice.effort } : {}) }
    : spec.provider !== undefined || spec.model !== undefined
      ? { provider: spec.provider, model: spec.model }
      : undefined;
  if (!candidate) return undefined;
  if (typeof candidate.provider !== 'string' || !candidate.provider.trim() || typeof candidate.model !== 'string' || !candidate.model.trim()) {
    throw new Error('Agent package model pin requires an exact provider and model');
  }
  if (choice?.mode === 'pin' && ((spec.provider && spec.provider !== candidate.provider) || (spec.model && spec.model !== candidate.model))) {
    throw new Error('Agent package provider/model fields conflict with its model pin');
  }
  if (candidate.effort !== undefined && (typeof candidate.effort !== 'string' || !/^[a-z]{2,10}$/.test(candidate.effort))) {
    throw new Error('Agent package model effort is invalid');
  }
  return { provider: candidate.provider.trim(), model: candidate.model.trim(), ...(candidate.effort ? { effort: candidate.effort } : {}) };
}
