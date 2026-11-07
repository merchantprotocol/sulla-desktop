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

  it('starts with the explicit selection and preserves only the configured recovery order', () => {
    // risk: explicit provider preemption / unconfigured provider use
    expect(policy.candidates([codex, claude], codex)).toEqual([codex, claude]);
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

  it('retries a transient failure twice before advancing', () => {
    // risk: premature provider substitution
    const failure = classifyLLMFailure(new Transient('codex'));
    expect(policy.additionalAttempts(failure)).toBe(2);
    expect(policy.canAdvance(failure)).toBe(true);
  });

  it('never bypasses a verified authentication denial', () => {
    // risk: security boundary bypass
    const failure = classifyLLMFailure(new AuthRevoked('codex'));
    expect(policy.additionalAttempts(failure)).toBe(0);
    expect(policy.canAdvance(failure)).toBe(false);
  });
});
