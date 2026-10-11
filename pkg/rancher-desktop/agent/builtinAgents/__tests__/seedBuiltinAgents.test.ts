import os from 'node:os';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../database/PostgresClient';
import { AgentDefinitionModel, type AgentDefinition } from '../../database/models/AgentDefinitionModel';
import { hashManagedContent, renderBuiltinAgent, type BuiltinAgentSpec } from '../index';
import { decideBuiltinSeedAction, retireBuiltinAgents, seedBuiltinAgents, shouldRetireBuiltin } from '../seedBuiltinAgents';

const HOME = '/Users/someone';

const spec: BuiltinAgentSpec = {
  slug:        'demo-worker',
  name:        'Demo Worker',
  description: 'Demo',
  provider:    'claude-code',
  model:       'claude-haiku-5-5',
  card:        { whenToCall: 'demos', whenNotToCall: 'prod', send: 'brief', returns: 'result', costTier: 'low', canCall: [] },
  config:      { type: 'worker' },
  soul:        'soul',
  prompt:      'prompt v1',
};

const content = renderBuiltinAgent(spec, HOME);
const bundleHash = hashManagedContent(content);

function row(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id:                      'agent-1',
    slug:                    spec.slug,
    version:                 null,
    status:                  'production',
    enabled:                 true,
    source_template_slug:    null,
    content_hash:            null,
    source_kind:             'local',
    marketplace_template_id: null,
    marketplace_slug:        null,
    marketplace_version:     null,
    marketplace_author:      null,
    created_at:              '2026-10-11T00:00:00.000Z',
    updated_at:              '2026-10-11T00:00:00.123Z',
    ...content,
    is_builtin:              true,
    front_door:              null,
    builtin_hash:            bundleHash,
    ...overrides,
  };
}

const noCard = { when_to_call: '', when_not_to_call: '', send: '', returns: '', cost_tier: null, can_call: [] };

afterEach(() => { jest.restoreAllMocks() });

describe('decideBuiltinSeedAction', () => {
  it('inserts a never-seen agent and respects a human delete', () => {
    expect(decideBuiltinSeedAction(content, null, false)).toEqual({ kind: 'insert' });
    expect(decideBuiltinSeedAction(content, null, true)).toEqual({ kind: 'deleted-by-human' });
  });

  it('leaves an up-to-date built-in alone', () => {
    expect(decideBuiltinSeedAction(content, row(), true)).toEqual({ kind: 'unchanged' });
  });

  it('refreshes a built-in untouched since the last seed when the bundle changes', () => {
    const old = renderBuiltinAgent({ ...spec, prompt: 'prompt v0' }, HOME);
    const stale = row({ ...old, builtin_hash: hashManagedContent(old) });
    expect(decideBuiltinSeedAction(content, stale, true)).toEqual({ kind: 'refresh' });
  });

  it('never overwrites a built-in the human edited', () => {
    const edited = row({ prompt_content: 'my own prompt', builtin_hash: hashManagedContent(renderBuiltinAgent({ ...spec, prompt: 'prompt v0' }, HOME)) });
    expect(decideBuiltinSeedAction(content, edited, true)).toEqual({ kind: 'kept' });
  });

  it('only fills empty card fields on an edited row', () => {
    const edited = row({ prompt_content: 'my own prompt', ...noCard, when_to_call: 'my words' });
    const action = decideBuiltinSeedAction(content, edited, true);
    expect(action).toEqual({ kind: 'fill-cards', patch: { whenNotToCall: 'prod', send: 'brief', returns: 'result', costTier: 'low' } });
  });

  it('adopts a pre-existing identical row and fills its new card', () => {
    const legacy = row({ ...noCard, is_builtin: false, builtin_hash: null });
    expect(decideBuiltinSeedAction(content, legacy, false)).toEqual({
      kind:  'adopt',
      patch: { whenToCall: 'demos', whenNotToCall: 'prod', send: 'brief', returns: 'result', costTier: 'low', isBuiltin: true, builtinHash: bundleHash },
    });
  });

  it('does not adopt a pre-existing row with different content', () => {
    const custom = row({ ...noCard, prompt_files: { 'prompt.md': 'older' }, is_builtin: false, builtin_hash: null });
    const action = decideBuiltinSeedAction(content, custom, false);
    expect(action.kind).toBe('fill-cards');
    expect((action as any).patch.isBuiltin).toBeUndefined();
  });
});

describe('seedBuiltinAgents', () => {
  it('inserts missing agents as built-in and records them in the ledger', async() => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([] as any);
    jest.spyOn(AgentDefinitionModel, 'findBySlug').mockResolvedValue(null);
    const create = jest.spyOn(AgentDefinitionModel, 'create').mockResolvedValue(row());

    const summary = await seedBuiltinAgents([spec]);

    expect(summary).toMatchObject({ inserted: 1, errors: [] });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'demo-worker', status: 'production', enabled: true, isBuiltin: true, whenToCall: 'demos', costTier: 'low',
    }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO agent_builtin_seed_ledger'), ['demo-worker']);
  });

  it('does not re-create a built-in the human deleted', async() => {
    jest.spyOn(postgresClient, 'query').mockResolvedValue([{ slug: 'demo-worker' }] as any);
    jest.spyOn(AgentDefinitionModel, 'findBySlug').mockResolvedValue(null);
    const create = jest.spyOn(AgentDefinitionModel, 'create');

    expect(await seedBuiltinAgents([spec])).toMatchObject({ skipped: 1, inserted: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it('refreshes with compare-and-set on the row it read', async() => {
    jest.spyOn(postgresClient, 'query').mockResolvedValue([{ slug: 'demo-worker' }] as any);
    const live = renderBuiltinAgent({ ...spec, prompt: 'prompt v0' }, os.homedir());
    const stale = row({ ...live, builtin_hash: hashManagedContent(live) });
    jest.spyOn(AgentDefinitionModel, 'findBySlug').mockResolvedValue(stale);
    const update = jest.spyOn(AgentDefinitionModel, 'update').mockResolvedValue(null);

    const summary = await seedBuiltinAgents([spec]);

    expect(update).toHaveBeenCalledWith('agent-1', expect.objectContaining({ promptContent: 'prompt v1', isBuiltin: true }), stale.updated_at);
    expect(summary).toMatchObject({ refreshed: 0, kept: 1 });
  });
});

describe('retiring built-ins the bundle no longer ships', () => {
  it('only switches off an enabled built-in the human never edited, and only once', () => {
    expect(shouldRetireBuiltin(row(), false)).toBe(true);
    expect(shouldRetireBuiltin(row(), true)).toBe(false);
    expect(shouldRetireBuiltin(null, false)).toBe(false);
    expect(shouldRetireBuiltin(row({ enabled: false }), false)).toBe(false);
    expect(shouldRetireBuiltin(row({ is_builtin: false }), false)).toBe(false);
    expect(shouldRetireBuiltin(row({ prompt_content: 'edited by the human' }), false)).toBe(false);
  });

  it('disables with compare-and-set, never deletes, and records the retirement', async() => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([] as any);
    jest.spyOn(AgentDefinitionModel, 'findBySlug').mockResolvedValue(row());
    const update = jest.spyOn(AgentDefinitionModel, 'update').mockResolvedValue(row({ enabled: false }));

    expect(await retireBuiltinAgents(['demo-worker'])).toEqual({ disabled: 1, errors: [] });
    expect(update).toHaveBeenCalledWith('agent-1', { enabled: false }, row().updated_at);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO agent_builtin_seed_ledger'), ['retired:demo-worker']);
  });

  it('leaves a retirement alone once it has been handled', async() => {
    jest.spyOn(postgresClient, 'query').mockResolvedValue([{ slug: 'retired:demo-worker' }] as any);
    const find = jest.spyOn(AgentDefinitionModel, 'findBySlug');
    const update = jest.spyOn(AgentDefinitionModel, 'update');

    expect(await retireBuiltinAgents(['demo-worker'])).toEqual({ disabled: 0, errors: [] });
    expect(find).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
