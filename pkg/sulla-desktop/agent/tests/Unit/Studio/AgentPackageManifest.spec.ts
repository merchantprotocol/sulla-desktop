// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { explicitAgentPackageModel, readAgentPackage } from '@pkg/main/marketplace/agentPackageManifest';

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
