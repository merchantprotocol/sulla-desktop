// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';
import { AgentWakeScheduler } from '../../../services/AgentWakeScheduler';
import { BaseNode } from '../../../nodes/BaseNode';
import { ModelDispatchService } from '../../../languagemodels/ModelDispatchService';
import { ModelRouter, recommendedState, modelRouter } from '../../../languagemodels/modelRouter';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { withWorkerBindingWrite } from '../../../languagemodels/workerBindingAuthority';
import { cleanAgentModelTiers } from '../../../languagemodels/agentModelTiers';
import { installWorkerRoute, workerModelRouting } from '../../../services/WorkerModelRouting';
import { previewAgentModel } from '../../../services/ModelLaunchPreview';
import type { BaseThreadState } from '../../../nodes/Graph';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: async(slug: string) => ({ id: 'tester-id', slug, enabled: true, status: 'production', model_choice: { mode: 'class', class: 'frontier' } }) } }));
vi.mock('../../../nodes/ThreadStateStore', () => ({ saveThreadState: async() => {} }));
vi.mock('../../../languagemodels', () => ({
  PROVIDER_FACTORIES: { codex: {} }, modelRouteService: { resolve: vi.fn() },
  getServiceByProvider: async(provider: string, model: string, effort: string) => ({
    getModel: () => model, getProviderId: () => provider, getEffort: () => effort,
    chat: async() => ({ content: 'fixture reply from ' + model }),
  }),
}));

class Probe extends BaseNode {
  constructor() { super('test', 'test') }
  async execute(state: BaseThreadState) { return { state, decision: { type: 'end' as const } } as any }
  resolve(state: BaseThreadState) { return this.resolveLoopProvider(state) }
}

const A = { provider: 'codex', model: 'model-a', effort: 'low' };
const B = { provider: 'codex', model: 'model-b', effort: 'high' };
const marker = 'checkpoint-after-step-3';
const ownStage = process.env.SULLA_TIER_SPEC_STAGE;
const suite = ownStage || TestDatabase.available() || process.env.CI ? describe : describe.skip;

suite('model tiers, parking and restart', () => {
  if (!ownStage) {
    it('resumes the same inherited worker once across processes and routes new work through the edited settings', async() => {
      const dir = await mkdtemp(join(tmpdir(), 'worker-tier-restart-'));
      try {
        const receipts = [];
        for (const stage of ['park', 'resume']) {
          const env = { ...process.env, SULLA_TEST_DATABASE_URL: '', SULLA_TIER_DB: process.env.SULLA_TEST_DATABASE_URL, SULLA_TIER_SPEC_DIR: dir, SULLA_TIER_SPEC_STAGE: stage, SULLA_DATABASE_URL: process.env.SULLA_TEST_DATABASE_URL, SULLA_DATABASE_POOL_MAX: '1', SULLA_TIER_PARENT_SCHEMA: process.env.SULLA_TEST_SCHEMA };
          await promisify(execFile)(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.agent.config.mts', '--pool=forks', 'WorkerModelTiersRestart.spec.ts'], { env, timeout: 60_000, maxBuffer: 4_000_000 });
          receipts.push(JSON.parse(await readFile(join(dir, stage + '.json'), 'utf8')));
        }
        expect(receipts[0].pid).not.toBe(receipts[1].pid);
        expect(receipts[1]).toMatchObject({ jobId: receipts[0].jobId, resumed: A.model, next: B.model, delivered: 1, marker });
      } finally { await rm(dir, { recursive: true, force: true }) }
    }, 130_000);
    return;
  }

  it('exercises the owned ' + ownStage + ' process', async() => {
    const schema = process.env.SULLA_TIER_PARENT_SCHEMA!;
    if (!/^spec_worker_[a-f0-9]{32}$/.test(schema)) throw new Error('Expected the parent test’s isolated schema');
    const dir = process.env.SULLA_TIER_SPEC_DIR!;
    process.env.SULLA_TEST_SCHEMA = schema;
    process.env.SULLA_TEST_DATABASE_URL = process.env.SULLA_TIER_DB!;
    const db = new TestDatabase();
    await db.initialize();
    process.env.SULLA_DATABASE_URL = db.appUrl();
    process.env.PGOPTIONS = '-csearch_path=' + schema + ',public';
    const { postgresClient } = await import('../../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query('SET search_path TO "' + schema + '", public');
    expect((await postgresClient.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
    const { createJob, getJob } = await import('../../../tools/agents/jobRegistry');
    const { agentWaitProvider } = await import('../../../services/AgentWaitServices');
    const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
    const { getServiceByProvider, modelRouteService } = await import('../../../languagemodels');
    // Stand-ins are restricted to settings I/O, account/catalog discovery and model transport.
    // Jobs, progress, parking, competing claims, rehydration and route selection are production paths.
    const settingsPath = join(dir, 'settings.json');
    vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(key, fallback) => key === 'modelRouting' ? JSON.parse(await readFile(settingsPath, 'utf8')) : fallback);
    vi.spyOn(SullaSettingsModel, 'set').mockImplementation(async(key, value) => {
      if (key === 'modelRouting') await writeFile(settingsPath, JSON.stringify(value));
    });
    const models = [A, B].map(row => ({ id: row.model, efforts: [{ id: row.effort }] }));
    const router = new ModelRouter(() => ({ getAvailableProviders: async() => [{ id: 'codex', connected: true }], getModelsForProvider: async() => models }));
    vi.spyOn(modelRouter, 'getEditableState').mockImplementation(() => router.getEditableState());
    vi.spyOn(modelRouter, 'providerInfo').mockImplementation(() => router.providerInfo());
    vi.spyOn(modelRouter, 'resolve').mockImplementation(router.resolve.bind(router));
    vi.spyOn(modelRouter, 'checkInheritedResume').mockImplementation(candidate => router.checkInheritedResume(candidate));
    vi.spyOn(workerModelRouting, 'subscriptionConnections').mockResolvedValue({ codex: 'test-subscription' });
    const dispatch = new ModelDispatchService(router.resolve.bind(router), getServiceByProvider);
    vi.mocked(modelRouteService.resolve).mockImplementation(dispatch.resolve.bind(dispatch));
    const threadId = 'tier-parked-worker';
    const state = (id: string, jobId: string): BaseThreadState => ({ messages: [], metadata: {
      agentId: 'tester', threadId: id, delegatedJobId: jobId, delegatedTaskIndex: 0, delegatedGeneration: 1,
    } } as any);
    const schedulers: AgentWakeScheduler[] = [];
    try {
      if (ownStage === 'park') {
        const settings = recommendedState();
        settings.classes.frontier = [B];
        await writeFile(settingsPath, JSON.stringify(settings));
        expect(await workerModelRouting.newRoute('tester')).toBeUndefined();
        expect((await router.resolve('agents', { mode: 'class', class: 'frontier' }))[0]).toEqual(B);
        await router.set({ classes: { ...settings.classes, frontier: [A] } });
        expect(await workerModelRouting.newRoute('tester')).toBeUndefined();
        const job = await createJob([{ agentId: 'tester', threadId, label: 'test', status: 'running', prompt: 'test' }]);
        const provider = await new Probe().resolve(state(threadId, job.jobId));
        expect(provider.getModel()).toBe(A.model);
        expect((await getJob(job.jobId))?.tasks[0].inheritedModel).toEqual(A);
        // Park on a real wait with the progress marker. Prevent this first process from delivering it.
        await agentWaitProvider.parking.park(job.jobId, 0, { wakeAt: new Date(Date.now() + 60_000), reason: marker } as any);
        agentWaitProvider.scheduler.stop();
        const modelTiers = cleanAgentModelTiers({ version: 1, tiers: [{ candidates: [B] }] });
        await withWorkerBindingWrite(() => router.replaceWorkerBinding('tester', 'tester-id', { token: '', revision: 0 },
          { candidates: [B], modelTiers, connections: { codex: 'test-subscription' }, editToken: 'test-edit' }));
        await writeFile(join(dir, 'park.json'), JSON.stringify({ pid: process.pid, jobId: job.jobId }));
      } else {
        const { jobId } = JSON.parse(await readFile(join(dir, 'park.json'), 'utf8'));
        const deliveries: string[] = [];
        const claims = vi.spyOn(agentWaitProvider.repository, 'claim');
        const wake = async() => {
          const identity = await parkedAgentRehydrator.resolve(threadId);
          expect(identity?.job.jobId).toBe(jobId);
          expect(identity?.task.waitReason).toBe(marker);
          const resumed = state(threadId, jobId);
          parkedAgentRehydrator.apply(resumed, identity!);
          const provider = await new Probe().resolve(resumed);
          expect(await provider.chat([])).toMatchObject({ content: 'fixture reply from ' + A.model });
          deliveries.push(provider.getModel());
        };
        for (let i = 0; i < 2; i++) schedulers.push(new AgentWakeScheduler(agentWaitProvider.repository, wake, () => Date.now() + 120_000));
        await Promise.all(schedulers.map(scheduler => scheduler.start()));
        await vi.waitFor(() => { expect(claims).toHaveBeenCalledTimes(2); expect(deliveries).toEqual([A.model]) });
        expect(await agentWaitProvider.repository.pending(jobId, 0)).toBeNull();
        const preview = await previewAgentModel({ agentId: 'tester-id', slug: 'tester' });
        expect(preview).toMatchObject({ status: 'ready', candidates: [B] });
        const route = await workerModelRouting.newRoute('tester');
        expect(route?.candidates).toEqual([B]);
        const fresh = await createJob([{ agentId: 'tester', threadId: 'tier-new-worker', label: 'new', status: 'running', prompt: 'test', workerModelRoute: route }]);
        expect(fresh.jobId).not.toBe(jobId);
        const newState = state('tier-new-worker', fresh.jobId);
        installWorkerRoute(newState, route, { jobId: fresh.jobId, taskIndex: 0 });
        const next = await new Probe().resolve(newState);
        expect(await next.chat([])).toMatchObject({ content: 'fixture reply from ' + B.model });
        await writeFile(join(dir, 'resume.json'), JSON.stringify({ pid: process.pid, jobId, marker, resumed: deliveries[0], next: next.getModel(), delivered: deliveries.length }));
      }
    } finally {
      for (const scheduler of schedulers) scheduler.stop();
      agentWaitProvider.scheduler.stop();
      await postgresClient.end(); await db.dispose();
    }
  });
});
