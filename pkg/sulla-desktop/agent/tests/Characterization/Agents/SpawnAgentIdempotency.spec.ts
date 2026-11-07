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

dbDescribe('spawn_agent idempotent structured output (real tool and repository)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let agentDefinitionService: typeof import('../../../services/AgentDefinitionService').agentDefinitionService;

  class PersistenceOnlySpawnHarness extends SpawnAgentWorker {
    protected taskRunner(): any { return { run: async() => new Promise(() => {}) }; }
  }

  class SpawnHarness extends SpawnAgentWorker {
    name = 'spawn_agent';
    schemaDef: any = {
      tasks: { type: 'array', items: { type: 'any' } },
      async: { type: 'boolean', optional: true },
      parallel: { type: 'boolean', optional: true },
    };

    constructor() { super(); this.allowVisibleTabs = true; }

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
    agentDefinitionService = (await import('../../../services/AgentDefinitionService')).agentDefinitionService;
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({
      slug: 'codex-sol-worker', name: 'Codex SOL Worker', enabled: true, status: 'active', run_location: 'vm',
    } as any);
  }, 60_000);

  afterAll(async() => database.dispose());

  const seed = async(parentThreadId: string, label: string, visibility: 'hidden' | 'tab') => registry.createJob([{
    agentId: 'codex-sol-worker', label, prompt: 'existing work', status: visibility === 'tab' ? 'running' : 'queued',
    threadId: visibility === 'tab' ? `${ label }-thread` : undefined, visibility,
  }], 'coding-manager-sol', parentThreadId, { visibility, parentAgentId: 'coding-manager-sol' });

  it('persists the production async routing identity before returning its real response shape', async() => {
    // risk: custody routing — replacement launch must not invent identity fields absent from spawn_agent output.
    const parent = `routing-${ Date.now() }`; const worker = new PersistenceOnlySpawnHarness();
    const response = await worker.runValidated({ tasks: [{ agentId: 'codex-sol-worker', label: 'routing', prompt: 'handoff' }], async: true, parallel: true, launchKey: `routing:${ parent }` }, { metadata: { wsChannel: 'manager-transport', threadId: parent, agentId: 'manager-identity' } });
    expect(response.successBoolean).toBe(true);
    expect(response.result).toEqual(expect.objectContaining({ mode: 'async', taskCount: 1, parallel: true }));
    expect(response.result).not.toEqual(expect.objectContaining({ channel: expect.anything(), agentId: expect.anything() }));
    const job = await registry.getJob(String((response.result as any).jobId));
    expect(job?.tasks[0]).toMatchObject({ agentConfigChannel: 'codex-sol-worker', agentId: 'codex-sol-worker', threadId: expect.stringMatching(/^spawn-agent-routing-/) });
    const { SpawnLeadLauncher } = await import('../../../app/Services/SpawnLeadLauncher');
    const { agentJobProvider } = await import('../../../app/Providers/AgentJobServiceProvider');
    const launch = await new SpawnLeadLauncher(agentJobProvider.jobs, () => new PersistenceOnlySpawnHarness()).launchReplacement({ oldJobId: 'old', oldTaskIndex: 0, agentId: 'codex-sol-worker', prompt: 'handoff', launchKey: `replacement:${ parent }`, owner: { channel: 'manager-transport', threadId: parent, agentId: 'manager-identity' } });
    expect(launch).toMatchObject({ channel: 'codex-sol-worker', agentId: 'codex-sol-worker', threadId: expect.stringMatching(/^spawn-agent-replacement-/) });
  });

  it('returns an object after one parse for hidden dedupe and sync dedupe', async() => {
    const parent = `hidden-${ Date.now() }`;
    const existing = await seed(parent, 'same-hidden', 'hidden');
    const hidden = await new SpawnHarness().run(parent, { tasks: [{ agentId: 'codex-sol-worker', label: 'same-hidden', prompt: 'retry' }] });
    expect(hidden.result).toMatchObject({ mode: 'async', jobId: existing.jobId, deduplicated: true }); // risk: CLI double encoding
    expect(typeof hidden.result).toBe('object');

    const sync = await new SpawnHarness().run(parent, { tasks: [{ agentId: 'codex-sol-worker', label: 'same-hidden', prompt: 'retry' }], async: false });
    expect(sync.result).toMatchObject({ mode: 'sync', jobId: existing.jobId, deduplicated: true });
  });

  it('deduplicates a tab before opening a new thread and includes tabs in mixed output', async() => {
    const parent = `tab-${ Date.now() }`;
    const existingTab = await seed(parent, 'same-tab', 'tab');
    const tab = await new SpawnHarness().run(parent, { tasks: [{ agentId: 'codex-sol-worker', label: 'same-tab', prompt: 'retry', visibility: 'tab' }] });
    expect(tab.result).toMatchObject({ mode: 'tab', jobId: existingTab.jobId, childThreadId: 'same-tab-thread' }); // risk: duplicate visible child
    expect((tab.result as any).tabs[0]).toMatchObject({ deduplicated: true, jobId: existingTab.jobId });

    const existingHidden = await seed(parent, 'same-mixed-hidden', 'hidden');
    const mixed = await new SpawnHarness().run(parent, { tasks: [
      { agentId: 'codex-sol-worker', label: 'same-tab', prompt: 'retry', visibility: 'tab' },
      { agentId: 'codex-sol-worker', label: 'same-mixed-hidden', prompt: 'retry' },
    ] });
    expect(mixed.result).toMatchObject({ mode: 'async', jobId: existingHidden.jobId }); // risk: mixed-mode tab metadata loss
    expect((mixed.result as any).tabs[0].jobId).toBe(existingTab.jobId);
  });
});
