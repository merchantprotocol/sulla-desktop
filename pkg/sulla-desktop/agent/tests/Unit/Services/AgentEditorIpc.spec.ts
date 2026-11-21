/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import {
  AgentEditorValidationError,
  validateAgentDefinitionId,
  validateAgentEditorCreateInput,
  validateAgentEditorPatch,
} from '../../../../main/agentEditorContract';

const complete = {
  slug:        'qa-reviewer',
  name:        'QA reviewer',
  description: 'Reviews a saved artifact.',
  prompt:      'Use the saved artifact and return findings.',
  modelSlot:   'secondary',
  modelChoice: {
    mode:     'pin',
    provider: 'grok',
    model:    'grok-code-fast-1',
    effort:   'high',
  },
  modelFallbacks: [
    { provider: 'codex', model: 'fallback-model', effort: 'low' },
  ],
  enabled:       false,
  whenToCall:    'When a saved artifact needs review.',
  whenNotToCall: 'When no artifact exists.',
  send:          'Artifact identity and acceptance criteria.',
  returns:       'A concise findings report.',
  costTier:      'medium',
  canCall:       [],
  frontDoor:     null,
  allowedTools:  ['artifact_read'],
  skillRefs:     ['missing/skill-ref'],
  routineRefs:   ['routine.review'],
};

describe('agent editor IPC contract', () => {
  it('normalizes the complete editor payload without changing empty-array defaults or unknown refs', () => {
    const result = validateAgentEditorCreateInput(complete);

    expect(result).toEqual(complete);
    expect(result.canCall).toEqual([]);
    expect(result.skillRefs).toEqual(['missing/skill-ref']);
  });

  it('rejects unsupported fields, malformed values, duplicate references, and duplicate model routes before a write', () => {
    expect(() =>
      validateAgentEditorCreateInput({ ...complete, unexpected: true }),
    ).toThrow(AgentEditorValidationError);
    expect(() =>
      validateAgentEditorCreateInput({ ...complete, canCall: ['a', 'a'] }),
    ).toThrow('duplicate');
    expect(() =>
      validateAgentEditorCreateInput({
        ...complete,
        modelChoice: { mode: 'class', class: 'not-a-class' },
      }),
    ).toThrow('modelChoice.class');
    expect(() =>
      validateAgentEditorCreateInput({
        ...complete,
        modelChoice: { mode: 'list', class: 'fast' },
      }),
    ).toThrow('unsupported field');
    expect(() =>
      validateAgentEditorCreateInput({ ...complete, allowedTools: [''] }),
    ).toThrow('non-empty strings');
    expect(() =>
      validateAgentEditorCreateInput({
        ...complete,
        modelFallbacks: [
          { provider: 'grok', model: 'grok-code-fast-1', effort: 'high' },
        ],
      }),
    ).toThrow('primary model route');
    expect(() =>
      validateAgentEditorCreateInput({
        ...complete,
        modelFallbacks: [
          { provider: 'codex', model: 'fallback-model' },
          { provider: 'codex', model: 'fallback-model' },
        ],
      }),
    ).toThrow('duplicates another fallback');
    expect(() =>
      validateAgentEditorCreateInput({
        ...complete,
        modelChoice:    { mode: 'list' },
        modelFallbacks: [{ provider: 'codex', model: 'fallback-model' }],
      }),
    ).toThrow('require a pinned model choice');
    expect(() =>
      validateAgentEditorCreateInput({
        ...complete,
        modelFallbacks: [{ provider: 'codex', model: '' }],
      }),
    ).toThrow('must not be empty');
    expect(() =>
      validateAgentEditorCreateInput({
        ...complete,
        modelFallbacks: [{ provider: 'codex', model: 'fallback-model', effort: '??' }],
      }),
    ).toThrow('modelFallbacks[0].effort');
  });

  it('keeps update fields whitelisted and carries the saved timestamp for model CAS', () => {
    const result = validateAgentEditorPatch({
      enabled:           false,
      whenToCall:        'updated',
      allowedTools:      [],
      expectedUpdatedAt: '2026-11-18T18:00:00.123Z',
    });

    expect(result).toEqual({
      patch:             { enabled: false, whenToCall: 'updated', allowedTools: [] },
      expectedUpdatedAt: '2026-11-18T18:00:00.123Z',
    });
    expect(() =>
      validateAgentEditorPatch({ slug: 'cannot-change-slug' }),
    ).toThrow('unsupported field');
    expect(validateAgentDefinitionId(' agent-id ')).toBe('agent-id');
    expect(() => validateAgentDefinitionId('')).toThrow('required');
  });
});

describe('grouped model routes on create', () => {
  const request = { slug: 'tier-test', name: 'Tier test', prompt: '', modelChoice: { mode: 'class', class: 'fast' } };
  const config = {
    version: 1,
    tiers: Array.from({ length: 10 }, (_, tier) => ({
      pick: 'first',
      candidates: Array.from({ length: 10 }, (_, row) => ({ provider: 'codex', model: `model-${ tier }-${ row }` })),
    })),
    allowLaunchOverride: 'never',
    crossCompanyFallback: false,
  };

  it('retains all ten groups and ten models per group with the selected policies', () => {
    const parsed = validateAgentEditorCreateInput({ ...request, modelTiers: config });
    expect(parsed.modelTiers).toEqual(config);
    expect(parsed.modelChoice).toEqual(request.modelChoice);
  });

  it('rejects contradictory, oversized and duplicate grouped routes before any write', () => {
    expect(() => validateAgentEditorCreateInput({ ...request, modelTiers: config, modelFallbacks: [] })).toThrow('cannot be combined');
    expect(() => validateAgentEditorCreateInput({ ...request, modelTiers: config, modelChoice: complete.modelChoice })).toThrow('cannot be combined');
    expect(() => validateAgentEditorCreateInput({ ...request, modelTiers: { ...config, tiers: [...config.tiers, config.tiers[0]] } })).toThrow('one to ten model tiers');
    expect(() => validateAgentEditorCreateInput({ ...request, modelTiers: { ...config, tiers: [{ candidates: [...config.tiers[0].candidates, { provider: 'codex', model: 'extra' }] }] } })).toThrow('one to ten models');
    expect(() => validateAgentEditorCreateInput({ ...request, modelTiers: { ...config, tiers: [config.tiers[0], config.tiers[0]] } })).toThrow('already appears');
    expect(() => validateAgentEditorPatch({ modelTiers: config })).toThrow('unsupported field');
  });
});
