// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelRouter, recommendedState } from '../../../languagemodels/modelRouter';
import { TestDatabase } from '../../Support/TestDatabase';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { SpawnAgentWorker } from '../../../tools/agents/spawn_agent';
import { toolDecisionPort } from '../../../tools/toolDecisionPort';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({ isInitialized: () => true, getPrimaryProvider: () => 'anthropic' }),
}));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('spawn_agent idempotent structured output (real tool and repository)', () => {
  const database = new TestDatabase();
  let settingsDirectory: string | undefined;
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let agentDefinitionService: typeof import('../../../services/AgentDefinitionService').agentDefinitionService;

  class SpawnHarness extends SpawnAgentWorker {
    name = 'spawn_agent';
    schemaDef: any = {
      tasks: { type: 'array', items: { type: 'any' } },
      async: { type: 'boolean', optional: true },
      parallel: { type: 'boolean', optional: true },
    };

    constructor() { super(); this.allowVisibleTabs = true; }

    run(parentThreadId: string, input: unknown, caller = 'coding-manager-sol') {
      this.setState({ metadata: { threadId: parentThreadId, wsChannel: caller, agentId: caller, routedAgentId: caller } } as any);
      return this.call(input);
    }
  }

  beforeAll(async() => {
    vi.spyOn(toolDecisionPort.resolve(), 'requiresApproval').mockResolvedValue(false);
    settingsDirectory = await mkdtemp(join(tmpdir(), 'sulla-spawn-qa-'));
    SullaSettingsModel.setFallbackFilePath(join(settingsDirectory, 'settings.json'));
    // This legacy-launch fixture has no owner-configured worker bindings.
    vi.spyOn(modelRouter, 'getEditableState').mockResolvedValue(recommendedState());
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
      id: 'worker-definition', slug: 'codex-sol-worker', name: 'Codex SOL Worker', enabled: true, status: 'active', run_location: 'vm',
    } as any);
  }, 60_000);

  afterAll(async() => {
    await database.dispose();
    if (settingsDirectory) await rm(settingsDirectory, { recursive: true, force: true });
  });

  const seed = async(parentThreadId: string, label: string, visibility: 'hidden' | 'tab') => registry.createJob([{
    agentId: 'codex-sol-worker', label, prompt: 'existing work', status: visibility === 'tab' ? 'running' : 'queued',
    threadId: visibility === 'tab' ? `${ label }-thread` : undefined, visibility,
  }], 'coding-manager-sol', parentThreadId, { visibility, parentAgentId: 'coding-manager-sol' });

  it('returns an object after one parse for hidden dedupe and sync dedupe', async() => {
    const parent = `hidden-${ Date.now() }`;
    const existing = await seed(parent, 'same-hidden', 'hidden');
    const hidden = await new SpawnHarness().run(parent, { tasks: [{ agentId: 'codex-sol-worker', label: 'same-hidden', prompt: 'retry' }] });
    expect(hidden.result, JSON.stringify(hidden)).toMatchObject({ mode: 'async', jobId: existing.jobId, deduplicated: true }); // risk: CLI double encoding
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

  it('captures a chat-specific route through the existing spawn and settlement path', async() => {
    const root = `workflow-chat-${Date.now()}`;
    const manager = `workflow-manager-${Date.now()}`;
    const sol = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'max' };
    const sonnet = { provider: 'claude-code', model: 'claude-sonnet', effort: 'high' };
    const { withWorkflowWrite } = await import('../../../services/WorkflowWriteAuthority');
    const { HiddenAgentTaskRunner } = await import('../../../services/HiddenAgentTaskRunner');
    const { AgentModelStatusRegistry } = await import('../../../services/AgentModelStatusRegistry');
    const { productOwnerWorkflow } = await import('../../../services/ProductOwnerWorkflow');
    const findAgent = vi.mocked(agentDefinitionService.findBySlug);
    const restore = findAgent.getMockImplementation()!;
    findAgent.mockImplementation(async(slug) => ({
      id: `def-${slug}`, slug, enabled: true, status: 'production', can_call: [], run_location: 'vm',
    } as any));
    const runner = vi.spyOn(HiddenAgentTaskRunner.prototype, 'run').mockImplementation(async(input) => {
      AgentModelStatusRegistry.recordResponse(input.threadId, [{ ...sonnet, source: 'resolved' }]);
      return { status: 'completed', label: input.task.label, output: 'Fixture completed', threadId: input.threadId };
    });
    try {
      await registry.createJob([{
        agentId: 'coding-manager', label: 'Build', prompt: 'feature', workflowStep: 'build', status: 'running', threadId: manager,
      }], 'account-manager', root, { parentAgentId: 'account-manager' });
      const prior = await registry.createJob([{
        agentId: 'codex-sol-worker', label: 'Already assigned', prompt: 'keep this job', status: 'running',
      }], 'coding-manager', manager, { dedupeLabel: 'Already assigned', parentAgentId: 'coding-manager' });
      await withWorkflowWrite(() => SullaSettingsModel.set(`productOwnerWorkflow.${root}.implementation`, {
        revision: 'workflow-acceptance', agentSlug: 'sonnet-worker', agentId: 'def-sonnet-worker', candidates: [sol, sonnet],
        binding: { agentId: 'def-sonnet-worker', editToken: 'workflow-acceptance', revision: 1, candidates: [sol, sonnet], connections: { codex: 'existing', 'claude-code': 'existing' } },
      }, 'json'));

      const spawn = (label: string) => new SpawnHarness().run(manager, { async: false, tasks: [{
        agentId: 'codex-sol-worker', workflowStep: 'implementation', label, prompt: 'Implement export',
      }] }, 'coding-manager');
      const retried = await spawn('Already assigned');
      expect(retried.result).toMatchObject({ jobId: prior.jobId, deduplicated: true });
      expect(runner).not.toHaveBeenCalled();
      expect((await registry.getJob(prior.jobId))?.tasks[0]).toMatchObject({ agentId: 'codex-sol-worker', status: 'running' });

      const launched = await spawn('Next assignment');
      expect(launched.success, launched.error).toBe(true);
      expect(runner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        task: expect.objectContaining({ agentId: 'sonnet-worker', workflowStep: 'implementation', workerModelRoute: expect.objectContaining({ candidates: [sol, sonnet], editToken: 'workflow-acceptance' }) }),
      }));
      const rows = await productOwnerWorkflow.readWorkflowHistory(root);
      expect(rows.find(row => row.label === 'Next assignment')).toMatchObject({ agentId: 'sonnet-worker', state: 'done', responseModels: [{ ...sonnet, source: 'resolved' }] });
    } finally {
      runner.mockRestore();
      findAgent.mockImplementation(restore);
    }
  });
});
