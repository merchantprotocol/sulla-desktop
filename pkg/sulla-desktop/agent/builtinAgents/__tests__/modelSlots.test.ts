// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getBuiltinAgentSpecs, renderBuiltinAgent } from '../index';

const PINNED_WORKERS = {
  'opus-worker': ['claude-code', 'claude-opus-5-5'],
  'sonnet-worker': ['claude-code', 'claude-sonnet-5'],
  'haiku-worker': ['claude-code', 'claude-haiku-5-5'],
  'codex-sol-worker': ['codex', 'gpt-5.6-sol'],
  'codex-luna-worker': ['codex', 'gpt-5.6-luna'],
} as const;

describe('built-in worker model precedence', () => {
  it('keeps named workers pinned instead of converting them to preference slots', () => {
    const specs = new Map(getBuiltinAgentSpecs().map(spec => [spec.slug, spec]));
    for (const [slug, [provider, model]] of Object.entries(PINNED_WORKERS)) {
      const rendered = renderBuiltinAgent(specs.get(slug)!);
      expect(rendered.provider).toBe(provider);
      expect(rendered.model).toBe(model);
      expect(rendered.model_slot).toBeNull();
    }
  });
});
