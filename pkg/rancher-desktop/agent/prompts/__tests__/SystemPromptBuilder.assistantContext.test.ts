import { describe, expect, it } from '@jest/globals';

import { SystemPromptBuilder, type PromptBuildContext } from '../SystemPromptBuilder';

describe('SystemPromptBuilder assistant context routing', () => {
  it('keeps the subconscious-produced user section out of the system prompt', async() => {
    const ctx: PromptBuildContext = {
      mode:                  'full',
      agentId:               'test-agent',
      agentConfig:           null,
      provider:              'openai',
      chatMode:              'text',
      trustLevel:            'trusted',
      isSubAgent:            false,
      isHeartbeat:           false,
      wsChannel:             'test',
      templateVars:          {},
      agentSectionOverrides: new Map(),
      excludeSections:       new Set(),
      dbSections:            new Map([
        ['user', {
          content: 'dream-consolidated human identity',
          priority: 35,
          cacheStability: 'semi-stable',
          isGenerated: false,
        }],
        ['custom_policy', {
          content: 'explicit custom system policy',
          priority: 36,
          cacheStability: 'stable',
          isGenerated: false,
        }],
      ]),
      basePrompt: '',
    };

    const built = await SystemPromptBuilder.build(ctx);

    expect(built.text).not.toContain('dream-consolidated human identity');
    expect(built.includedSections).not.toContain('user');
    expect(built.assistantContextSections).toEqual([
      expect.objectContaining({ id: 'user', content: 'dream-consolidated human identity' }),
    ]);
    expect(built.text).toContain('explicit custom system policy');
    expect(built.includedSections).toContain('custom_policy');
  });

  it('routes the registered observational-memory section out of system text too', async() => {
    SystemPromptBuilder.register('observational_memory', () => ({
      id: 'observational_memory',
      content: 'top-ten recalled observations',
      priority: 37,
      cacheStability: 'semi-stable',
    }), ['full']);

    try {
      const built = await SystemPromptBuilder.build({
        mode: 'full',
        agentId: 'test-agent',
        agentConfig: null,
        provider: 'openai',
        chatMode: 'text',
        trustLevel: 'trusted',
        isSubAgent: false,
        isHeartbeat: false,
        wsChannel: 'test',
        templateVars: {},
        agentSectionOverrides: new Map(),
        excludeSections: new Set(),
        basePrompt: '',
      });

      expect(built.text).not.toContain('top-ten recalled observations');
      expect(built.includedSections).not.toContain('observational_memory');
      expect(built.assistantContextSections).toEqual([
        expect.objectContaining({ id: 'observational_memory', content: 'top-ten recalled observations' }),
      ]);
    } finally {
      SystemPromptBuilder.unregister('observational_memory');
    }
  });
});
