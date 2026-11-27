// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import type { PromptBuildContext } from '../../prompts/SystemPromptBuilder';
import { buildNarrationPolicySection } from '../../prompts/sections/narrationPolicy';

describe('narration policy visibility', () => {
  const context = (mode: 'full' | 'local', isSubAgent: boolean): PromptBuildContext => ({
    mode,
    agentId: 'narration-test',
    agentConfig: null,
    provider: 'anthropic',
    chatMode: 'text',
    trustLevel: 'trusted',
    isSubAgent,
    isHeartbeat: false,
    wsChannel: 'test',
    templateVars: {},
    agentSectionOverrides: new Map(),
    excludeSections: new Set(),
    basePrompt: '',
  });

  it('shows answer-first guidance to human-facing sessions but keeps delegated sections unchanged', () => {
    // risk: latency — human-facing turns must emit a first sentence before starting quiet tool work.
    for (const mode of ['full', 'local'] as const) {
      const visible = buildNarrationPolicySection(context(mode, false));
      const delegated = buildNarrationPolicySection(context(mode, true));

      expect(visible?.content).toContain('when a human is reading');
      expect(delegated?.content).not.toContain('when a human is reading');
      expect(delegated?.content).toMatch(mode === 'local' ? /^## Narration/ : /^## Tool Result Narration/);
    }
  });
});
