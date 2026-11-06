// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ModelRecoveryPolicy } from '../../../languagemodels/ModelRecoveryPolicy';
import { AuthRevoked, QuotaExceeded, Transient } from '../../../languagemodels/failures';
import { classifyLLMFailure } from '../../../languagemodels/providerRecovery';

describe('ModelRecoveryPolicy', () => {
  const policy = new ModelRecoveryPolicy();
  const codex = { provider: 'codex', model: 'gpt-6.1-sol' };
  const claude = { provider: 'claude-code', model: 'claude-opus-5-5' };

  it('receives no alternate-provider calls for an explicit hard pin', () => {
    // risk: explicit provider substitution
    const calls = policy.candidates([codex], codex);
    expect(calls).toEqual([codex]);
    expect(calls.filter(candidate => candidate.provider !== 'codex')).toHaveLength(0);
  });

  it('retains configured recovery candidates for Default routing', () => {
    // risk: availability regression for non-pinned chats
    expect(policy.candidates([codex, claude], codex)).toEqual([codex, claude]);
  });

  it('advances immediately on verified quota exhaustion', () => {
    // risk: wasting retries after a hard quota result
    const failure = classifyLLMFailure(new QuotaExceeded('codex'));
    expect(policy.additionalAttempts(failure)).toBe(0);
    expect(policy.canAdvance(failure)).toBe(true);
  });

  it('terminates an explicit quota failure without an alternate-provider call', () => {
    // risk: explicit provider substitution on quota
    const failure = classifyLLMFailure(new QuotaExceeded('codex'));
    const calls = policy.candidates([codex], codex);
    expect(policy.additionalAttempts(failure)).toBe(0);
    expect(calls.slice(1)).toHaveLength(0);
  });

  it('retries a transient failure twice before advancing', () => {
    // risk: premature provider substitution
    const failure = classifyLLMFailure(new Transient('codex'));
    expect(policy.additionalAttempts(failure)).toBe(2);
    expect(policy.canAdvance(failure)).toBe(true);
  });

  it('exhausts explicit transient retries without an alternate-provider call', () => {
    // risk: explicit provider substitution after retry exhaustion
    const failure = classifyLLMFailure(new Transient('codex'));
    const calls = policy.candidates([codex], codex);
    expect(policy.additionalAttempts(failure)).toBe(2);
    expect(calls.slice(1)).toHaveLength(0);
  });

  it('never bypasses a verified authentication denial', () => {
    // risk: security boundary bypass
    const failure = classifyLLMFailure(new AuthRevoked('codex'));
    expect(policy.additionalAttempts(failure)).toBe(0);
    expect(policy.canAdvance(failure)).toBe(false);
  });
});
