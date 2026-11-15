// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { chipHealth, provenanceText, usedBy } from '@pkg/components/settings/sections/modelRouting/laneLogic';

const recommended = { classes: { frontier: [], standard: [], fast: [{ provider: 'codex', model: 'gpt-5.6-luna' }], coding: [], local: [] } } as any;
const providers = [
  { id: 'codex', connected: true, models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }, { id: 'gpt-6-sol', label: 'GPT-6 Sol' }] },
  { id: 'vllm', connected: true, models: [] },
] as any;

describe('every role chip says where its model came from', () => {
  // risk: the user could not tell Sulla's hard-coded models from their own choices
  it('labels built-in defaults, user choices, rules and leftovers differently', () => {
    expect(provenanceText({ recommended }, 'fast', { provider: 'codex', model: 'gpt-5.6-luna' })).toBe('Sulla default');
    expect(provenanceText({ recommended }, 'fast', { provider: 'codex', model: 'gpt-5.6-luna', chosen: true })).toBe('You chose');
    expect(provenanceText({ recommended }, 'fast', { provider: 'codex', model: 'gpt-6-sol', rule: { kind: 'contains', text: 'sol' } })).toBe('Name contains "sol"');
    expect(provenanceText({ recommended }, 'coding', { provider: 'codex', model: 'gpt-5.3-codex' })).toBe('Saved earlier');
  });
});

describe('chip health is honest about what Sulla can verify', () => {
  it('flags unlisted and never-use models, and never claims a model without a list is fine', () => {
    const state = { providers, neverUse: [{ provider: 'codex', model: 'gpt-6-sol', effort: 'any' }] };
    expect(chipHealth(state, { provider: 'codex', model: 'gpt-5.3-codex' })).toBe('unlisted');
    expect(chipHealth(state, { provider: 'codex', model: 'gpt-6-sol' })).toBe('blocked');
    expect(chipHealth(state, { provider: 'codex', model: 'gpt-5.6-luna' })).toBe('ok');
    expect(chipHealth(state, { provider: 'vllm', model: 'qwen3-coder-32b' })).toBe('unverified');
    expect(chipHealth(state, { provider: 'grok', model: 'grok-code' })).toBe('offline');
  });

  it('names who uses a role from the lists and agent settings', () => {
    const state = { agentsList: [{ provider: 'codex', class: 'coding', enabled: true }], subconsciousList: [{ provider: 'codex', class: 'coding', enabled: false }], classUsers: { coding: ['Coding Manager'] } } as any;
    expect(usedBy(state, 'coding')).toEqual(['Main agents', 'Coding Manager']);
  });
});
