// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDefinitionTableFake } from '../../Support/AgentDefinitionTableFake';

import type { BuiltinAgentSpec } from '@pkg/agent/builtinAgents/index';
import { RETIRED_CODING_MANAGER_SLUGS } from '@pkg/agent/builtinAgents/index';
import { seedBuiltinAgents } from '@pkg/agent/builtinAgents/seedBuiltinAgents';
import { AgentDefinitionModel } from '@pkg/agent/database/models/AgentDefinitionModel';
import { AgentDefinitionService } from '@pkg/agent/services/AgentDefinitionService';

const f = vi.hoisted(() => ({
  table: null as unknown as AgentDefinitionTableFake,
  bindingRemovals: [] as unknown[][],
}));

vi.mock('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: {
    query:    (sql: string, params?: unknown[]) => f.table.query(sql, params),
    queryOne: (sql: string, params?: unknown[]) => f.table.queryOne(sql, params),
  },
}));
vi.mock('@pkg/agent/useCases/RedisUseCaseChangePublisherFactory', () => ({
  RedisUseCaseChangePublisherFactory: class { create() { return { announce() {} } } },
}));
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({
  workerModelRouting: {
    removeBindingForDefinition: vi.fn(async(...args: unknown[]) => { f.bindingRemovals.push(args) }),
  },
}));

function builtin(slug: string): BuiltinAgentSpec {
  return {
    slug,
    name:        slug,
    description: 'Manager fixture.',
    provider:    null,
    modelSlot:   'primary',
    card:        { whenToCall: 'when', whenNotToCall: 'not', send: 'send', returns: 'returns', costTier: 'high', canCall: ['*'] },
    config:      { role: 'lead' },
    prompt:      'Manage the work.',
  };
}

beforeEach(() => {
  f.table = new AgentDefinitionTableFake();
  f.bindingRemovals = [];
});

afterEach(() => vi.restoreAllMocks());

describe('retired long-tail Coding Managers', () => {
  it('archives every existing source row, removes its saved binding, and leaves coding-manager untouched', async() => {
    // risk: legacy/imported rows remain launchable or retain an AI Models route after retirement
    const primarySpec = builtin('coding-manager');
    await seedBuiltinAgents([primarySpec]);
    const primaryBefore = await AgentDefinitionModel.findBySlug('coding-manager');

    for (const slug of RETIRED_CODING_MANAGER_SLUGS) {
      await AgentDefinitionModel.create({
        slug,
        name:       slug,
        status:     'production',
        enabled:    true,
        sourceKind: slug === 'coding-manager-gpt' ? 'marketplace' : 'filesystem-import',
      });
    }
    f.bindingRemovals = [];

    const summary = await seedBuiltinAgents([
      ...RETIRED_CODING_MANAGER_SLUGS.map(builtin),
      primarySpec,
    ]);

    expect(summary.errors).toEqual([]);
    for (const slug of RETIRED_CODING_MANAGER_SLUGS) {
      const row = await AgentDefinitionModel.findBySlug(slug);
      expect(row).toMatchObject({ enabled: false, status: 'archive' });
      expect(f.table.stored(slug)).toBeDefined(); // retained, not deleted
    }
    expect(f.bindingRemovals).toEqual(RETIRED_CODING_MANAGER_SLUGS.map(slug => {
      const row = f.table.stored(slug)!;
      return [slug, row.id];
    }));

    const primaryAfter = await AgentDefinitionModel.findBySlug('coding-manager');
    expect(primaryAfter).toMatchObject({ enabled: true, status: 'production' });
    expect(primaryAfter!.updated_at).toBe(primaryBefore!.updated_at);
  });

  it('does not seed retired specs and refuses legacy-directory or service re-creation', async() => {
    // risk: a stale resource directory or a later seed silently recreates a retired manager
    const summary = await seedBuiltinAgents(RETIRED_CODING_MANAGER_SLUGS.map(builtin));
    expect(summary.errors).toEqual([]);
    for (const slug of RETIRED_CODING_MANAGER_SLUGS) expect(await AgentDefinitionModel.findBySlug(slug)).toBeNull();

    const directory = await mkdtemp(join(tmpdir(), 'retired-coding-managers-'));
    try {
      for (const slug of RETIRED_CODING_MANAGER_SLUGS) {
        const agentDirectory = join(directory, slug);
        await mkdir(agentDirectory);
        await writeFile(join(agentDirectory, 'config.yaml'), `name: ${ slug }\n`);
      }
      const imported = await new AgentDefinitionService().importLegacyDirectories([directory]);
      expect(imported).toMatchObject({ imported: 0, skipped: 3, errors: [] });
      for (const slug of RETIRED_CODING_MANAGER_SLUGS) expect(await AgentDefinitionModel.findBySlug(slug)).toBeNull();

      for (const slug of RETIRED_CODING_MANAGER_SLUGS) {
        expect(() => new AgentDefinitionService().create({ slug, name: slug })).toThrow('retired');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to re-enable or unarchive an existing retired row through the service', async() => {
    // risk: an archived long-tail definition becomes runnable from the ordinary edit/status path
    const slug = RETIRED_CODING_MANAGER_SLUGS[0];
    const row = await AgentDefinitionModel.create({ slug, name: slug, status: 'archive', enabled: false });
    const service = new AgentDefinitionService();

    await expect(service.update(row.id, { enabled: true })).rejects.toThrow('retired');
    await expect(service.setStatus(row.id, 'production')).rejects.toThrow('retired');
    expect(await AgentDefinitionModel.findBySlug(slug)).toMatchObject({ enabled: false, status: 'archive' });
  });
});
