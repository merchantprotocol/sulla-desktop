// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentModelConfiguration } from '@pkg/components/studio/AgentModelConfiguration';
import type { AgentModelTiers } from '@pkg/agent/languagemodels/agentModelTiers';
import type { ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';

const primary = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
const fallback = { provider: 'claude-code', model: 'sonnet', effort: 'high' };
const list = { mode: 'list' } as const;
const tiers: AgentModelTiers = {
  version: 1,
  tiers: [{ candidates: [primary, fallback], pick: 'first' }],
  allowLaunchOverride: 'never',
  crossCompanyFallback: false,
  preset: 'fast',
};
const owner = { id: 'luna-id', slug: 'luna', class: 'fast', name: 'Luna', runLocation: 'vm' };
const binding = { agentId: owner.id, revision: 3, editToken: 'opened', candidates: [primary, fallback] };
const state: ModelRoutingState = {
  workers: [owner],
  workerBindings: { luna: binding },
  providers: [],
  agentsList: [],
  subconsciousList: [],
  classes: { frontier: [], standard: [], fast: [], coding: [], local: [] },
  followProviderOrder: { frontier: false, standard: false, fast: false, coding: false, local: false },
  neverUse: [],
};
describe('existing agent editor uses its actual execution selection', () => {
  it('renders the legacy flat order as one model per tier without upgrading it on a profile save', () => {
    const editor = new AgentModelConfiguration(owner.id, owner.slug, state);
    expect(editor.choice(list)).toEqual({ mode: 'pin', ...primary });
    const shown = editor.tiers()!;
    expect(shown.tiers.map(tier => tier.candidates)).toEqual([[primary], [fallback]]);
    expect(editor.isLegacyFlat()).toBe(true);
    expect(editor.change(shown, state)).toBeUndefined();
    shown.tiers[0].candidates[0].effort = 'high';
    expect(binding.candidates[0].effort).toBe('max');
    expect(editor.change(shown, state)).toEqual({
      slug: owner.slug, agentId: owner.id, expectedRevision: 3, expectedToken: 'opened',
      modelTiers: { version: 1, crossCompanyFallback: true, allowLaunchOverride: 'listed', tiers: shown.tiers },
    });
  });

  it('opens imported groups intact and writes policies with the captured revision', () => {
    const fileOwned = { ...state, workerBindings: { luna: { ...binding, modelTiers: tiers } } };
    const editor = new AgentModelConfiguration(owner.id, owner.slug, fileOwned);
    expect(editor.tiers()).toEqual(tiers);
    expect(editor.change(editor.tiers(), fileOwned)).toBeUndefined();
    const edited = { ...editor.tiers()!, crossCompanyFallback: true };
    expect(editor.change(edited, fileOwned)).toEqual({
      slug: owner.slug, agentId: owner.id, expectedRevision: 3, expectedToken: 'opened', modelTiers: edited,
    });
  });

  it('clears only its own binding and refuses new writes to a reused slug', () => {
    const editor = new AgentModelConfiguration(owner.id, owner.slug, state);
    expect(editor.change(null, state)).toEqual({
      slug: owner.slug, agentId: owner.id, expectedRevision: 3, expectedToken: 'opened', candidates: null,
    });
    const replacement = new AgentModelConfiguration('different-id', owner.slug, state);
    expect(replacement.choice(list)).toEqual(list);
    expect(replacement.tiers()).toBeNull();
    expect(replacement.change(null, state)).toBeUndefined();
    expect(() => replacement.change(tiers, state)).toThrow('cannot use custom model tiers');
  });

  it('rejects duplicate or malformed models before the owner write', () => {
    const editor = new AgentModelConfiguration(owner.id, owner.slug, state);
    expect(() => editor.change({ version: 1, tiers: [{ candidates: [primary, primary] }] }, state)).toThrow('already appears');
    expect(() => editor.change({ version: 1, tiers: [{ candidates: [] }] }, state)).toThrow('one to ten models');
  });

  it('can set tiers for a disabled definition using its saved inheritance CAS, keeping others protected', () => {
    const disabled = { ...state, workers: [], workerBindings: {}, workerInheritance: { luna: { agentId: owner.id, revision: 8, editToken: 'returned-to-inheritance' } } };
    const editor = new AgentModelConfiguration(owner.id, owner.slug, disabled, true);
    expect(editor.change(tiers, disabled)).toEqual({
      slug: owner.slug, agentId: owner.id, expectedRevision: 8, expectedToken: 'returned-to-inheritance', modelTiers: tiers,
    });
    expect(() => new AgentModelConfiguration(owner.id, owner.slug, disabled).change(tiers, disabled)).toThrow('cannot use custom model tiers');
  });
});
