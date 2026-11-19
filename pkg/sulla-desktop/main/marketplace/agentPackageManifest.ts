// SPDX-License-Identifier: GPL-2.0-or-later
import yaml from 'yaml';

import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';

/** Normalize already-published agent packages, without rewriting their Files versions. */
export function readAgentPackage(files: Record<string, string>, slug: string): { anchor: string; manifest: Record<string, any> } {
  if (files['agent.json']) return { anchor: 'agent.json', manifest: JSON.parse(files['agent.json']) };
  const anchor = files['agent.yaml'] ? 'agent.yaml' : files['agent.yml'] ? 'agent.yml' : '';
  if (!anchor) throw new Error(`${ slug } is missing agent.json (or agent.yaml)`);
  const value = yaml.parse(files[anchor]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${ slug } has an invalid ${ anchor }`);
  if (value.apiVersion) return { anchor, manifest: value };
  if (value.slug !== slug || typeof value.name !== 'string' || !value.name.trim() || typeof value.systemPrompt !== 'string' || !value.systemPrompt.trim()) {
    throw new Error(`${ slug } requires a matching slug, name, and systemPrompt in ${ anchor }`);
  }
  const directory = Object.fromEntries(['whenToCall', 'whenNotToCall', 'send', 'returns', 'costTier', 'canCall', 'frontDoor'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  return { anchor, manifest: {
    apiVersion: 'sulla/v3', kind: 'Agent', manifestVersion: 1,
    metadata: { slug, title: value.name, description: value.description ?? '', version: value.version ?? '1.0.0' },
    spec: { prompt: value.systemPrompt, soul: value.soulContent ?? '', tools: value.allowedTools ?? [], skills: value.skillRefs ?? [],
      provider: value.provider, model: value.model, modelChoice: value.modelChoice, modelSlot: value.modelSlot,
      config: value.config ?? {}, promptFiles: {}, directory },
  } };
}

/** Return only an exact package-requested model; class/list choices stay with global routing. */
export function explicitAgentPackageModel(manifest: Record<string, any>): ModelCandidate | undefined {
  const spec = manifest.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Agent package has an invalid spec');
  const choice = spec.modelChoice;
  const candidate = choice?.mode === 'pin'
    ? { provider: choice.provider, model: choice.model, ...(choice.effort !== undefined ? { effort: choice.effort } : {}) }
    : spec.provider !== undefined || spec.model !== undefined
      ? { provider: spec.provider, model: spec.model }
      : undefined;
  if (!candidate) {
    if (choice !== undefined && !['list', 'class'].includes(choice?.mode)) throw new Error('Agent package has an unsupported model choice');
    return undefined;
  }
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
