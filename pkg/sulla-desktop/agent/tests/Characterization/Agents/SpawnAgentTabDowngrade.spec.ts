// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestDatabase } from '../../Support/TestDatabase';
import { SpawnAgentWorker } from '../../../tools/agents/spawn_agent';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({ isInitialized: () => true, getPrimaryProvider: () => 'anthropic' }),
}));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('spawn_agent records a tab downgrade instead of hiding it (real tool and repository)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');

  // Visible tabs stay off (the production default): allowVisibleTabs is never set here.
  class SpawnHarness extends SpawnAgentWorker {
    name = 'spawn_agent';
    schemaDef: any = {
      tasks: { type: 'array', items: { type: 'any' } },
      async: { type: 'boolean', optional: true },
      parallel: { type: 'boolean', optional: true },
    };

    run(parentThreadId: string, input: unknown) {
      this.setState({ metadata: { threadId: parentThreadId, wsChannel: 'coding-manager-sol', routedAgentId: 'coding-manager-sol' } } as any);
      return this.call(input);
    }
  }

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    await database.applyMigrations();
    registry = await import('../../../tools/agents/jobRegistry');
    const { agentDefinitionService } = await import('../../../services/AgentDefinitionService');
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({
      slug: 'codex-sol-worker', name: 'Codex SOL Worker', enabled: true, status: 'active', run_location: 'vm',
    } as any);
  }, 60_000);

  afterAll(async() => database.dispose());

  it('downgrades a tab request to hidden with tab_launch_disabled on the response and the stored task', async() => {
    const parent = `downgrade-${ Date.now() }`; // risk: silent downgrade hides why a visible tab did not open
    const response = await new SpawnHarness().run(parent, {
      tasks: [{ agentId: 'codex-sol-worker', label: 'downgraded-tab', prompt: 'do the work', visibility: 'tab' }],
    });

    expect(response.successBoolean).toBe(true);
    expect(response.result).toMatchObject({
      taskVisibility: [{ index: 0, visibility: 'hidden', requestedVisibility: 'tab', downgradeReason: 'tab_launch_disabled' }],
    });

    const jobId = (response.result as { jobId: string }).jobId;
    const stored = await registry.getJob(jobId);
    expect(stored?.tasks[0]).toMatchObject({
      visibility: 'hidden', requestedVisibility: 'tab', downgradeReason: 'tab_launch_disabled',
    });
  });

  it('keeps a plain hidden spawn free of downgrade fields', async() => {
    const parent = `plain-${ Date.now() }`; // risk: false downgrade record on normal background work
    const response = await new SpawnHarness().run(parent, {
      tasks: [{ agentId: 'codex-sol-worker', label: 'plain-hidden', prompt: 'do the work' }],
    });

    expect(response.result).toMatchObject({ taskVisibility: [{ index: 0, visibility: 'hidden' }] });
    expect((response.result as { taskVisibility: Record<string, unknown>[] }).taskVisibility[0]).not.toHaveProperty('downgradeReason');
    const stored = await registry.getJob((response.result as { jobId: string }).jobId);
    expect(stored?.tasks[0]?.requestedVisibility).toBeUndefined();
  });
});
