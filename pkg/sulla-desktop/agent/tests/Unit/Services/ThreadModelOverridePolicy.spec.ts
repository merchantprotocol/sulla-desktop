// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ThreadModelOverridePolicy } from '../../../services/ThreadModelOverridePolicy';

describe('ThreadModelOverridePolicy', () => {
  const policy = new ThreadModelOverridePolicy();

  it('keeps an explicit Codex selection exact', () => {
    // risk: provider substitution
    const selected = policy.parse({ modelSelection: 'explicit', providerId: 'codex', modelId: 'gpt-6.1-sol' });
    expect(policy.apply({ provider: 'claude-code', model: 'claude-opus-5-5', runLocation: 'vm' }, selected)).toEqual({
      provider: 'codex', model: 'gpt-6.1-sol', runLocation: 'vm',
    });
  });

  it('treats Default as an affirmative reset and clears stale pins', () => {
    // risk: stale persisted selection
    const selected = policy.parse({ modelSelection: 'default', providerId: 'codex', modelId: 'gpt-6.1-sol' });
    expect(policy.apply({ provider: 'codex', model: 'gpt-6.1-sol', runLocation: 'container' }, selected)).toEqual({ runLocation: 'container' });
  });

  it('does not invent an override for legacy messages with no complete selection', () => {
    // risk: backward compatibility
    expect(policy.parse({ providerId: 'codex' })).toEqual({ mode: 'unchanged' });
  });
});
