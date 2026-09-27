import { describe, expect, it } from '@jest/globals';

import { SystemPromptBuilder, type PromptBuildContext } from '../SystemPromptBuilder';
import { heartbeatPrompt } from '../heartbeat';
import { checkHeartbeatPromptInvariants } from '../heartbeatInvariants';
import { buildHeartbeatSection } from '../sections/heartbeat';
import { buildHeartbeatGoalSection, HEARTBEAT_GOAL_DEFAULT_CONTENT } from '../sections/heartbeatGoal';
import { getSystemPromptSectionDefault } from '../systemPromptSectionDefaults';

function ctx(overrides: Partial<PromptBuildContext> = {}): PromptBuildContext {
  return {
    mode:                  'full',
    agentId:               'heartbeat',
    agentConfig:           null,
    provider:              'openai',
    chatMode:              'text',
    trustLevel:            'trusted',
    isSubAgent:            false,
    isHeartbeat:           true,
    wsChannel:             'heartbeat',
    templateVars:          {},
    agentSectionOverrides: new Map(),
    excludeSections:       new Set(),
    basePrompt:            '',
    ...overrides,
  };
}

describe('heartbeat goal section', () => {
  it('ships a default that tells Heartbeat to derive the right north star', () => {
    expect(HEARTBEAT_GOAL_DEFAULT_CONTENT).toContain('## Heartbeat Goal — North Star');
    expect(HEARTBEAT_GOAL_DEFAULT_CONTENT).toContain('Derive the right one');
    expect(HEARTBEAT_GOAL_DEFAULT_CONTENT).toContain('measurable success metric');
    expect(HEARTBEAT_GOAL_DEFAULT_CONTENT).toContain('theirs always wins');
    // Shared default: never ship one user's goal to everyone.
    expect(HEARTBEAT_GOAL_DEFAULT_CONTENT).not.toMatch(/jonathon/i);
    expect(checkHeartbeatPromptInvariants(`${ heartbeatPrompt }\n\n${ HEARTBEAT_GOAL_DEFAULT_CONTENT }`).ok).toBe(true);
  });

  it('is seeded as an enabled, editable DB row', async() => {
    const def = getSystemPromptSectionDefault('heartbeat_goal');
    expect(def).toBeDefined();
    expect(def?.enabledByDefault).toBe(true);
    expect(def?.isGenerated).toBe(false);
    expect(def?.priority).toBe(111);
    expect(await def?.resolveContent()).toBe(HEARTBEAT_GOAL_DEFAULT_CONTENT);
  });

  it('only renders for full-mode heartbeat builds', () => {
    expect(buildHeartbeatGoalSection(ctx())?.content).toBe(HEARTBEAT_GOAL_DEFAULT_CONTENT);
    expect(buildHeartbeatGoalSection(ctx({ isHeartbeat: false }))).toBeNull();
    expect(buildHeartbeatGoalSection(ctx({ mode: 'local' }))).toBeNull();
  });

  it("applies the human's DB goal while the heartbeat contract stays frozen", async() => {
    SystemPromptBuilder.register('heartbeat', buildHeartbeatSection, ['full', 'local']);
    SystemPromptBuilder.register('heartbeat_goal', buildHeartbeatGoalSection, ['full', 'local']);
    try {
      const built = await SystemPromptBuilder.build(ctx({
        dbSections: new Map([
          ['heartbeat', { content: 'install-local replacement contract', priority: 110, cacheStability: 'stable', isGenerated: false }],
          ['heartbeat_goal', { content: '## Heartbeat Goal — North Star\n\nGrow monthly revenue.', priority: 111, cacheStability: 'stable', isGenerated: false }],
        ]),
      }));

      expect(built.text).toContain('Grow monthly revenue.');
      expect(built.text).not.toContain('Derive the right one');
      expect(built.text).toContain('# Autonomous Executive Control Plane — Sulla');
      expect(built.text).not.toContain('install-local replacement contract');
      expect(built.text.indexOf('Goal Command')).toBeLessThan(built.text.indexOf('Grow monthly revenue.'));

      const chat = await SystemPromptBuilder.build(ctx({
        isHeartbeat: false,
        dbSections:  new Map([
          ['heartbeat_goal', { content: 'Grow monthly revenue.', priority: 111, cacheStability: 'stable', isGenerated: false }],
        ]),
      }));
      expect(chat.text).not.toContain('Grow monthly revenue.');
    } finally {
      SystemPromptBuilder.unregister('heartbeat');
      SystemPromptBuilder.unregister('heartbeat_goal');
    }
  });
});
