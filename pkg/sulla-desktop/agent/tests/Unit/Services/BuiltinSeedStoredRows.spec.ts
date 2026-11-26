// SPDX-License-Identifier: GPL-2.0-or-later
// The built-in seeder against rows exactly as AgentDefinitionModel stores and returns them.
// Real seeder, real model (category policy, front-door marker, rowToDefinition, CAS); only
// the database is an in-memory table that answers the model's SQL.
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDefinitionTableFake } from '../../Support/AgentDefinitionTableFake';

import type { BuiltinAgentSpec, BuiltinManagedContent } from '@pkg/agent/builtinAgents/index';
import { BuiltinAgentHasher, FRONT_DOOR_CHOSEN_KEY, getBuiltinAgentSpecs, renderBuiltinAgent } from '@pkg/agent/builtinAgents/index';
import { seedBuiltinAgents } from '@pkg/agent/builtinAgents/seedBuiltinAgents';
import { AgentDefinitionModel } from '@pkg/agent/database/models/AgentDefinitionModel';
import { AgentAwarenessDefaults } from '@pkg/agent/services/AgentAwarenessDefaults';

const db = vi.hoisted(() => ({ table: null as unknown as AgentDefinitionTableFake }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: {
    query:    (sql: string, params?: unknown[]) => db.table.query(sql, params),
    queryOne: (sql: string, params?: unknown[]) => db.table.queryOne(sql, params),
  },
}));
vi.mock('@pkg/agent/useCases/RedisUseCaseChangePublisherFactory', () => ({
  RedisUseCaseChangePublisherFactory: class { create() { return { announce() {} } } },
}));

const publisher = { announce() {} };
const GIT = { name: '', email: '' };

function spec(overrides: Partial<BuiltinAgentSpec> = {}): BuiltinAgentSpec {
  return {
    slug:        'qa-manager',
    name:        'QA Manager',
    description: 'Plans.',
    provider:    null,
    modelSlot:   'primary',
    card:        { whenToCall: 'when', whenNotToCall: 'not', send: 'send', returns: 'returns', costTier: 'high', canCall: ['*'], frontDoor: true },
    config:      { role: 'lead', type: 'lead' },
    prompt:      'Version one.',
    ...overrides,
  };
}

/**
 * builtin_hash as earlier builds wrote it: sha256 of the raw rendered bundle content,
 * model fields and config exactly as bundled. Existing installs still hold these.
 */
function legacyHash(content: BuiltinManagedContent): string {
  const fields = ['name', 'description', 'system_prompt', 'prompt_content', 'soul_content', 'goals_content', 'prompt_files',
    'allowed_tools', 'skill_refs', 'routine_refs', 'model_priority', 'provider', 'model', 'model_slot', 'config',
    'when_to_call', 'when_not_to_call', 'send', 'returns', 'cost_tier', 'can_call'] as const;
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${ value.map(canonical).join(',') }]`
    : value && typeof value === 'object'
      ? `{${ Object.keys(value).sort().map(key => `${ JSON.stringify(key) }:${ canonical((value as any)[key]) }`).join(',') }}`
      : JSON.stringify(value ?? null);
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (content as any)[field];
    picked[field] = field === 'provider' || field === 'model' || field === 'model_slot' || field === 'cost_tier' ? (value || null) : value;
  }
  return `sha256:${ createHash('sha256').update(canonical(picked)).digest('hex') }`;
}

/** A row an earlier build seeded: same columns the seeder writes, its legacy hash, ledger marked. */
async function legacySeeded(bundled: BuiltinAgentSpec, options: { frontDoor?: boolean | null } = {}) {
  const content = renderBuiltinAgent(bundled, '/tmp/qa-home', GIT);
  await AgentDefinitionModel.create({
    slug:          bundled.slug,
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
    isBuiltin:     true,
    builtinHash:   legacyHash(content),
    status:        'production',
    enabled:       true,
    sourceKind:    'local',
    runLocation:   'container',
    ...(options.frontDoor !== undefined ? { frontDoor: options.frontDoor } : {}),
  }, publisher);
  db.table.ledger.add(bundled.slug);
  return content;
}

beforeEach(() => { db.table = new AgentDefinitionTableFake() });

describe('seeding built-ins against stored rows', () => {
  it('ships the shared awareness defaults for workers and built-in leads', async() => {
    // risk: a seed update reintroduces sibling context into workers or hides it from managers.
    const shipped = getBuiltinAgentSpecs();
    const result = await seedBuiltinAgents(shipped);
    expect(result.errors).toEqual([]);
    expect(AgentAwarenessDefaults.DEFAULT_OFF_AGENT_SLUGS).toEqual([
      ...AgentAwarenessDefaults.WORKER_AGENT_SLUGS, 'integrator', 'premortem-planner', 'designer',
    ]);
    expect(AgentAwarenessDefaults.DEFAULT_ON_AGENT_SLUGS).toEqual([
      'project-manager', 'coding-manager', 'director', 'ui-test-manager', 'account-manager', 'conversationalist',
    ]);
    for (const slug of AgentAwarenessDefaults.DEFAULT_OFF_AGENT_SLUGS) expect((await AgentDefinitionModel.findBySlug(slug))?.agent_awareness, slug).toBe(false);
    for (const slug of AgentAwarenessDefaults.DEFAULT_ON_AGENT_SLUGS) expect((await AgentDefinitionModel.findBySlug(slug))?.agent_awareness, slug).toBe(true);
  });

  it('ships capability classes instead of stale provider-specific model ids', () => {
    for (const agent of getBuiltinAgentSpecs()) {
      expect(agent.provider, agent.slug).toBeFalsy();
      expect([undefined, null, 'frontier', 'standard', 'fast', 'coding', 'local'], agent.slug).toContain(agent.model);
    }
  });

  it('sees every shipped built-in as unchanged on the boot after it was installed', async() => {
    const shipped = getBuiltinAgentSpecs();
    const first = await seedBuiltinAgents(shipped);
    expect(first.errors).toEqual([]);
    expect(first.inserted).toBe(shipped.length);
    const writesAfterInstall = db.table.updates.length;

    const second = await seedBuiltinAgents(shipped);
    expect(second.errors).toEqual([]);
    expect(second.unchanged).toBe(shipped.length);
    expect(second.kept).toBe(0);
    expect(db.table.updates.length).toBe(writesAfterInstall);
  });

  it('preserves a user-toggled worker awareness value on reseed', async() => {
    // risk: boot-time seeding must not undo the user's explicit worker visibility choice.
    const worker = getBuiltinAgentSpecs().find(item => item.slug === 'codex-luna-worker')!;
    const installed = await seedBuiltinAgents([worker]);
    expect(installed.inserted).toBe(1);
    const id = String(db.table.stored(worker.slug)!.id);
    await AgentDefinitionModel.update(id, { agentAwareness: true }, undefined, publisher);

    const reseeded = await seedBuiltinAgents([worker]);

    expect(reseeded.errors).toEqual([]);
    expect((await AgentDefinitionModel.findBySlug(worker.slug))?.agent_awareness).toBe(true);
  });

  it('upgrades an untouched built-in prompt and keeps the model class the human chose', async() => {
    await seedBuiltinAgents([spec()]);
    const id = String(db.table.stored('qa-manager')!.id);
    // The human picks a different model class for this agent; prompt and card are untouched.
    await AgentDefinitionModel.update(id, { modelChoice: { mode: 'class', class: 'coding' } }, undefined, publisher);

    const summary = await seedBuiltinAgents([spec({ prompt: 'Version two.' })]);
    expect(summary.refreshed).toBe(1);
    const row = await AgentDefinitionModel.findBySlug('qa-manager');
    expect(row!.prompt_content).toBe('Version two.');
    expect(row!.model_choice).toEqual({ mode: 'class', class: 'coding' });
    expect(row!.config.modelChoice).toEqual({ mode: 'class', class: 'coding' });
    expect(row!.builtin_hash).toBe(BuiltinAgentHasher.hashManagedContent(renderBuiltinAgent(spec({ prompt: 'Version two.' }), '/tmp/qa-home', GIT)));
    expect((await seedBuiltinAgents([spec({ prompt: 'Version two.' })])).unchanged).toBe(1);
  });

  it('stores the actual shipped name and slug and can still look up earlier selectors', async() => {
    const quickFixer = getBuiltinAgentSpecs().find(item => item.slug === 'quick-fixer')!;
    await seedBuiltinAgents([quickFixer]);
    expect(db.table.stored('quick-fixer')).toMatchObject({ slug: 'quick-fixer', name: 'Quick Fixer', is_builtin: true });
    expect(db.table.stored('codex-luna-worker')).toBeUndefined();
    expect(await AgentDefinitionModel.findBySlug('codex-luna-worker')).toMatchObject({ slug: 'quick-fixer', name: 'Quick Fixer' });
  });

  it('keeps a user-owned canonical slug through repeated seeding', async() => {
    const builder = getBuiltinAgentSpecs().find(item => item.slug === 'builder')!;
    await legacySeeded({ ...builder, slug: 'codex-sol-worker' });
    await AgentDefinitionModel.create({ slug: 'builder', name: 'My Builder', promptContent: 'My instructions.' });
    const custom = await AgentDefinitionModel.findBySlug('builder');
    const builtin = await AgentDefinitionModel.findBySlug('codex-sol-worker');

    await seedBuiltinAgents([builder]);
    await seedBuiltinAgents([builder]);
    expect(await AgentDefinitionModel.findBySlug('builder')).toEqual(custom);
    expect(await AgentDefinitionModel.findBySlug('codex-sol-worker')).toMatchObject({ id: builtin?.id, is_builtin: true, name: 'Builder' });
  });

  it('updates only the shipped Advisor identity in a customized installed prompt', async() => {
    const advisor = getBuiltinAgentSpecs().find(item => item.slug === 'advisor')!;
    const legacy = 'You are the **Opus Worker** — a high-capability Claude agent running in your Preferences model slot spawned by the primary Sulla agent.\nCustom review guidance.';
    await legacySeeded({ ...advisor, prompt: legacy });
    const original = await AgentDefinitionModel.findBySlug(advisor.slug);
    await seedBuiltinAgents([advisor]);
    const updated = await AgentDefinitionModel.findBySlug(advisor.slug);
    expect(updated?.prompt_content).toMatch(/^You are \*\*Advisor\*\*/);
    expect(updated?.prompt_content.endsWith('\nCustom review guidance.')).toBe(true);
    expect(updated?.prompt_files['prompt.md']).toBe(updated?.prompt_content);
    expect(updated?.builtin_hash).toBe(original?.builtin_hash);
    const writes = db.table.updates.length;
    await seedBuiltinAgents([advisor]);
    expect(db.table.updates.length).toBe(writes);
  });

  it('keeps a human prompt edit through an upgrade', async() => {
    await seedBuiltinAgents([spec()]);
    db.table.write('qa-manager', { prompt_content: 'Mine.', system_prompt: 'Mine.' });
    const summary = await seedBuiltinAgents([spec({ prompt: 'Version two.' })]);
    expect(summary.kept).toBe(1);
    expect((await AgentDefinitionModel.findBySlug('qa-manager'))!.prompt_content).toBe('Mine.');
  });

  it('keeps an explicit "not set" front door through an upgrade and later boots', async() => {
    await seedBuiltinAgents([spec()]);
    const id = String(db.table.stored('qa-manager')!.id);
    await AgentDefinitionModel.update(id, { frontDoor: null }, undefined, publisher);
    expect((await seedBuiltinAgents([spec()])).unchanged).toBe(1);

    await seedBuiltinAgents([spec({ prompt: 'Version two.' })]);
    await seedBuiltinAgents([spec({ prompt: 'Version two.' })]);
    const row = await AgentDefinitionModel.findBySlug('qa-manager');
    expect(row!.prompt_content).toBe('Version two.');
    expect(row!.front_door).toBeNull();
    expect(row!.config[FRONT_DOOR_CHOSEN_KEY]).toBeNull();
  });

  describe('rows hashed by an earlier build', () => {
    it('refreshes a row with the pre-awareness hash and adopts the current hash', async() => {
      const originalContent = await legacySeeded(spec());
      db.table.write('qa-manager', { builtin_hash: BuiltinAgentHasher.hashManagedContentBeforeAgentAwareness(originalContent) });
      const next = spec({ prompt: 'Version two.' });

      const summary = await seedBuiltinAgents([next]);

      expect(summary.refreshed).toBe(1);
      const row = db.table.stored('qa-manager')!;
      expect(row.prompt_content).toBe('Version two.');
      expect(row.builtin_hash).toBe(BuiltinAgentHasher.hashManagedContent(renderBuiltinAgent(next, '/tmp/qa-home', GIT)));
    });

    it('leaves an older-hash row that differs from the bundle wholly unchanged on every boot, front door included', async() => {
      // Exactly what an earlier build seeded; the bundle has since moved on to a new prompt.
      await legacySeeded(spec());
      const before = db.table.stored('qa-manager')!;
      expect(String(before.builtin_hash)).toMatch(/^sha256:/);
      expect(before.front_door).toBeNull();
      const next = spec({ prompt: 'Version two.' });

      for (const boot of [1, 2]) {
        const summary = await seedBuiltinAgents([next]);
        expect({ boot, ...summary }).toMatchObject({ boot, kept: 1, refreshed: 0, adopted: 0, filled: 0, inserted: 0, errors: [] });
      }
      expect(db.table.updates).toHaveLength(0);
      expect(db.table.stored('qa-manager')).toEqual(before);
    });

    it('only re-stamps the hash of an older-hash row that already equals the bundle, then treats it as a normal row', async() => {
      await legacySeeded(spec(), { frontDoor: false });
      const before = db.table.stored('qa-manager')!;
      const summary = await seedBuiltinAgents([spec()]);
      expect(summary.adopted).toBe(1);
      expect(db.table.updates).toHaveLength(1);
      expect(Object.keys(db.table.updates[0].columns)).toEqual(['builtin_hash']);
      const { builtin_hash: restamped, updated_at: _updated, ...rest } = db.table.stored('qa-manager')!;
      const { builtin_hash: _old, updated_at: _before, ...restBefore } = before;
      expect(rest).toEqual(restBefore);
      expect(restamped).toBe(BuiltinAgentHasher.hashManagedContent(renderBuiltinAgent(spec(), '/tmp/qa-home', GIT)));

      // Second boot: nothing more to write.
      expect((await seedBuiltinAgents([spec()])).unchanged).toBe(1);
      expect(db.table.updates).toHaveLength(1);

      // A later bundle revision now upgrades it like any row this build seeded.
      expect((await seedBuiltinAgents([spec({ prompt: 'Version two.' })])).refreshed).toBe(1);
      expect(db.table.stored('qa-manager')!.prompt_content).toBe('Version two.');
    });

    it('keeps a human-edited older-hash row and does not fill its front door', async() => {
      await legacySeeded(spec());
      db.table.write('qa-manager', { when_to_call: 'Only for my team.' });
      const summary = await seedBuiltinAgents([spec({ prompt: 'Version two.' })]);
      expect(summary.kept).toBe(1);
      const row = db.table.stored('qa-manager')!;
      expect(row.prompt_content).toBe('Version one.');
      expect(row.when_to_call).toBe('Only for my team.');
      expect(row.front_door).toBeNull();
      expect(db.table.updates).toHaveLength(0);
    });

    it('keeps an older-hash row when the bundle changed its model and prompt', async() => {
      await legacySeeded(spec());
      const summary = await seedBuiltinAgents([spec({ prompt: 'Version two.', modelSlot: null, provider: 'claude-code', model: 'claude-opus-5-5' })]);
      expect(summary.kept).toBe(1);
      expect(db.table.stored('qa-manager')!.prompt_content).toBe('Version one.');
      expect(db.table.updates).toHaveLength(0);
    });
  });
});
