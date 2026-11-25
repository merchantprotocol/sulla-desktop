// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDefinitionTableFake } from '../../Support/AgentDefinitionTableFake';

const db = vi.hoisted(() => ({ table: null as unknown as AgentDefinitionTableFake }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: {
    query:    (sql: string, params?: unknown[]) => db.table.query(sql, params),
    queryOne: (sql: string, params?: unknown[]) => db.table.queryOne(sql, params),
  },
}));
vi.mock('@pkg/agent/database/RedisClient', () => ({ redisClient: {} }));
vi.mock('@pkg/agent/useCases/RedisUseCaseChangePublisherFactory', () => ({
  RedisUseCaseChangePublisherFactory: class { create() { return { announce() {} } } },
}));

import { AgentDefinitionModel } from '@pkg/agent/database/models/AgentDefinitionModel';
import { AgentDefinitionService } from '@pkg/agent/services/AgentDefinitionService';

beforeEach(() => { db.table = new AgentDefinitionTableFake() });

describe('agent awareness definition persistence', () => {
  it('round-trips the setting through the real model and manifest service', async() => {
    // risk: a Files export/import or model reload silently turns workers back on.
    const service = new AgentDefinitionService();
    const created = await AgentDefinitionModel.create({ slug: 'codex-luna-worker', name: 'Luna worker', agentAwareness: false });
    expect(created.agent_awareness).toBe(false);
    expect((await AgentDefinitionModel.findBySlug(created.slug))?.agent_awareness).toBe(false);

    const manifest = service.toManifest(created);
    expect(manifest.spec.agentAwareness).toBe(false);
    const imported = await service.importManifest({
      ...manifest,
      metadata: { ...manifest.metadata, slug: 'copied-worker', title: 'Copied worker' },
    });
    expect(imported.agent_awareness).toBe(false);
    expect((await AgentDefinitionModel.findBySlug('copied-worker'))?.agent_awareness).toBe(false);
  });

  it('defaults legacy and new definitions to visible until they explicitly opt out', async() => {
    // risk: managers lose their existing team context because older manifests omit the field.
    const service = new AgentDefinitionService();
    const imported = await service.importManifest({
      apiVersion: 'sulla/v3', kind: 'Agent', manifestVersion: 1,
      metadata: { slug: 'legacy-lead', title: 'Legacy lead', description: '', version: '1.0.0' },
      spec: { prompt: 'Manage the work.', tools: [], skills: [], config: {}, promptFiles: {} },
    });
    expect(imported.agent_awareness).toBe(true);
  });
});
