// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: { query: vi.fn(async() => []), queryOne: f.queryOne } }));
vi.mock('@pkg/agent/database/RedisClient', () => ({ redisClient: {} }));

import { AgentDefinitionModel } from '@pkg/agent/database/models/AgentDefinitionModel';
import { FRONT_DOOR_CHOSEN_KEY } from '@pkg/agent/builtinAgents/index';

const publisher = { announce() {} };

function dbRow(config: Record<string, unknown> = {}) {
  return {
    id: 'agent-1', slug: 'reviewer', name: 'Reviewer', description: '', system_prompt: '', soul_content: '',
    allowed_tools: [], skill_refs: [], routine_refs: [], model_priority: [], version: null, status: 'production', enabled: true,
    source_template_slug: null, content_hash: null, config, prompt_content: '', goals_content: '', prompt_files: {},
    provider: null, model: null, model_slot: null, model_choice: { mode: 'class', class: 'standard' }, source_kind: 'local',
    marketplace_template_id: null, marketplace_slug: null, marketplace_version: null, marketplace_author: null,
    when_to_call: '', when_not_to_call: '', send: '', returns: '', cost_tier: null, can_call: [], front_door: null,
    agent_awareness: true,
    is_builtin: true, builtin_hash: null, run_location: 'container', created_at: '2026-11-18T00:00:00.000Z', updated_at: '2026-11-18T00:00:00.000Z',
  };
}

function writtenConfigs(): Record<string, unknown>[] {
  return f.queryOne.mock.calls.flatMap(call => {
    const params = (call[1] ?? []) as unknown[];
    return params.flatMap(param => {
      if (typeof param !== 'string' || !param.startsWith('{')) return [];
      try {
        const parsed = JSON.parse(param) as Record<string, unknown>;
        return parsed && (FRONT_DOOR_CHOSEN_KEY in parsed || 'modelChoice' in parsed || 'role' in parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  });
}

beforeEach(() => {
  f.queryOne.mockReset();
  f.queryOne.mockImplementation(async() => dbRow());
});

describe('agent definition records an explicit null front door', () => {
  it('writes the marker for an explicit null and not for an omitted or boolean front door', async() => {
    await AgentDefinitionModel.create({ slug: 'reviewer', name: 'Reviewer', frontDoor: null, config: { role: 'review' } }, publisher);
    const [marked] = writtenConfigs();
    expect(FRONT_DOOR_CHOSEN_KEY).toBe('frontDoorChosen');
    expect(marked[FRONT_DOOR_CHOSEN_KEY]).toBe(null);
    expect(marked.role).toBe('review');
    expect(marked.modelChoice).toEqual({ mode: 'class', class: 'standard' });
    expect((f.queryOne.mock.calls[0][1] as unknown[]).at(-3)).toBe(null);

    f.queryOne.mockClear();
    await AgentDefinitionModel.create({ slug: 'reviewer', name: 'Reviewer', config: { role: 'review' } }, publisher);
    expect(writtenConfigs().some(config => FRONT_DOOR_CHOSEN_KEY in config)).toBe(false);

    f.queryOne.mockClear();
    await AgentDefinitionModel.create({ slug: 'reviewer', name: 'Reviewer', frontDoor: false, config: { role: 'review' } }, publisher);
    expect(writtenConfigs().some(config => FRONT_DOOR_CHOSEN_KEY in config)).toBe(false);
    expect((f.queryOne.mock.calls[0][1] as unknown[]).at(-3)).toBe(false);
  });

  it('stamps an editor save of null and keeps unrelated config', async() => {
    f.queryOne.mockImplementation(async() => dbRow({ role: 'review', front_door: false }));
    await AgentDefinitionModel.update('agent-1', { frontDoor: null, modelSlot: 'secondary', name: 'Reviewer' }, undefined, publisher);
    const [config] = writtenConfigs();
    expect(config[FRONT_DOOR_CHOSEN_KEY]).toBe(null);
    expect(config.role).toBe('review');
    expect(config.front_door).toBe(false);
    expect(config.modelChoice).toEqual({ mode: 'class', class: 'standard' });
  });

  it('keeps an existing explicit null when a later editor save rewrites the model class', async() => {
    f.queryOne.mockImplementation(async() => dbRow({ role: 'review', [FRONT_DOOR_CHOSEN_KEY]: null }));
    await AgentDefinitionModel.update('agent-1', {
      frontDoor: null, modelSlot: 'secondary', modelChoice: { mode: 'class', class: 'coding' },
    }, undefined, publisher);
    const [config] = writtenConfigs();
    expect(config[FRONT_DOOR_CHOSEN_KEY]).toBe(null);
    expect(config.role).toBe('review');
    expect(config.modelChoice).toEqual({ mode: 'class', class: 'coding' });
  });

  it('does not rewrite config when the explicit null is already stored and nothing else changes it', async() => {
    f.queryOne.mockImplementation(async() => dbRow({ role: 'review', [FRONT_DOOR_CHOSEN_KEY]: null }));
    await AgentDefinitionModel.update('agent-1', { frontDoor: null }, undefined, publisher);
    const update = f.queryOne.mock.calls.map(call => String(call[0])).find(sql => sql.includes('UPDATE'));
    expect(update).toBeTruthy();
    expect(update).not.toContain('config =');
    expect(writtenConfigs()).toEqual([]);
  });

  it('removes the marker when the editor saves a boolean front door', async() => {
    f.queryOne.mockImplementation(async() => dbRow({ role: 'review', [FRONT_DOOR_CHOSEN_KEY]: null }));
    await AgentDefinitionModel.update('agent-1', { frontDoor: true, modelSlot: 'secondary' }, undefined, publisher);
    const [config] = writtenConfigs();
    expect(config).not.toHaveProperty(FRONT_DOOR_CHOSEN_KEY);
    expect(config.role).toBe('review');
    expect(config.modelChoice).toEqual({ mode: 'class', class: 'standard' });
  });
});

describe('agent awareness persistence', () => {
  it('round-trips an explicit hidden setting through model create, read and update', async() => {
    // risk: worker privacy/context settings silently reset on editor save or reload.
    f.queryOne.mockImplementation(async(_sql: string, params: unknown[]) => ({ ...dbRow(), agent_awareness: params.at(-2) }));
    const created = await AgentDefinitionModel.create({ slug: 'reviewer', name: 'Reviewer', agentAwareness: false }, publisher);
    expect((f.queryOne.mock.calls[0][1] as unknown[]).at(-2)).toBe(false);
    expect(created.agent_awareness).toBe(false);

    f.queryOne.mockImplementation(async() => ({ ...dbRow(), agent_awareness: false }));
    await AgentDefinitionModel.update('agent-1', { agentAwareness: true }, undefined, publisher);
    const update = f.queryOne.mock.calls.map(call => String(call[0])).find(sql => sql.includes('UPDATE'));
    expect(update).toContain('agent_awareness =');
    expect((f.queryOne.mock.calls.find(call => String(call[0]).includes('UPDATE'))![1] as unknown[])[0]).toBe(true);
  });
});
