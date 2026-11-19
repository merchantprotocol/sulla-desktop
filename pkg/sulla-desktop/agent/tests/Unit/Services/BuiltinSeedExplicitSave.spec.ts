// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDefinitionTableFake } from '../../Support/AgentDefinitionTableFake';

import type { BuiltinAgentSpec, BuiltinManagedContent } from '@pkg/agent/builtinAgents/index';
import { FRONT_DOOR_CHOSEN_KEY, hashManagedContent, renderBuiltinAgent } from '@pkg/agent/builtinAgents/index';
import { cardFillPatch, decideBuiltinSeedAction, seedBuiltinAgents, shouldFillBuiltinFrontDoor } from '@pkg/agent/builtinAgents/seedBuiltinAgents';
import type { AgentDefinition } from '@pkg/agent/database/models/AgentDefinitionModel';

const f = vi.hoisted(() => ({
  table:         null as unknown as { query: (...args: any[]) => Promise<any>; queryOne: (...args: any[]) => Promise<any> },
  query:         vi.fn(async() => [] as { slug: string }[]),
  findBySlug:    vi.fn(),
  create:        vi.fn(),
  update:        vi.fn(),
  fillFrontDoor: vi.fn(),
}));

// The seeder's own reads and ledger go to f.query; rows built by the real model go to the table.
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: { query: f.query, queryOne: (...args: any[]) => f.table.queryOne(...args) } }));
vi.mock('@pkg/agent/database/RedisClient', () => ({ redisClient: {} }));
vi.mock('@pkg/agent/database/models/AgentDefinitionModel', () => ({
  AgentDefinitionModel: {
    findBySlug:    f.findBySlug,
    create:        f.create,
    update:        f.update,
    fillFrontDoor: f.fillFrontDoor,
  },
  DEFAULT_AGENT_RUN_LOCATION: 'container',
}));

const HOME = '/tmp/qa-builtin-home';
const GIT = { name: '', email: '' };
const publisher = { announce() {} };

function spec(overrides: { prompt?: string; card?: Partial<BuiltinAgentSpec['card']>; config?: Record<string, unknown> } = {}): BuiltinAgentSpec {
  return {
    slug:        'qa-builtin',
    name:        'QA Builtin',
    description: 'Reviews.',
    provider:    null,
    // Like the shipped managers: a model slot the category policy rewrites on every write.
    modelSlot:   'primary',
    card:        {
      whenToCall:    'when',
      whenNotToCall: 'not',
      send:          'send',
      returns:       'returns',
      costTier:      null,
      canCall:       ['teammate'],
      frontDoor:     false,
      ...overrides.card,
    },
    prompt: overrides.prompt ?? 'Do the work.',
    config: overrides.config ?? { role: 'review' },
  };
}

/**
 * The row findBySlug returns after the seeder inserted this content: built by the real
 * AgentDefinitionModel.create (category policy, front-door marker, rowToDefinition), not a
 * spread of the rendered bundle. `edit` stands for a later save from the editor or SQL.
 */
async function storedRow(content: BuiltinManagedContent, edit: Partial<AgentDefinition> = {}, options: { frontDoor?: boolean | null; isBuiltin?: boolean; builtinHash?: string | null } = {}): Promise<AgentDefinition> {
  f.table = new AgentDefinitionTableFake();
  const { AgentDefinitionModel: RealModel } = await vi.importActual<typeof import('@pkg/agent/database/models/AgentDefinitionModel')>('@pkg/agent/database/models/AgentDefinitionModel');
  const row = await RealModel.create({
    slug:          'qa-builtin',
    name:          content.name,
    description:   content.description,
    systemPrompt:  content.system_prompt,
    promptContent: content.prompt_content,
    soulContent:   content.soul_content,
    goalsContent:  content.goals_content,
    promptFiles:   content.prompt_files,
    allowedTools:  content.allowed_tools,
    skillRefs:     content.skill_refs,
    routineRefs:   content.routine_refs,
    modelPriority: content.model_priority,
    provider:      content.provider,
    model:         content.model,
    modelSlot:     content.model_slot,
    config:        content.config,
    whenToCall:    content.when_to_call,
    whenNotToCall: content.when_not_to_call,
    send:          content.send,
    returns:       content.returns,
    costTier:      content.cost_tier,
    canCall:       content.can_call,
    isBuiltin:     options.isBuiltin ?? true,
    builtinHash:   options.builtinHash === undefined ? hashManagedContent(content) : options.builtinHash,
    status:        'production',
    enabled:       true,
    sourceKind:    'local',
    runLocation:   'container',
    ...(options.frontDoor !== undefined ? { frontDoor: options.frontDoor } : {}),
  }, publisher);
  return { ...row, ...edit };
}

beforeEach(() => {
  f.query.mockReset(); f.query.mockResolvedValue([]);
  f.findBySlug.mockReset();
  f.create.mockReset(); f.create.mockResolvedValue({ id: 'id-1' });
  f.update.mockReset(); f.update.mockResolvedValue({ id: 'id-1' });
  f.fillFrontDoor.mockReset(); f.fillFrontDoor.mockResolvedValue(true);
});

describe('explicit built-in editor saves survive the next seed', () => {
  it('reads a freshly seeded row back as untouched, even though the model rewrote its model fields', async() => {
    const content = renderBuiltinAgent(spec(), HOME, GIT);
    const row = await storedRow(content);
    // What the database actually holds differs from the raw bundle in the policy-owned fields.
    expect(row.model_slot).toBeNull();
    expect(row.config.modelChoice).toEqual({ mode: 'class', class: 'frontier' });
    expect(hashManagedContent(row)).toBe(row.builtin_hash);
    expect(decideBuiltinSeedAction(content, row, true)).toEqual({ kind: 'unchanged' });
  });

  it('keeps a null-only front door when the managed hash still matches', async() => {
    const bundled = spec();
    const content = renderBuiltinAgent(bundled, HOME, GIT);
    const row = await storedRow(content, {}, { frontDoor: null });
    expect(row.config[FRONT_DOOR_CHOSEN_KEY]).toBeNull();
    expect(hashManagedContent(row)).toBe(row.builtin_hash);
    expect(hashManagedContent(row)).toBe(hashManagedContent(content));
    expect(decideBuiltinSeedAction(content, row, true)).toEqual({ kind: 'unchanged' });
    expect(shouldFillBuiltinFrontDoor(row, false)).toBe(false);
    const unmarked = await storedRow(content);
    expect(hashManagedContent(unmarked)).toBe(unmarked.builtin_hash);
    expect(shouldFillBuiltinFrontDoor(unmarked, false)).toBe(true);

    f.findBySlug.mockResolvedValue(row);
    const summary = await seedBuiltinAgents([bundled]);
    expect(summary.unchanged).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.fillFrontDoor).not.toHaveBeenCalled();
  });

  it('still fills an unset front door on an untouched built-in that has no explicit choice', async() => {
    const bundled = spec();
    const content = renderBuiltinAgent(bundled, HOME, GIT);
    const row = await storedRow(content);
    f.findBySlug.mockResolvedValue(row);
    await seedBuiltinAgents([bundled]);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.fillFrontDoor).toHaveBeenCalledTimes(1);
    expect(f.fillFrontDoor).toHaveBeenCalledWith('qa-builtin', false);
  });

  it('does not restore cleared routing or an empty team on a customized hashed built-in', async() => {
    const content = renderBuiltinAgent(spec(), HOME, GIT);
    const row = await storedRow(content, { when_to_call: '', can_call: [] });
    expect(hashManagedContent(row)).not.toBe(row.builtin_hash);
    // The blank string still looks unfilled. [] does not. The kept decision is what blocks the write.
    expect(cardFillPatch(row, content)).toEqual({ whenToCall: 'when' });
    expect(decideBuiltinSeedAction(content, row, true)).toEqual({ kind: 'kept' });
    expect(shouldFillBuiltinFrontDoor(row, false)).toBe(false);
  });

  it('leaves that customized built-in untouched at boot, including its unset front door', async() => {
    const bundled = spec();
    const content = renderBuiltinAgent(bundled, HOME, GIT);
    const row = await storedRow(content, { when_to_call: '', can_call: [] });
    f.findBySlug.mockResolvedValue(row);
    const summary = await seedBuiltinAgents([bundled]);
    expect(summary.kept).toBe(1);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.fillFrontDoor).not.toHaveBeenCalled();
  });

  it('fills blank string cards on a not-yet-hashed built-in and does not treat [] as missing', async() => {
    const bundled = spec();
    const content = renderBuiltinAgent(bundled, HOME, GIT);
    const row = await storedRow(content, { when_to_call: '', can_call: [] }, { builtinHash: null });
    expect(decideBuiltinSeedAction(content, row, false)).toEqual({ kind: 'fill-cards', patch: { whenToCall: 'when' } });
    f.findBySlug.mockResolvedValue(row);
    await seedBuiltinAgents([bundled]);
    expect(f.update).toHaveBeenCalledWith(row.id, { whenToCall: 'when' }, row.updated_at);
    expect(f.fillFrontDoor).toHaveBeenCalledWith('qa-builtin', false);
  });

  it('upgrades an untouched prompt and copies an explicit null front door onto the new config', async() => {
    const previous = renderBuiltinAgent(spec({ prompt: 'Old prompt.' }), HOME, GIT);
    const next = spec({ prompt: 'New prompt.' });
    const nextContent = renderBuiltinAgent(next, HOME, GIT);
    const row = await storedRow(previous, {}, { frontDoor: null });
    expect(hashManagedContent(row)).toBe(row.builtin_hash);
    expect(hashManagedContent(row)).not.toBe(hashManagedContent(nextContent));
    expect(decideBuiltinSeedAction(nextContent, row, true).kind).toBe('refresh');
    f.findBySlug.mockResolvedValue(row);
    await seedBuiltinAgents([next]);
    expect(f.fillFrontDoor).not.toHaveBeenCalled();
    const patch = f.update.mock.calls[0][1];
    expect(patch.promptContent).toBe('New prompt.');
    expect(patch.systemPrompt).toBe('New prompt.');
    expect(patch.config).toMatchObject({ role: 'review', [FRONT_DOOR_CHOSEN_KEY]: null });
    expect(patch).not.toHaveProperty('frontDoor');
    // The refresh never names a model choice, so the model keeps the row's own.
    expect(patch).not.toHaveProperty('modelChoice');
    expect(patch.builtinHash).toBe(hashManagedContent(nextContent));
    expect(hashManagedContent({ ...nextContent, config: patch.config })).toBe(patch.builtinHash);
  });

  it('still upgrades an untouched built-in and fills a front door that was never chosen', async() => {
    const previous = renderBuiltinAgent(spec({ prompt: 'Old prompt.' }), HOME, GIT);
    const next = spec({ prompt: 'New prompt.' });
    const row = await storedRow(previous);
    f.findBySlug.mockResolvedValue(row);
    await seedBuiltinAgents([next]);
    expect(f.update.mock.calls[0][1].promptContent).toBe('New prompt.');
    expect(f.update.mock.calls[0][1].config).not.toHaveProperty(FRONT_DOOR_CHOSEN_KEY);
    expect(f.fillFrontDoor).toHaveBeenCalledWith('qa-builtin', false);
  });

  it('keeps a human prompt edit on a seeded built-in through an upgrade', async() => {
    const previous = renderBuiltinAgent(spec({ prompt: 'Old prompt.' }), HOME, GIT);
    const next = spec({ prompt: 'New prompt.' });
    const row = await storedRow(previous, { prompt_content: 'My prompt.', system_prompt: 'My prompt.' });
    expect(decideBuiltinSeedAction(renderBuiltinAgent(next, HOME, GIT), row, true)).toEqual({ kind: 'kept' });
    f.findBySlug.mockResolvedValue(row);
    await seedBuiltinAgents([next]);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.fillFrontDoor).not.toHaveBeenCalled();
  });

  it('fills blank legacy strings, keeps [], and does not adopt a row whose only difference is the team', async() => {
    const content = renderBuiltinAgent(spec(), HOME, GIT);
    const legacy = await storedRow(content, { when_to_call: '', when_not_to_call: '', send: '', returns: '', can_call: [] }, { isBuiltin: false, builtinHash: null });
    const action = decideBuiltinSeedAction(content, legacy, true);
    expect(action).toEqual({ kind: 'fill-cards', patch: { whenToCall: 'when', whenNotToCall: 'not', send: 'send', returns: 'returns' } });
    const teamOnly = await storedRow(content, { can_call: [] }, { isBuiltin: false, builtinHash: null });
    expect(decideBuiltinSeedAction(content, teamOnly, true)).toEqual({ kind: 'kept' });
    const adoptable = await storedRow(content, { when_to_call: '' }, { isBuiltin: false, builtinHash: null });
    expect(decideBuiltinSeedAction(content, adoptable, true)).toEqual({ kind: 'adopt', patch: { whenToCall: 'when', isBuiltin: true, builtinHash: hashManagedContent(content) } });
  });

  it('fills a legacy row at boot, and the same row with an explicit null does not get a front door', async() => {
    const bundled = spec();
    const content = renderBuiltinAgent(bundled, HOME, GIT);
    const legacy = await storedRow(content, { when_to_call: '', can_call: [] }, { isBuiltin: false, builtinHash: null });
    f.findBySlug.mockResolvedValue(legacy);
    await seedBuiltinAgents([bundled]);
    expect(f.update.mock.calls[0][1]).toMatchObject({ whenToCall: 'when' });
    expect(f.update.mock.calls[0][1]).not.toHaveProperty('canCall');
    expect(f.fillFrontDoor).toHaveBeenCalledWith('qa-builtin', false);

    f.update.mockClear(); f.fillFrontDoor.mockClear();
    f.findBySlug.mockResolvedValue(await storedRow(content, { when_to_call: '', can_call: [] }, { isBuiltin: false, builtinHash: null, frontDoor: null }));
    await seedBuiltinAgents([bundled]);
    expect(f.update.mock.calls[0][1]).toMatchObject({ whenToCall: 'when' });
    expect(f.update.mock.calls[0][1]).not.toHaveProperty('canCall');
    expect(f.fillFrontDoor).not.toHaveBeenCalled();
  });

  it('ignores only the front-door marker and the policy-owned model fields in the managed hash', () => {
    const content = renderBuiltinAgent(spec({ config: { role: 'review', front_door: false } }), HOME, GIT);
    const marked = { ...content, config: { ...content.config, [FRONT_DOOR_CHOSEN_KEY]: null } };
    expect(FRONT_DOOR_CHOSEN_KEY).toBe('frontDoorChosen');
    expect(hashManagedContent(marked)).toBe(hashManagedContent(content));
    const asStored = { ...content, provider: null, model: null, model_slot: null, model_priority: [], config: { ...content.config, modelChoice: { mode: 'class', class: 'coding' } } };
    expect(hashManagedContent(asStored)).toBe(hashManagedContent(content));
    expect(hashManagedContent({ ...content, config: { ...content.config, role: 'other' } })).not.toBe(hashManagedContent(content));
    expect(hashManagedContent({ ...content, prompt_content: 'Changed.' })).not.toBe(hashManagedContent(content));
    expect(hashManagedContent({ ...content, can_call: [] })).not.toBe(hashManagedContent(content));
  });
});
