import { describe, expect, it } from '@jest/globals';

import { heartbeatPrompt } from '../heartbeat';
import {
  HEARTBEAT_FORBIDDEN_PHRASES,
  HEARTBEAT_REQUIRED_PHRASES,
  checkHeartbeatPromptInvariants,
} from '../heartbeatInvariants';
import { SystemPromptBuilder, type PromptBuildContext } from '../SystemPromptBuilder';

describe('checkHeartbeatPromptInvariants', () => {
  it('passes on the real continuous-operator heartbeat prompt', () => {
    const result = checkHeartbeatPromptInvariants(heartbeatPrompt);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.forbidden).toEqual([]);
  });

  it('fails when a required continuous-operator phrase is missing (stale/reverted prompt)', () => {
    const stripped = heartbeatPrompt.split('Never end a wake idle').join('');
    const result = checkHeartbeatPromptInvariants(stripped);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('Never end a wake idle');
  });

  it('fails when a #581 STOP-ceiling phrase reappears', () => {
    const reverted = `${ heartbeatPrompt }\n\n## Cycle Budget & Escalation\nPick ONE task, make one move, then STOP.`;
    const result = checkHeartbeatPromptInvariants(reverted);
    expect(result.ok).toBe(false);
    expect(result.forbidden).toEqual(expect.arrayContaining(['Cycle Budget', 'Pick ONE', 'make one move']));
  });

  it('matches forbidden phrases case-insensitively', () => {
    const result = checkHeartbeatPromptInvariants('the operator has a cycle budget of one item per cycle');
    expect(result.ok).toBe(false);
    expect(result.forbidden).toEqual(expect.arrayContaining(['Cycle Budget', 'one item per cycle']));
  });

  it('exposes the canonical phrase lists as non-empty', () => {
    expect(HEARTBEAT_REQUIRED_PHRASES.length).toBeGreaterThan(0);
    expect(HEARTBEAT_FORBIDDEN_PHRASES.length).toBeGreaterThan(0);
  });
});

describe('SystemPromptBuilder heartbeat invariant wiring', () => {
  const baseCtx = (overrides: Partial<PromptBuildContext>): PromptBuildContext => ({
    mode:                  'full',
    agentId:               'sulla-desktop',
    agentConfig:           null,
    provider:              'openai', // non-anthropic keeps the assertion focused on `text`
    chatMode:              'text',
    trustLevel:            'trusted',
    isSubAgent:            false,
    isHeartbeat:           true,
    wsChannel:             'heartbeat',
    toolMode:              'slim',
    templateVars:          {},
    agentSectionOverrides: new Map(),
    excludeSections:       new Set(),
    basePrompt:            '',
    ...overrides,
  });

  it('attaches a passing invariant result for a healthy heartbeat build', async () => {
    SystemPromptBuilder.register('heartbeat', () => ({
      id:             'heartbeat',
      content:        heartbeatPrompt,
      priority:       110,
      cacheStability: 'stable',
    }), ['full']);

    const built = await SystemPromptBuilder.build(baseCtx({}));
    expect(built.heartbeatInvariants?.ok).toBe(true);
  });

  it('flags a stale/reverted heartbeat build', async () => {
    SystemPromptBuilder.register('heartbeat', () => ({
      id:             'heartbeat',
      content:        'stale prompt with a Cycle Budget: pick exactly one task and STOP.',
      priority:       110,
      cacheStability: 'stable',
    }), ['full']);

    const built = await SystemPromptBuilder.build(baseCtx({}));
    expect(built.heartbeatInvariants?.ok).toBe(false);
    expect(built.heartbeatInvariants?.forbidden).toContain('Cycle Budget');
  });

  it('skips the invariant check for non-heartbeat builds', async () => {
    SystemPromptBuilder.register('heartbeat', () => null, ['full']);

    const built = await SystemPromptBuilder.build(baseCtx({ isHeartbeat: false }));
    expect(built.heartbeatInvariants).toBeUndefined();
  });
});
