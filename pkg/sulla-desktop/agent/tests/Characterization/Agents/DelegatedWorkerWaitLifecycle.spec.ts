// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestDatabase } from '../../Support/TestDatabase';
import { ReturnResultWorker } from '../../../tools/agents/return_result';
import { SpawnAgentWorker } from '../../../tools/agents/spawn_agent';
import { AgentWaitRequest } from '../../../services/AgentWaitRequest';
import { StopPrincipal } from '../../../app/ValueObjects/StopPrincipal';

vi.mock('../../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({ isInitialized: () => true, getPrimaryProvider: () => 'anthropic' }),
}));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('delegated worker durable wait lifecycle (real Postgres)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let GraphRegistry: typeof import('../../../services/GraphRegistry').GraphRegistry;
  let agentDefinitionService: typeof import('../../../services/AgentDefinitionService').agentDefinitionService;
  let lifecycle: typeof import('../../../services/AgentJobLifecycleService').agentJobLifecycle;
  let waits: typeof import('../../../services/AgentWaitServices').agentWaitProvider;

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
    GraphRegistry = (await import('../../../services/GraphRegistry')).GraphRegistry;
    agentDefinitionService = (await import('../../../services/AgentDefinitionService')).agentDefinitionService;
    lifecycle = (await import('../../../services/AgentJobLifecycleService')).agentJobLifecycle;
    waits = (await import('../../../services/AgentWaitServices')).agentWaitProvider;
  }, 60_000);
  afterAll(async() => database.dispose());
  afterEach(() => vi.restoreAllMocks());

  class SpawnHarness extends SpawnAgentWorker {
    runHarness(input: unknown) {
      this.setState({ metadata: { threadId: `wait-parent-${ Date.now() }`, wsChannel: 'sulla-desktop' } } as any);
      return this.runValidated(input as any);
    }
  }
  class ReturnHarness extends ReturnResultWorker {
    runHarness(threadId: string) { this.setState({ metadata: { threadId } } as any); return this._validatedCall({ result: { ok: true }, summary: 'done' }); }
  }

  const launch = async(execute: (state: any, threadId: string, call: number) => Promise<void>) => {
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ slug: 'codex-sol-worker', run_location: 'vm' } as any);
    let threadId = '';
    let calls = 0;
    const state: any = { metadata: { wsChannel: 'codex-sol-worker', options: {}, agent: {}, cycleComplete: false }, messages: [] };
    const graph = { execute: vi.fn(async() => {
      calls++;
      await execute(state, threadId, calls);
      state.metadata.cycleComplete = true;
      return state;
    }) };
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockImplementation((async(_channel: string, id: string) => {
      threadId = id;
      state.metadata.threadId = id;
      return { graph, state };
    }) as any);
    vi.spyOn(GraphRegistry, 'get').mockImplementation((id: string) => id === threadId ? { graph, state } as any : null);
    const response = JSON.parse((await new SpawnHarness().runHarness({
      tasks: [{ agentId: 'codex-sol-worker', label: 'waiter', prompt: 'wait repeatedly', contract: { name: 'wait-result', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false } } }], async: true,
    })).responseString!);
    return { jobId: response.jobId as string, graph, state, threadId: () => threadId };
  };

  it('parks and wakes twice on one thread, then completes without a reminder', async() => {
    // risk: a second long wait is mistaken for a missing contract and kills a healthy worker
    const run = await launch(async(state, threadId, call) => {
      if (call <= 2) {
        await waits.parking.park(state.metadata.delegatedJobId, 0, AgentWaitRequest.create(14_400, `park-${ call }`));
        state.messages.push({ role: 'assistant', content: `scheduled park ${ call }`, tool_calls: [{ name: 'agents/wait' }] });
        return;
      }
      const result = await new ReturnHarness().runHarness(threadId);
      expect(result.successBoolean).toBe(true);
      state.messages.push({ role: 'assistant', content: 'contract returned' });
    });

    for (let park = 1; park <= 2; park++) {
      await vi.waitFor(async() => expect((await waits.repository.pending(run.jobId, 0))?.reason).toBe(`park-${ park }`), { timeout: 2_000, interval: 10 });
      expect(await waits.repository.claim(run.jobId, 0)).not.toBeNull();
      lifecycle.wake(run.threadId());
    }
    await vi.waitFor(async() => expect((await registry.getJob(run.jobId))?.status).toBe('completed'), { timeout: 2_000, interval: 10 });
    expect(run.graph.execute).toHaveBeenCalledTimes(3);
    expect(run.state.messages.some((message: any) => String(message.content).includes('Return contract reminder'))).toBe(false);
  });

  it('wakes immediately for a manager message and makes the later timer a no-op', async() => {
    // risk: a manager message racing waiter registration starts a disconnected turn or permits a second timer wake
    const run = await launch(async(state, threadId, call) => {
      if (call === 1) {
        await waits.parking.park(state.metadata.delegatedJobId, 0, AgentWaitRequest.create(14_400, 'message-wait'));
        state.messages.push({ role: 'assistant', content: 'parked for manager', tool_calls: [{ name: 'agents/wait' }] });
        return;
      }
      expect(state.messages.some((message: any) => String(message.content).includes('manager says continue'))).toBe(true);
      await new ReturnHarness().runHarness(threadId);
      state.messages.push({ role: 'assistant', content: 'done after manager message' });
    });
    await vi.waitFor(async() => expect((await waits.repository.pending(run.jobId, 0))?.reason).toBe('message-wait'), { timeout: 2_000, interval: 10 });
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const backend = Object.create(BackendGraphWebSocketService.prototype) as BackendGraphWebSocketService;
    expect(await backend.wakeParkedAgent('codex-sol-worker', run.threadId(), 'manager says continue', 'codex-sol-worker')).toBe(true);
    await vi.waitFor(async() => expect((await registry.getJob(run.jobId))?.status).toBe('completed'), { timeout: 2_000, interval: 10 });
    expect(await waits.repository.claim(run.jobId, 0)).toBeNull();
    expect(run.graph.execute).toHaveBeenCalledTimes(2);
  });

  it('honours a wait scheduled during the reminder turn', async() => {
    // risk: reminderSent is treated as terminal even though the reminder turn explicitly parked
    const run = await launch(async(state, threadId, call) => {
      if (call === 1) { state.messages.push({ role: 'assistant', content: 'not ready yet' }); return; }
      if (call === 2) {
        await waits.parking.park(state.metadata.delegatedJobId, 0, AgentWaitRequest.create(14_400, 'reminder-wait'));
        state.messages.push({ role: 'assistant', content: 'waiting after reminder', tool_calls: [{ name: 'agents/wait' }] });
        return;
      }
      await new ReturnHarness().runHarness(threadId);
      state.messages.push({ role: 'assistant', content: 'done after reminder wait' });
    });
    await vi.waitFor(async() => expect((await waits.repository.pending(run.jobId, 0))?.reason).toBe('reminder-wait'), { timeout: 2_000, interval: 10 });
    await waits.repository.claim(run.jobId, 0);
    lifecycle.wake(run.threadId());
    await vi.waitFor(async() => expect((await registry.getJob(run.jobId))?.status).toBe('completed'), { timeout: 2_000, interval: 10 });
    expect(run.graph.execute).toHaveBeenCalledTimes(3);
  });

  it('cancels a scheduled wait when the task is stopped and never leaves it claimable', async() => {
    // risk: a stopped task is resurrected by its old timer
    const run = await launch(async(state, threadId) => {
      await waits.parking.park(state.metadata.delegatedJobId, 0, AgentWaitRequest.create(14_400, 'stop-me'));
      state.messages.push({ role: 'assistant', content: 'parked until stopped', tool_calls: [{ name: 'agents/wait' }] });
    });
    await vi.waitFor(async() => expect(await waits.repository.pending(run.jobId, 0)).not.toBeNull(), { timeout: 2_000, interval: 10 });
    registry.abortJob(run.jobId, StopPrincipal.system('DelegatedWorkerWaitLifecycleTest'), 'test stop');
    await vi.waitFor(async() => expect(await waits.repository.pending(run.jobId, 0)).toBeNull(), { timeout: 2_000, interval: 10 });
    expect(await waits.repository.claim(run.jobId, 0)).toBeNull();
  });

  it('sends exactly one reminder, then records the last assistant text in the typed failure', async() => {
    // risk: no-contract failures hide the worker's real last output behind a fabricated provider error
    const run = await launch(async(state, _threadId, call) => {
      state.messages.push({ role: 'assistant', content: call === 1 ? 'first ending' : 'last assistant explanation' });
    });
    await vi.waitFor(async() => expect((await registry.getJob(run.jobId))?.status).toBe('failed'), { timeout: 2_000, interval: 10 });
    const job = await registry.getJob(run.jobId);
    expect(run.graph.execute).toHaveBeenCalledTimes(2);
    expect(run.state.messages.filter((message: any) => String(message.content).includes('Return contract reminder'))).toHaveLength(1);
    expect(job?.tasks[0].completion?.output).toContain('missing_contract_after_reminder');
    expect(job?.tasks[0].completion?.output).toContain('last assistant explanation');
  });
});
