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

  it('fails when the operator doctrine or freeze covenant is stripped from a deployed prompt', () => {
    for (const phrase of ['Two-Door Rule', 'The Prospector', 'This Prompt Is Frozen']) {
      const stripped = heartbeatPrompt.split(phrase).join('');
      const result = checkHeartbeatPromptInvariants(stripped);
      expect(result.ok).toBe(false);
      expect(result.missing).toContain(phrase);
    }
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

  it('keeps blocked recovery autonomous and council-driven', () => {
    expect(heartbeatPrompt).toContain('Blocked Recovery Council — Decide, Do Not Escalate');
    expect(heartbeatPrompt).toContain('three independent high-reasoning planner agents');
    expect(heartbeatPrompt).toContain('core-routine-plan-project-task');
    expect(heartbeatPrompt).toContain('Heartbeat does not spawn planners');
    expect(heartbeatPrompt).toContain('unchanged gates get no repeated notification');
  });

  it('requires mechanical ordinary dispatch and heartbeat supervision', () => {
    expect(heartbeatPrompt).toContain('Mechanical Dispatch');
    expect(heartbeatPrompt).toContain('PostgreSQL Decides');
    expect(heartbeatPrompt).toContain('one live dispatch per task');
    expect(heartbeatPrompt).toContain('Heartbeat does not select or launch ordinary queue work');
    expect(heartbeatPrompt).toContain('Supervisor Loop');
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

  it('does not let install-local markdown replace or append to the frozen heartbeat contract', async () => {
    SystemPromptBuilder.register('agent_prompt', () => ({
      id:             'agent_prompt',
      content:        'STALE LOCAL PLAYBOOK CONTENT',
      priority:       90,
      cacheStability: 'stable',
    }), ['full']);
    SystemPromptBuilder.register('heartbeat', () => ({
      id:             'heartbeat',
      content:        heartbeatPrompt,
      priority:       110,
      cacheStability: 'stable',
    }), ['full']);

    const built = await SystemPromptBuilder.build(baseCtx({
      agentConfig: {
        prompt: 'STALE LOCAL PLAYBOOK CONTENT',
      },
      agentSectionOverrides: new Map([
        ['heartbeat', 'STALE LOCAL HEARTBEAT OVERRIDE'],
      ]),
      excludeSections: new Set(['heartbeat']),
    }));

    expect(built.includedSections).toContain('heartbeat');
    expect(built.includedSections).not.toContain('agent_prompt');
    expect(built.text).toContain('## Mechanical Dispatch — Heartbeat Supervises, PostgreSQL Decides');
    expect(built.text).not.toContain('STALE LOCAL HEARTBEAT OVERRIDE');
    expect(built.text).not.toContain('STALE LOCAL PLAYBOOK CONTENT');
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
