// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { agentPackageModels, explicitAgentPackageModel, readAgentPackage, withAgentPackageModels } from '@pkg/main/marketplace/agentPackageManifest';

describe('chat-created agent packages use the existing activation pipeline', () => {
  it('normalizes the legacy YAML that chat creates without dropping its directory and provider fields', () => {
    const result = readAgentPackage({ 'agent.yaml': `slug: grok-pr-reviewer
name: Grok PR Reviewer
provider: grok
model: grok-4.7
systemPrompt: Review only the pinned PR head.
whenToCall: Independent review
frontDoor: false
canCall: []` }, 'grok-pr-reviewer');
    expect(result.anchor).toBe('agent.yaml');
    expect(result.manifest).toMatchObject({ apiVersion: 'sulla/v3', kind: 'Agent', metadata: { slug: 'grok-pr-reviewer', title: 'Grok PR Reviewer' }, spec: { provider: 'grok', model: 'grok-4.7', prompt: 'Review only the pinned PR head.', directory: { frontDoor: false, canCall: [] } } });
  });
  it('prefers canonical JSON and preserves its model and tool configuration', () => {
    const manifest = { apiVersion: 'sulla/v3', kind: 'Agent', metadata: { slug: 'review' }, spec: { prompt: 'Review', tools: ['github'], modelChoice: { mode: 'class', class: 'frontier' } } };
    expect(readAgentPackage({ 'agent.json': JSON.stringify(manifest), 'agent.yaml': 'invalid' }, 'review')).toEqual({ anchor: 'agent.json', manifest });
  });
  it('extracts only exact pins, including effort, and rejects conflicting or partial pins', () => {
    expect(explicitAgentPackageModel({ spec: { provider: 'grok', model: 'grok-4.7' } })).toEqual({ provider: 'grok', model: 'grok-4.7' });
    expect(explicitAgentPackageModel({ spec: { modelChoice: { mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'max' } } })).toEqual({ provider: 'codex', model: 'gpt-6-luna', effort: 'max' });
    expect(explicitAgentPackageModel({ spec: { modelChoice: { mode: 'class', class: 'coding' } } })).toBeUndefined();
    expect(() => explicitAgentPackageModel({ spec: { provider: 'grok' } })).toThrow('exact provider and model');
    expect(() => explicitAgentPackageModel({ spec: { provider: 'grok', model: 'grok-4.7', modelChoice: { mode: 'pin', provider: 'codex', model: 'gpt-6-luna' } } })).toThrow('conflict');
  });
  it('refuses mismatched identities, empty prompts, arrays and missing manifests', () => {
    for (const content of ['slug: other\nname: Review\nsystemPrompt: Test', 'slug: review\nname: Review\nsystemPrompt: ""', '- item']) expect(() => readAgentPackage({ 'agent.yaml': content }, 'review')).toThrow();
    expect(() => readAgentPackage({}, 'review')).toThrow('missing agent.json');
  });
});

describe('agent package model tiers (spec.models.tiers)', () => {
  const codex = { provider: 'codex', model: 'gpt-6-luna', effort: 'high' };
  const claude = { provider: 'claude-code', model: 'claude-opus-5-5' };
  const grok = { provider: 'grok', model: 'grok-4.7' };
  const v3 = (spec: Record<string, unknown>) => ({ apiVersion: 'sulla/v3', kind: 'Agent', metadata: { slug: 'tester' }, spec: { prompt: 'Test', ...spec } });
  const tiers = [{ candidates: [codex, claude] }, { candidates: [grok] }];

  it('keeps reading a legacy pin as a flat single-model mapping, never as tiers', () => {
    expect(agentPackageModels(v3({ modelChoice: { mode: 'pin', ...codex } }))).toEqual({ kind: 'pin', candidates: [codex] });
    expect(agentPackageModels(v3({ provider: 'grok', model: 'grok-4.7' }))).toEqual({ kind: 'pin', candidates: [grok] });
    expect(agentPackageModels(v3({ modelChoice: { mode: 'class', class: 'coding' } }))).toBeUndefined();
  });

  it('reads ordered tiers with their policies and the flat order used for launch', () => {
    const declared = agentPackageModels(v3({ modelChoice: { mode: 'class', class: 'coding' }, models: { tiers, crossCompanyFallback: false, allowLaunchOverride: 'never' } }));
    expect(declared).toEqual({ kind: 'tiers', candidates: [codex, claude, grok], modelTiers: { version: 1, tiers, crossCompanyFallback: false, allowLaunchOverride: 'never' } });
    // Chat-created legacy YAML can carry the same block.
    const yaml = `slug: tester\nname: Tester\nsystemPrompt: Test\nmodels:\n  tiers:\n    - candidates:\n        - provider: grok\n          model: grok-4.7\n`;
    expect(agentPackageModels(readAgentPackage({ 'agent.yaml': yaml }, 'tester').manifest)).toMatchObject({ kind: 'tiers', candidates: [grok] });
  });

  it('accepts exactly 10 x 10 and rejects anything larger with the field that is out of bounds', () => {
    const grid = Array.from({ length: 10 }, (_, t) => ({ candidates: Array.from({ length: 10 }, (_, c) => ({ provider: 'codex', model: `m-${ t }-${ c }` })) }));
    expect(agentPackageModels(v3({ models: { tiers: grid } }))?.candidates).toHaveLength(100);
    expect(() => agentPackageModels(v3({ models: { tiers: [...grid, { candidates: [grok] }] } }))).toThrow('spec.models.tiers must list one to ten tiers');
    expect(() => agentPackageModels(v3({ models: { tiers: [{ candidates: [...grid[0].candidates, grok] }] } }))).toThrow('spec.models.tiers[0].candidates must list one to ten models');
    expect(() => agentPackageModels(v3({ models: { tiers: [] } }))).toThrow('spec.models.tiers must list one to ten tiers');
    expect(() => agentPackageModels(v3({ models: { tiers: [{ candidates: [] }] } }))).toThrow('spec.models.tiers[0].candidates');
  });

  it('rejects malformed schema with a field-specific error', () => {
    const bad = (models: unknown) => () => agentPackageModels(v3({ models }));
    expect(bad([grok])).toThrow('spec.models must be an object');
    expect(bad({ tiers, extra: true })).toThrow('spec.models.extra is not a supported');
    expect(bad({ version: 2, tiers })).toThrow('spec.models.version must be 1');
    expect(bad({ tiers: [grok] })).toThrow('spec.models.tiers[0].provider is not a supported');
    expect(bad({ tiers: [{ candidates: [{ ...grok, accountId: 'oauth' }] }] })).toThrow('spec.models.tiers[0].candidates[0].accountId is not a supported');
    expect(bad({ tiers: [{ candidates: [{ provider: 'grok' }] }] })).toThrow('spec.models: Tier 1, model 1: choose a valid provider, model and effort.');
    expect(bad({ tiers: [{ candidates: [{ ...grok, effort: 'MAX!' }] }] })).toThrow('Tier 1, model 1');
    expect(bad({ tiers: [{ candidates: [grok] }, { candidates: [grok] }] })).toThrow('spec.models: Tier 2, model 1: this provider, model and effort already appears');
    expect(bad({ tiers, allowLaunchOverride: 'sometimes' })).toThrow('spec.models: Invalid launch override policy.');
  });

  it('rejects a legacy pin that contradicts tiers and names the conflicting field, but allows a matching one', () => {
    expect(() => agentPackageModels(v3({ modelChoice: { mode: 'pin', ...grok }, models: { tiers } }))).toThrow('spec.modelChoice (grok/grok-4.7) conflicts with spec.models.tiers[0].candidates[0] (codex/gpt-6-luna (high))');
    expect(() => agentPackageModels(v3({ provider: 'claude-code', model: 'claude-opus-5-5', models: { tiers } }))).toThrow('spec.provider/spec.model (claude-code/claude-opus-5-5) conflicts');
    // Effort is part of the identity: the same model at another effort is a contradiction.
    expect(() => agentPackageModels(v3({ modelChoice: { mode: 'pin', ...codex, effort: 'low' }, models: { tiers } }))).toThrow('conflicts');
    expect(agentPackageModels(v3({ modelChoice: { mode: 'pin', ...codex }, models: { tiers } }))).toMatchObject({ kind: 'tiers' });
  });

  it('round-trips an installation mapping through an exported file without its subscription accounts', () => {
    const exported = v3({ modelChoice: { mode: 'class', class: 'coding' }, config: { modelChoice: { mode: 'class', class: 'coding' } } });
    const tiered = { candidates: [codex, claude, grok], connections: { codex: 'acct-1' }, modelTiers: { version: 1 as const, tiers, crossCompanyFallback: true, allowLaunchOverride: 'listed' as const } };
    const withTiers = withAgentPackageModels(exported, tiered);
    expect(JSON.stringify(withTiers)).not.toContain('acct-1');
    expect(withTiers.spec.modelChoice).toEqual({ mode: 'pin', ...codex });
    expect(agentPackageModels(JSON.parse(JSON.stringify(withTiers)))).toEqual({ kind: 'tiers', candidates: tiered.candidates, modelTiers: tiered.modelTiers });

    const legacy = withAgentPackageModels(exported, { candidates: [grok] });
    expect(legacy.spec).not.toHaveProperty('models');
    expect(agentPackageModels(legacy)).toEqual({ kind: 'pin', candidates: [grok] });
    expect(withAgentPackageModels(exported, undefined)).toBe(exported);
  });
});
