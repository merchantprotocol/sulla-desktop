import { describe, expect, it } from '@jest/globals';

import {
  HeartbeatPromptInvariantError,
  SystemPromptBuilder,
  type PromptBuildContext,
} from '../SystemPromptBuilder';
import { heartbeatPrompt } from '../heartbeat';
import {
  HEARTBEAT_FORBIDDEN_PHRASES,
  HEARTBEAT_REQUIRED_PHRASES,
  checkHeartbeatPromptInvariants,
} from '../heartbeatInvariants';

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
    for (const phrase of [
      'Two-Door Rule',
      'The Prospector',
      'If an owner capability is unavailable',
      'Write every material outcome back to Projects',
      'This Prompt Is Frozen',
    ]) {
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

  it('keeps blocked planning, execution, review, waiting, and recovery single-owned', () => {
    expect(heartbeatPrompt).toContain('Single-Owner Projects Conveyor');
    expect(heartbeatPrompt).toContain('protected planning routine');
    expect(heartbeatPrompt).toContain('protected execution routine');
    expect(heartbeatPrompt).toContain('protected review routine');
    expect(heartbeatPrompt).toContain('durable wait monitor');
    expect(heartbeatPrompt).toContain('deterministic recovery');
    expect(heartbeatPrompt).toContain('Every state or concern has exactly one owner');
  });

  it('forbids the removed duplicate-owner doctrine at runtime', () => {
    for (const phrase of [
      'Blocked Recovery Council — Decide, Do Not Escalate',
      'Auto-Dispatch on Blocked — Independent Council, Then Act',
      'Task-Type Playbooks',
      'Artifact-per-Cycle Contract',
      "Review tasks returned to 'in_review'",
      'three independent high-reasoning planner agents',
    ]) {
      expect(heartbeatPrompt).not.toContain(phrase);
      expect(HEARTBEAT_FORBIDDEN_PHRASES).toContain(phrase);
    }
  });

  it('fails closed on every forbidden ordinary-owner regression', () => {
    for (const phrase of [
      'launch ordinary todo workers',
      'run its own planner council',
      'inspect and close every in_review task',
      'commit, push, or open PRs as ordinary artifact custodian',
      'update marketing trackers as ordinary artifact custodian',
      'poll unchanged CI or external gates',
      'reclaim healthy leases based only on time',
      'perform core-routine state transitions directly',
      'one task per wake',
    ]) {
      const result = checkHeartbeatPromptInvariants(`${ heartbeatPrompt }\n${ phrase }`);
      expect(result.ok).toBe(false);
      expect(result.forbidden).toContain(phrase);
    }
  });

  it('pins missing-capability, single-recovery, durable-wait, Projects, and freeze behavior', () => {
    for (const phrase of [
      'Affected tasks remain visible and unclaimed unless the responsibility contract names an explicit fallback',
      'Repeated failures of the same owner capability update one existing systemic recovery item',
      'Notify once when the gate is created or materially changes',
      'Projects project-state is your only durable agenda',
      'never let install-local Markdown replace or append to it',
      "never flip 'heartbeatEnabled'",
    ]) {
      const stripped = heartbeatPrompt.split(phrase).join('');
      const result = checkHeartbeatPromptInvariants(stripped);
      expect(result.ok).toBe(false);
      expect(result.missing).toContain(phrase);
    }
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

  it('attaches a passing invariant result for a healthy heartbeat build', async() => {
    SystemPromptBuilder.register('heartbeat', () => ({
      id:             'heartbeat',
      content:        heartbeatPrompt,
      priority:       110,
      cacheStability: 'stable',
    }), ['full']);

    const built = await SystemPromptBuilder.build(baseCtx({}));
    expect(built.heartbeatInvariants?.ok).toBe(true);
  });

  it('does not let install-local markdown replace or append to the frozen heartbeat contract', async() => {
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
      dbSections:            new Map([
        ['heartbeat', {
          content:        'STALE DB HEARTBEAT OVERRIDE',
          priority:       1,
          cacheStability: 'dynamic',
          isGenerated:    false,
        }],
      ]),
    }));

    expect(built.includedSections).toContain('heartbeat');
    expect(built.includedSections).not.toContain('agent_prompt');
    expect(built.text).toContain('## Single-Owner Projects Conveyor');
    expect(built.text).not.toContain('STALE LOCAL HEARTBEAT OVERRIDE');
    expect(built.text).not.toContain('STALE LOCAL PLAYBOOK CONTENT');
    expect(built.text).not.toContain('STALE DB HEARTBEAT OVERRIDE');
    expect(built.heartbeatInvariants?.ok).toBe(true);
  });

  it('rejects a stale/reverted prompt before the heartbeat wake can run', async() => {
    SystemPromptBuilder.register('heartbeat', () => ({
      id:             'heartbeat',
      content:        'stale prompt with a Cycle Budget: pick exactly one task and STOP.',
      priority:       110,
      cacheStability: 'stable',
    }), ['full']);

    await expect(SystemPromptBuilder.build(baseCtx({}))).rejects.toMatchObject({
      name:       'HeartbeatPromptInvariantError',
      invariants: {
        ok:        false,
        forbidden: expect.arrayContaining(['Cycle Budget', 'pick exactly one']),
      },
    });
  });

  it('exposes a typed production-boundary error for heartbeat wake handling', async() => {
    SystemPromptBuilder.register('heartbeat', () => ({
      id:             'heartbeat',
      content:        heartbeatPrompt.split('Two-Door Rule').join(''),
      priority:       110,
      cacheStability: 'stable',
    }), ['full']);

    let rejection: unknown;
    try {
      await SystemPromptBuilder.build(baseCtx({}));
    } catch (err) {
      rejection = err;
    }

    expect(rejection).toBeInstanceOf(HeartbeatPromptInvariantError);
    expect((rejection as HeartbeatPromptInvariantError).invariants.missing).toContain('Two-Door Rule');
  });

  it('skips the invariant check for non-heartbeat builds', async() => {
    SystemPromptBuilder.register('heartbeat', () => null, ['full']);

    const built = await SystemPromptBuilder.build(baseCtx({ isHeartbeat: false }));
    expect(built.heartbeatInvariants).toBeUndefined();
  });

  it('keeps the compiled heartbeat bytes in the stable Anthropic cache segment across wakes', async() => {
    SystemPromptBuilder.register('heartbeat', () => ({
      id:             'heartbeat',
      content:        heartbeatPrompt,
      priority:       110,
      cacheStability: 'stable',
    }), ['full']);

    const first = await SystemPromptBuilder.build(baseCtx({ provider: 'anthropic', basePrompt: 'dynamic wake A' }));
    const second = await SystemPromptBuilder.build(baseCtx({ provider: 'anthropic', basePrompt: 'dynamic wake B' }));

    expect(first.anthropicSystem?.[0]).toEqual({
      type:          'text',
      text:          heartbeatPrompt,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(second.anthropicSystem?.[0]).toEqual(first.anthropicSystem?.[0]);
    expect(first.anthropicSystem?.at(-1)?.text).toBe('dynamic wake A');
    expect(second.anthropicSystem?.at(-1)?.text).toBe('dynamic wake B');
    expect(first.heartbeatInvariants?.ok).toBe(true);
    expect(second.heartbeatInvariants?.ok).toBe(true);
  });
});
