// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ModelRecoveryPolicy } from '../../../languagemodels/ModelRecoveryPolicy';

describe('ModelRecoveryPolicy', () => {
  const policy = new ModelRecoveryPolicy();
  const codex = { provider: 'codex', model: 'gpt-6.1-sol' };
  const claude = { provider: 'claude-code', model: 'claude-opus-5-5' };

  it('never substitutes another provider for an explicit selection', () => {
    // risk: provider substitution after quota/auth/transient failure
    expect(policy.candidates([codex, claude], true, codex)).toEqual([codex]);
  });

  it('retains configured recovery candidates for Default routing', () => {
    // risk: availability regression for non-pinned chats
    expect(policy.candidates([codex, claude], false, codex)).toEqual([codex, claude]);
  });
});
