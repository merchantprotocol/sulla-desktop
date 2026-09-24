import { describe, expect, it, jest } from '@jest/globals';

import { SystemPromptBuilder, type PromptBuildContext } from '../SystemPromptBuilder';
import { GOAL_OWNERSHIP_CONTENT } from '../sections/goalOwnership';

jest.unstable_mockModule('../../controllers/CitationExtractor', () => ({ CITATION_PROMPT: 'Citation policy' }));
jest.unstable_mockModule('../sections/observationalMemory', () => ({ buildObservationalMemorySection: () => null }));
jest.unstable_mockModule('@pkg/agent/utils/sullaPaths', () => ({ resolveSullaDocsDir: () => '/unused-docs' }));
await import('../sections');
const { getSystemPromptSectionDefault } = await import('../systemPromptSectionDefaults');

function context(overrides: Partial<PromptBuildContext> = {}): PromptBuildContext {
  return {
    mode: 'full',
    agentId: 'sulla-desktop',
    agentConfig: null,
    provider: 'openai',
    chatMode: 'text',
    trustLevel: 'trusted',
    isSubAgent: false,
    isHeartbeat: false,
    wsChannel: 'sulla-desktop',
    templateVars: {},
    agentSectionOverrides: new Map(),
    excludeSections: new Set(),
    basePrompt: '',
    ...overrides,
  };
}

describe('goal ownership in the composed system prompt', () => {
  it('uses the same enabled policy for database seeding and reset', async() => {
    const defaults = getSystemPromptSectionDefault('goal_ownership');
    expect(defaults?.enabledByDefault).toBe(true);
    expect(await defaults?.resolveContent()).toBe(GOAL_OWNERSHIP_CONTENT);
  });

  it.each(['full', 'minimal', 'local'] as const)('includes the policy once in %s mode without a DB row', async(mode) => {
    const built = await SystemPromptBuilder.build(context({ mode }));
    expect(built.text.split(GOAL_OWNERSHIP_CONTENT)).toHaveLength(2);
    expect(built.includedSections).toContain('goal_ownership');
    expect(built.assistantContextSections.map(section => section.id)).not.toContain('goal_ownership');
  });

  it('keeps base-only calls free of general execution policy', async() => {
    const built = await SystemPromptBuilder.build(context({ mode: 'none', basePrompt: 'Observe only.' }));
    expect(built.text).toBe('Observe only.');
  });

  it('survives customized or excluded soul content', async() => {
    const built = await SystemPromptBuilder.build(context({
      agentSectionOverrides: new Map([['soul', 'Custom personality']]),
      dbSections: new Map([['soul', {
        content: 'Old installed soul', priority: 20, cacheStability: 'stable', isGenerated: false,
      }]]),
    }));
    expect(built.text).toContain('Custom personality');
    expect(built.text).toContain(GOAL_OWNERSHIP_CONTENT);
    const excluded = await SystemPromptBuilder.build(context({ excludeSections: new Set(['soul']) }));
    expect(excluded.text).toContain(GOAL_OWNERSHIP_CONTENT);
  });

  it('respects explicit policy overrides and exclusions', async() => {
    const dbSections: PromptBuildContext['dbSections'] = new Map([['goal_ownership', {
      content: 'Custom ownership policy', priority: 25, cacheStability: 'stable', isGenerated: false,
    }]]);
    const db = await SystemPromptBuilder.build(context({ dbSections }));
    expect(db.text).toContain('Custom ownership policy');
    expect(db.text).not.toContain(GOAL_OWNERSHIP_CONTENT);
    const agent = await SystemPromptBuilder.build(context({
      dbSections, agentSectionOverrides: new Map([['goal_ownership', 'Scoped ownership policy']]),
    }));
    expect(agent.text).toContain('Scoped ownership policy');
    expect(agent.text).not.toContain('Custom ownership policy');
    const excluded = await SystemPromptBuilder.build(context({ dbSections, excludeSections: new Set(['goal_ownership']) }));
    expect(excluded.includedSections).not.toContain('goal_ownership');
  });

  it('includes the policy in the cached Anthropic system carrier', async() => {
    const built = await SystemPromptBuilder.build(context({ provider: 'anthropic' }));
    expect(built.anthropicSystem?.find(block => block.text.includes(GOAL_OWNERSHIP_CONTENT))?.cache_control).toBeDefined();
  });

  it('preserves the frozen Heartbeat contract and bounded subagent ownership', async() => {
    const heartbeat = await SystemPromptBuilder.build(context({ isHeartbeat: true }));
    expect(heartbeat.heartbeatInvariants?.ok).toBe(true);
    expect(heartbeat.text).toContain(GOAL_OWNERSHIP_CONTENT);
    const worker = await SystemPromptBuilder.build(context({ mode: 'minimal', isSubAgent: true }));
    expect(worker.text).toContain("do not duplicate another owner's work");
    expect(worker.text).toContain("when assigned a bounded subtask");
  });
});
