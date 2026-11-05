// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';

import { tmpdir } from 'node:os';

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

// GraphRegistry pulls in the real tool catalog (`../tools/manifests`), which
// transitively imports AgentContainerLauncher.ts's top-level `import Electron
// from 'electron'`. Outside the Electron runtime that throws ("Electron
// failed to install correctly") the moment the module loads, matching the
// convention backgroundHandoff.spec.ts already uses.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

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
    runHarness(threadId: string, wsChannel: string, input: unknown) {
      this.setState({ metadata: { threadId, wsChannel } } as any);
      return this.runValidated(input as any);
    }
  }

  class ReturnResultHarness extends ReturnResultWorker {
    runHarness(threadId: string, input: unknown) {
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
    (instance as any).resumeContexts = new Map();
    (instance as any).wsService = { send: vi.fn() };
    return instance;
  }

  it('redelivers an ordinary completion after graph execution fails, then acknowledges it exactly once after success', async() => {
    // risk: ordinary dispatch acknowledges a child completion before the graph
    // consumes it, so an exception loses the only durable wake permanently.
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ slug: 'coding-manager-sol', run_location: 'vm' } as any);
    const childThread = `ordinary-ack-child-${ Date.now() }`;
    const parentThread = `ordinary-ack-parent-${ Date.now() }`;
    const child = await registry.createJob(
      [{ agentId: 'codex-sol-worker', label: 'child', prompt: 'work', status: 'running', threadId: childThread }],
      'coding-manager-sol', parentThread,
    );
    const result = { label: 'child', status: 'completed' as const, output: 'done', threadId: childThread };
    await registry.recordTaskCompletion(child.jobId, 0, result);
    const completion = { jobId: child.jobId, taskIndex: 0, results: [result] };
    const state: any = {
      metadata: { options: {}, agent: { runLocation: 'vm' }, cycleComplete: false },
      messages: [], llmTools: [], nodeHistory: [],
    };
    let executions = 0;
    const graph = { execute: vi.fn(async() => {
      executions++;
      if (executions === 1) throw new Error('fail before consuming completion');
      state.metadata.cycleComplete = true;
      return state;
    }) };
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockResolvedValue({ graph, state } as any);
    vi.spyOn(GraphRegistry, 'get').mockReturnValue({ graph, state } as any);
    const delivered = vi.spyOn(registry, 'markTaskCompletionDelivered');
    const service = bareInstance();

    await (service as any).dispatchToAgent(
      'coding-manager-sol', 'sulla-desktop', 'child finished', parentThread,
      undefined, 'coding-manager-sol', 'system',
      { source: 'sub_agent_completion', completionEntries: [completion] },
    );

    await vi.waitFor(() => expect(graph.execute).toHaveBeenCalledTimes(2), { timeout: 2_000, interval: 10 });
    await vi.waitFor(async() => expect((await registry.getJob(child.jobId))?.tasks[0].completionDeliveredAt).toEqual(expect.any(Number)), { timeout: 2_000, interval: 10 });
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledWith(child.jobId, 0);
    expect(state.messages.filter((message: any) => message.metadata?.source === 'sub_agent_completion')).toHaveLength(2);
  });

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
    const workerThreadIds = ['in-process-wake-worker-0', 'in-process-wake-worker-1'];
    const fakeState: any = { metadata: { wsChannel: 'coding-manager-sol', options: {}, agent: {}, cycleComplete: false }, messages: [] };
    const executeCalls: number[] = [];
    const fakeGraph = {
      execute: vi.fn(async() => {
        // Match Graph.execute's real stale-cycle behavior. Without the
        // production fresh-turn preparer, a wake returns immediately here.
        if (fakeState.metadata.cycleComplete) return fakeState;
        executeCalls.push(executeCalls.length + 1);
        if (executeCalls.length === 1) {
          // The manager's own first turn: spawns an async worker (its own
          // nested spawn_agent call, modeled directly through the registry
          // the same way it would land) and ends its turn without returning
          // its own contract — the exact shape the blocker describes.
          const worker = await registry.createJob(
            workerThreadIds.map((threadId, index) => ({ agentId: 'codex-sol-worker', label: `worker-${ index }`, prompt: 'build', status: 'running', threadId, depth: 2 })),
            'coding-manager-sol', managerThreadId,
          );
          workerJobId = worker.jobId;
          fakeState.metadata.cycleComplete = true;
          return fakeState;
        }
        // The first child wake is a real follow-up turn, then the manager
        // parks again while its sibling remains open. The second wake returns
        // the manager's own contract.
        fakeState.metadata.cycleComplete = true;
        if (executeCalls.length === 2) {
          fakeState.messages.push({ role: 'assistant', content: 'worker 0 acknowledged; waiting for worker 1' });
          return fakeState;
        }
        const rr = new ReturnResultHarness();
        const result = await rr.runHarness(managerThreadId, { result: { ok: true }, summary: 'epic done' });
        if (!result.successBoolean) throw new Error(`return_result failed: ${ result.responseString }`);
        fakeState.metadata.cycleComplete = true;
        return fakeState;
      }),
    };
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockImplementation((async(_channel: string, threadId: string) => {
      managerThreadId = threadId;
      fakeState.metadata.threadId = threadId;
      return { graph: fakeGraph, state: fakeState };
    }) as any);
    vi.spyOn(GraphRegistry, 'get').mockImplementation((threadId: string) =>
      (threadId === managerThreadId ? { graph: fakeGraph, state: fakeState } as any : null));

    const spawn = new SpawnHarness();
    const launch = JSON.parse((await spawn.runHarness('grandparent-root-thread', 'sulla-desktop', {
      tasks: [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic' }],
      async: true,
    })).responseString!);
    expect(launch.mode).toBe('async');
    const managerJobId = launch.jobId as string;

    // The manager's first turn ran and parked in-process waiting on its child.
    await vi.waitFor(() => expect(executeCalls).toEqual([1]), { timeout: 2_000, interval: 10 });
    await vi.waitFor(() => expect(agentJobLifecycle.hasLiveWaiter(managerThreadId)).toBe(true), { timeout: 2_000, interval: 10 });
    expect((await registry.getJob(managerJobId))?.status).toBe('parked');

    // Task zero settles while task one remains open: per-task delivery wakes
    // immediately and must not wait for the sibling.
    const firstResult = { label: 'worker-0', status: 'completed' as const, output: 'built-0', threadId: workerThreadIds[0] };
    await registry.recordTaskCompletion(workerJobId, 0, firstResult);
    expect(await jobDelivery.wakeParentGraph('coding-manager-sol', managerThreadId, workerJobId, [firstResult], undefined, 0)).toBe(true);

    // Simulate the idle-dispatcher firing (instead of waiting its real 2s
    // coalesce timer) — the exact method the real constructor wires to the
    // completion inbox.
    const service = bareInstance();
    (service as any).handleCompletionWake('coding-manager-sol', managerThreadId);

    // The manager's own in-process loop resumed and ran its second turn
    // itself — not a disconnected dispatchToAgent turn.
    await vi.waitFor(() => expect(executeCalls).toEqual([1, 2]), { timeout: 2_000, interval: 10 });
    await vi.waitFor(() => expect(agentJobLifecycle.hasLiveWaiter(managerThreadId)).toBe(true), { timeout: 2_000, interval: 10 });
    expect((await registry.getJob(managerJobId))?.status).toBe('parked');

    // Task one settles later and causes a distinct second follow-up turn.
    const secondResult = { label: 'worker-1', status: 'completed' as const, output: 'built-1', threadId: workerThreadIds[1] };
    await registry.recordTaskCompletion(workerJobId, 1, secondResult);
    await registry.completeJob(workerJobId, [firstResult, secondResult]);
    expect(await jobDelivery.wakeParentGraph('coding-manager-sol', managerThreadId, workerJobId, [secondResult], undefined, 1)).toBe(true);
    (service as any).handleCompletionWake('coding-manager-sol', managerThreadId);
    await vi.waitFor(() => expect(executeCalls).toEqual([1, 2, 3]), { timeout: 2_000, interval: 10 });

    // The injected completion content actually reached the manager's own
    // live state before its second turn ran.
    expect(fakeState.messages.filter((m: any) => typeof m.content === 'string' && m.content.includes(workerJobId))).toHaveLength(2);
    expect(fakeState.messages.some((m: any) => typeof m.content === 'string' && m.content.includes('built-0'))).toBe(true);
    expect(fakeState.messages.some((m: any) => typeof m.content === 'string' && m.content.includes('built-1'))).toBe(true);

    // The waiter is gone — released exactly once, not leaked.
    expect(agentJobLifecycle.hasLiveWaiter(managerThreadId)).toBe(false);

    // The manager's OWN job reaches 'completed' — driven by the grandparent's
    // own spawn_agent executeAll().then() handler once its while loop exits,
    // not stranded inside the still-blocked Promise.
    await vi.waitFor(async() => expect((await registry.getJob(managerJobId))?.status).toBe('completed'), { timeout: 2_000, interval: 10 });

    // The grandparent (the manager's own parent thread) receives exactly one
    // completion for the manager's job — not zero (stranded) and not two
    // (double-delivered by both the old and new paths). completeJob (awaited
    // above via the status check) and the inbox enqueue are two separate
    // awaits further down the same executeAll().then() chain, so the enqueue
    // can still be a few microtask ticks behind the status flip.
    const grandparentCompletions = await vi.waitFor(() => {
      const completions = inbox.takeAgentCompletions('sulla-desktop', 'grandparent-root-thread');
      expect(completions.map(c => c.jobId)).toEqual([managerJobId]);
      return completions;
    }, { timeout: 2_000, interval: 10 });

    expect((await registry.getJob(workerJobId))?.tasks.map((task: any) => Boolean(task.completionDeliveredAt))).toEqual([true, true]);
    expect((await registry.getJob(managerJobId))?.error).toBeFalsy();
    expect(fakeGraph.execute).toHaveBeenCalledTimes(3);
  });

  it('reports a specific internal lifecycle error when a completion wake is still unconsumed after its retry', async() => {
    // risk: a stale/no-op wake is mislabeled as a provider failure, hiding the
    // job and completion input needed to diagnose the lifecycle defect.
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ slug: 'coding-manager-sol', run_location: 'vm' } as any);
    let managerThreadId = '';
    let workerJobId = '';
    const fakeState: any = { metadata: { wsChannel: 'coding-manager-sol', options: {}, agent: {}, cycleComplete: false }, messages: [] };
    let realTurns = 0;
    const fakeGraph = {
      execute: vi.fn(async() => {
        if (fakeState.metadata.cycleComplete) return fakeState;
        realTurns++;
        if (realTurns === 1) {
          const worker = await registry.createJob(
            [{ agentId: 'codex-sol-worker', label: 'worker', prompt: 'build', status: 'running', threadId: 'o13-worker', depth: 2 }],
            'coding-manager-sol', managerThreadId,
          );
          workerJobId = worker.jobId;
        }
        fakeState.metadata.cycleComplete = true;
        return fakeState;
      }),
    };
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockImplementation((async(_channel: string, threadId: string) => {
      managerThreadId = threadId;
      fakeState.metadata.threadId = threadId;
      return { graph: fakeGraph, state: fakeState };
    }) as any);
    vi.spyOn(GraphRegistry, 'get').mockImplementation((threadId: string) =>
      (threadId === managerThreadId ? { graph: fakeGraph, state: fakeState } as any : null));

    const launch = JSON.parse((await new SpawnHarness().runHarness('o13-parent', 'sulla-desktop', {
      tasks: [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic' }], async: true,
    })).responseString!);
    await vi.waitFor(() => expect(agentJobLifecycle.hasLiveWaiter(managerThreadId)).toBe(true), { timeout: 2_000, interval: 10 });

    const result = { label: 'worker', status: 'completed' as const, output: 'built', threadId: 'o13-worker' };
    await registry.recordTaskCompletion(workerJobId, 0, result);
    await registry.completeJob(workerJobId, [result]);
    await jobDelivery.wakeParentGraph('coding-manager-sol', managerThreadId, workerJobId, [result], undefined, 0);
    (bareInstance() as any).handleCompletionWake('coding-manager-sol', managerThreadId);

    await vi.waitFor(async() => {
      const job = await registry.getJob(launch.jobId);
      expect(job?.status).toBe('failed');
    }, { timeout: 2_000, interval: 10 });
    const failed = await registry.getJob(launch.jobId);
    expect(failed?.error).toContain(`job=${ launch.jobId }`);
    expect(failed?.error).toContain('wake=sub_agent_completion');
    expect(failed?.error).toContain(`unconsumedCompletionJobs=${ workerJobId }`);
    expect(failed?.error).not.toContain('Worker stopped before answering');
  });

  it('routes the real settleTask path above a manager that becomes terminal before its child settles', async() => {
    // risk: production settleTask bypasses orphan classification and wakes a
    // terminal manager even though compatibility delivery tests pass.
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ slug: 'codex-sol-worker', run_location: 'vm' } as any);
    const managerThreadId = 'real-settle-orphan-manager';
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own', status: 'running', threadId: managerThreadId, depth: 1 }],
      'sulla-desktop', 'real-settle-orphan-root',
    );
    let release!: () => void;
    const runGate = new Promise<void>(resolve => { release = resolve; });
    const childState: any = {
      metadata: { wsChannel: 'codex-sol-worker', options: {}, agent: {} },
      messages: [],
    };
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockResolvedValue({
      graph: { execute: vi.fn(async() => {
        await runGate;
        childState.messages.push({ role: 'assistant', content: 'built through real spawn path' });
        return childState;
      }) },
      state: childState,
    } as any);

    const spawn = new SpawnHarness();
    const launch = JSON.parse((await spawn.runHarness(managerThreadId, 'coding-manager-sol', {
      tasks: [{ agentId: 'codex-sol-worker', label: 'late real worker', prompt: 'build' }],
      async: true,
    })).responseString!);
    await registry.completeJob(manager.jobId, [{ label: 'manager', status: 'completed', output: 'finished early', threadId: managerThreadId }]);
    release();

    await vi.waitFor(async() => expect((await registry.getJob(launch.jobId))?.status).toBe('completed'), { timeout: 2_000, interval: 10 });
    const root = await vi.waitFor(() => {
      const notices = inbox.takeAgentCompletions('sulla-desktop', 'real-settle-orphan-root');
      expect(notices).toHaveLength(1);
      return notices;
    }, { timeout: 2_000, interval: 10 });
    expect(root[0]).toMatchObject({ jobId: launch.jobId, taskIndex: 0, failureReason: expect.stringContaining('orphaned child result') });
    expect(inbox.takeAgentCompletions('coding-manager-sol', managerThreadId)).toEqual([]);
    expect((await registry.getJob(manager.jobId))?.status).toBe('completed');
    expect((await registry.getJob(manager.jobId))?.orphanedChildNotices).toHaveLength(1);
  });
});
