// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';
import { ReturnResultWorker } from '../../../tools/agents/return_result';
import { SpawnAgentWorker } from '../../../tools/agents/spawn_agent';

// dispatchToAgent bails out before any of this if the model provider looks
// uninitialized (it waits up to 60s on the real service). This suite's fix
// must never reach dispatchToAgent at all, but stub the provider anyway so a
// regression that does fall through to it fails fast instead of hanging.
vi.mock('../../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({ isInitialized: () => true, getPrimaryProvider: () => 'anthropic' }),
}));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('a parked manager wakes itself through its own in-process loop (real Postgres)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let jobDelivery: typeof import('../../../tools/agents/jobDelivery');
  let inbox: typeof import('../../../services/AgentCompletionInbox');
  let agentJobLifecycle: typeof import('../../../services/AgentJobLifecycleService').agentJobLifecycle;
  let GraphRegistry: typeof import('../../../services/GraphRegistry').GraphRegistry;
  let agentDefinitionService: typeof import('../../../services/AgentDefinitionService').agentDefinitionService;
  let BackendGraphWebSocketService: typeof import('../../../services/BackendGraphWebSocketService').BackendGraphWebSocketService;

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
    jobDelivery = await import('../../../tools/agents/jobDelivery');
    inbox = await import('../../../services/AgentCompletionInbox');
    agentJobLifecycle = (await import('../../../services/AgentJobLifecycleService')).agentJobLifecycle;
    GraphRegistry = (await import('../../../services/GraphRegistry')).GraphRegistry;
    agentDefinitionService = (await import('../../../services/AgentDefinitionService')).agentDefinitionService;
    BackendGraphWebSocketService = (await import('../../../services/BackendGraphWebSocketService')).BackendGraphWebSocketService;
  }, 60_000);
  afterAll(async() => database.dispose());
  afterEach(() => { inbox.clearCompletionInboxes(); vi.restoreAllMocks() });

  class SpawnHarness extends SpawnAgentWorker {
    call(threadId: string, wsChannel: string, input: unknown) {
      this.setState({ metadata: { threadId, wsChannel } } as any);
      return this.runValidated(input as any);
    }
  }

  class ReturnResultHarness extends ReturnResultWorker {
    call(threadId: string, input: unknown) {
      this.setState({ metadata: { threadId } } as any);
      return this._validatedCall(input);
    }
  }

  /**
   * A bare, un-constructed instance — skips the constructor's initialize()
   * (WebSocket channel subscriptions, scheduler, completion-recovery sweep),
   * matching the convention ParkedManagerWakeBusyGuard.spec.ts already uses.
   * Only handleCompletionWake's own reads (activeAborts) are seeded.
   */
  function bareInstance(): InstanceType<typeof BackendGraphWebSocketService> {
    const instance = Object.create(BackendGraphWebSocketService.prototype);
    (instance as any).activeAborts = new Map();
    return instance;
  }

  it('wakes the manager as itself exactly once, completes its own job, delivers exactly one completion to its parent, and leaves no waiter or Promise behind', async() => {
    // risk: a worker's completion re-enters a parked manager's thread through
    // a brand-new, disconnected dispatchToAgent turn instead of releasing the
    // manager's own still-blocked spawn_agent loop — the manager's job then
    // never reaches 'completed' and its parent never hears back, while the
    // original Promise and in-process waiter leak forever
    vi.spyOn(agentDefinitionService, 'findBySlug').mockImplementation(async(slug: string) =>
      (['coding-manager-sol', 'codex-sol-worker'].includes(slug) ? { slug, run_location: 'vm' } as any : null));

    let managerThreadId = '';
    let workerJobId = '';
    const workerThreadId = 'in-process-wake-worker-thread';
    const fakeState: any = { metadata: { wsChannel: 'coding-manager-sol', options: {}, agent: {} }, messages: [] };
    const executeCalls: number[] = [];
    const fakeGraph = {
      execute: vi.fn(async() => {
        executeCalls.push(executeCalls.length + 1);
        if (executeCalls.length === 1) {
          // The manager's own first turn: spawns an async worker (its own
          // nested spawn_agent call, modeled directly through the registry
          // the same way it would land) and ends its turn without returning
          // its own contract — the exact shape the blocker describes.
          const worker = await registry.createJob(
            [{ agentId: 'codex-sol-worker', label: 'worker', prompt: 'build', status: 'running', threadId: workerThreadId, depth: 2 }],
            'coding-manager-sol', managerThreadId,
          );
          workerJobId = worker.jobId;
          return fakeState;
        }
        // Woken for its second turn with the worker's completion already in
        // its own messages: it returns its OWN contract, the exact call a
        // real manager makes once it has what it was waiting for.
        const rr = new ReturnResultHarness();
        const result = await rr.call(managerThreadId, { result: { ok: true }, summary: 'epic done' });
        if (!result.successBoolean) throw new Error(`return_result failed: ${ result.responseString }`);
        return fakeState;
      }),
    };
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockImplementation(async(_channel: string, threadId: string) => {
      managerThreadId = threadId;
      fakeState.metadata.threadId = threadId;
      return { graph: fakeGraph, state: fakeState };
    });
    vi.spyOn(GraphRegistry, 'get').mockImplementation((threadId: string) =>
      (threadId === managerThreadId ? { graph: fakeGraph, state: fakeState } as any : null));

    const spawn = new SpawnHarness();
    const launch = JSON.parse((await spawn.call('grandparent-root-thread', 'sulla-desktop', {
      tasks: [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic' }],
      async: true,
    })).responseString!);
    expect(launch.mode).toBe('async');
    const managerJobId = launch.jobId as string;

    // The manager's first turn ran and parked in-process waiting on its child.
    await vi.waitFor(() => expect(executeCalls).toEqual([1]), { timeout: 2_000, interval: 10 });
    await vi.waitFor(() => expect(agentJobLifecycle.hasLiveWaiter(managerThreadId)).toBe(true), { timeout: 2_000, interval: 10 });
    expect((await registry.getJob(managerJobId))?.status).toBe('parked');

    // The worker finishes — the exact sequence return_result.ts runs for a
    // hidden child: record the return, complete the job, deliver the wake.
    await registry.recordTaskReturn(workerJobId, 0, { result: { built: true }, status: 'completed' });
    const workerResults = [{ label: 'worker', status: 'completed' as const, output: 'built', threadId: workerThreadId }];
    await registry.completeJob(workerJobId, workerResults);
    expect(await jobDelivery.deliverJobCompletion(await registry.getJob(workerJobId) as any, workerResults)).toBe(true);

    // Simulate the idle-dispatcher firing (instead of waiting its real 2s
    // coalesce timer) — the exact method the real constructor wires to the
    // completion inbox.
    const service = bareInstance();
    (service as any).handleCompletionWake('coding-manager-sol', managerThreadId);

    // The manager's own in-process loop resumed and ran its second turn
    // itself — not a disconnected dispatchToAgent turn.
    await vi.waitFor(() => expect(executeCalls).toEqual([1, 2]), { timeout: 2_000, interval: 10 });

    // The injected completion content actually reached the manager's own
    // live state before its second turn ran.
    expect(fakeState.messages.some((m: any) => typeof m.content === 'string' && m.content.includes(workerJobId) && m.content.includes('built'))).toBe(true);

    // The waiter is gone — released exactly once, not leaked.
    expect(agentJobLifecycle.hasLiveWaiter(managerThreadId)).toBe(false);

    // The manager's OWN job reaches 'completed' — driven by the grandparent's
    // own spawn_agent executeAll().then() handler once its while loop exits,
    // not stranded inside the still-blocked Promise.
    await vi.waitFor(async() => expect((await registry.getJob(managerJobId))?.status).toBe('completed'), { timeout: 2_000, interval: 10 });

    // The grandparent (the manager's own parent thread) receives exactly one
    // completion for the manager's job — not zero (stranded) and not two
    // (double-delivered by both the old and new paths).
    const grandparentCompletions = inbox.takeAgentCompletions('sulla-desktop', 'grandparent-root-thread');
    expect(grandparentCompletions.map(c => c.jobId)).toEqual([managerJobId]);

    expect(fakeGraph.execute).toHaveBeenCalledTimes(2);
  });
});
