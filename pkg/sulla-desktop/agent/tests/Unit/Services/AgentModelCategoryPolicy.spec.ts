// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { AgentModelCategoryPolicy } from '../../../languagemodels/AgentModelCategoryPolicy';
import { effectiveModelChoice } from '../../../languagemodels/threadModelChoice';

describe('AgentModelCategoryPolicy', () => {
  const policy = new AgentModelCategoryPolicy();

  it.each([
    ['coding-manager', 'claude-opus-5-5', 'frontier'],
    ['codex-sol-worker', 'gpt-5.6-sol', 'coding'],
    ['haiku-worker', 'claude-haiku-5-5', 'fast'],
    ['analyst', 'claude-sonnet-5-5', 'standard'],
  ])('converts legacy %s pins to categories', (slug, model, category) => {
    expect(policy.resolve({ slug, choice: { mode: 'pin', provider: 'any-account', model } })).toEqual({ mode: 'class', class: category });
  });

  it('retains an explicitly configured category without a provider', () => {
    expect(policy.resolve({ choice: { mode: 'class', class: 'local' } })).toEqual({ mode: 'class', class: 'local' });
  });

  it('gives every unconfigured agent a category', () => {
    expect(policy.resolve({ choice: { mode: 'list' } })).toEqual({ mode: 'class', class: 'standard' });
  });

  it('removes legacy provider and exact-model declarations from runtime config', () => {
    expect(policy.config({ provider: 'claude-code', model: 'claude-opus-5-5', modelSlot: 'primary', modelPriority: ['old'], tools: ['read'] }, { mode: 'class', class: 'frontier' }))
      .toEqual({ tools: ['read'], modelChoice: { mode: 'class', class: 'frontier' } });
  });

  it('leaves exact human chat selections above agent categories', () => {
    expect(effectiveModelChoice({
      provider: 'codex', model: 'gpt-6.1-sol',
      agentChoice: policy.resolve({ choice: { mode: 'pin', provider: 'claude-code', model: 'claude-opus-5-5' } }),
    })).toEqual({ mode: 'pin', provider: 'codex', model: 'gpt-6.1-sol' });
  });
});
