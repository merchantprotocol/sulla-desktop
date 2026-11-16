// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { effectiveModelChoice, providerForModelId } from '@pkg/agent/languagemodels/threadModelChoice';

const opusWorker = { mode: 'class', class: 'frontier' } as const;

describe('a task that names a model but no provider runs on that model', () => {
  // risk: a requested "Fable" review silently ran on the agent's default (Opus),
  // so a merge rule requiring two different reviewers was satisfied by one model
  it('pins the named Claude model instead of falling back to the agent default', () => {
    expect(effectiveModelChoice({ model: 'claude-fable-5-2', agentChoice: opusWorker }))
      .toEqual({ mode: 'pin', provider: 'claude-code', model: 'claude-fable-5-2' });
  });

  it('infers the subscription provider from the model family', () => {
    expect(providerForModelId('gpt-5.6-sol')).toBe('codex');
    expect(providerForModelId('grok-4.7')).toBe('grok');
    expect(providerForModelId('claude-opus-5-5')).toBe('claude-code');
  });

  it('keeps an explicit provider and leaves slot names and unknown models to the agent setting', () => {
    expect(effectiveModelChoice({ provider: 'anthropic', model: 'claude-fable-5-2' })).toEqual({ mode: 'pin', provider: 'anthropic', model: 'claude-fable-5-2' });
    expect(effectiveModelChoice({ model: 'primary', agentChoice: opusWorker })).toEqual(opusWorker);
    expect(effectiveModelChoice({ model: 'mystery-model', agentChoice: opusWorker })).toEqual(opusWorker);
  });
});
