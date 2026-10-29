// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { cliPinnedModelId } from '../ModelTierResolver';

describe('CLI bridge model pin', () => {
  it('pins the resolved light model for the fast tier, not the alias', () => {
    expect(cliPinnedModelId('claude-code', 'fast')).toBe('claude-haiku-5-5');
    expect(cliPinnedModelId('codex', 'fast')).toBe('gpt-5.6-luna');
  });

  it('pins nothing for slot aliases or the provider name, and real ids as given', () => {
    for (const model of ['primary', 'subconscious', 'balanced', 'powerful', 'claude-code', '', undefined]) {
      expect(cliPinnedModelId('claude-code', model)).toBeUndefined();
    }
    expect(cliPinnedModelId('claude-code', 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});
