// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { SystemPromptBuilder, type PromptBuildContext } from '../prompts/SystemPromptBuilder';

describe('SystemPromptBuilder stable section cache', () => {
  const id = '__stable_cache_contract_test__';
  afterEach(() => SystemPromptBuilder.unregister(id));

  it('keeps cached prompt bytes identical and invalidates when section inputs change', async () => {
    // risk: prompt content drift; cached prompts must be byte-identical to fresh output.
    let calls = 0;
    SystemPromptBuilder.register(id, ctx => {
      calls++;
      return { id, content: `agent=${ctx.agentId}; label=${ctx.templateVars.label}`, priority: 10, cacheStability: 'stable' };
    }, ['full']);
    const context = (label: string): PromptBuildContext => ({
      mode: 'full', agentId: 'cache-test', agentConfig: null, provider: 'openai', chatMode: 'text',
      trustLevel: 'trusted', isSubAgent: false, isHeartbeat: false, wsChannel: 'test',
      templateVars: { label }, agentSectionOverrides: new Map(), excludeSections: new Set(), basePrompt: '',
    });
    const first = await SystemPromptBuilder.build(context('same'));
    const cached = await SystemPromptBuilder.build(context('same'));
    expect(cached.text).toBe(first.text);
    expect(calls).toBe(1);
    const changed = await SystemPromptBuilder.build(context('changed'));
    expect(changed.text).not.toBe(first.text);
    expect(calls).toBe(2);
  });
});
