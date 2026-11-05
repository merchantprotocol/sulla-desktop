// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';

import { tmpdir } from 'node:os';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';
import { AbortService } from '../../../services/AbortService';

// dispatchToAgent bails out before any of this if the model provider looks
// uninitialized (it waits up to 60s on the real service). Neither test below
// exercises that, so it is stubbed to let a VM-channel turn fall straight
// through to the fake graph.
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

dbDescribe('BackendGraphWebSocketService wakeParkedAgent busy guard (real Postgres)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let messaging: typeof import('../../../database/models/AgentJobMessagingModel');
  let BackendGraphWebSocketService: typeof import('../../../services/BackendGraphWebSocketService').BackendGraphWebSocketService;
  let GraphRegistry: typeof import('../../../services/GraphRegistry').GraphRegistry;
  let agentDefinitionService: typeof import('../../../services/AgentDefinitionService').agentDefinitionService;

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
    messaging = await import('../../../database/models/AgentJobMessagingModel');
    BackendGraphWebSocketService = (await import('../../../services/BackendGraphWebSocketService')).BackendGraphWebSocketService;
    GraphRegistry = (await import('../../../services/GraphRegistry')).GraphRegistry;
    agentDefinitionService = (await import('../../../services/AgentDefinitionService')).agentDefinitionService;
  }, 60_000);
  afterAll(async() => database.dispose());
  afterEach(() => vi.restoreAllMocks());

  /**
   * A bare, un-constructed instance — skips the constructor's initialize()
   * (WebSocket channel subscriptions, scheduler, completion-recovery sweep),
   * none of which this suite touches. Only the private fields dispatchToAgent
   * and wakeParkedAgent actually read on the VM-channel path are seeded.
   */
  function bareInstance(): InstanceType<typeof BackendGraphWebSocketService> {
    const instance = Object.create(BackendGraphWebSocketService.prototype);
    (instance as any).activeAborts = new Map();
    (instance as any).conversationContainers = new Map();
    (instance as any).resumeContexts = new Map();
    (instance as any).wsService = { send: () => undefined, connect: () => undefined, onMessage: () => undefined };
    return instance;
  }

  it('a) declines to dispatch while a live run already holds the thread, leaving its message queued', async() => {
    // risk: wakeParkedAgent dispatches unconditionally into a thread a live
    // run already holds — most often the manager itself is blocked inside
    // spawn_agent's in-process wait for its own children (DB status is
    // 'parked' the whole time that wait runs) — aborting that live run
    // out from under it instead of leaving the message for its next turn
    const channelId = 'sulla-desktop';
    const threadId = 'busy-guard-live-wait-thread';
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId, depth: 1 }],
      channelId, 'busy-guard-live-wait-root',
    );
    await registry.parkJobTask(manager.jobId, 0, 1); // DB-parked while "this process" still holds the thread below

    vi.spyOn(agentDefinitionService, 'findBySlug').mockImplementation(async(slug: string) =>
      (slug === 'coding-manager-sol' ? { slug, run_location: 'vm' } as any : null));

    const instance = bareInstance();
    const liveAbort = new AbortService();
    (instance as any).activeAborts.set(`${ channelId }|${ threadId }`, liveAbort);
    const dispatchSpy = vi.spyOn(instance as any, 'dispatchToAgent');

    const target = (await messaging.AgentJobMessagingModel.targetsForJob(manager.jobId))[0];
    const record = await messaging.AgentJobMessagingModel.queueMessage(target, 'continue');

    const woken = await instance.wakeParkedAgent(channelId, threadId, 'continue', 'coding-manager-sol', { jobMessageId: record.id, jobMessageThreadId: threadId });

    expect(woken).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(liveAbort.aborted).toBe(false);
    expect(await messaging.AgentJobMessagingModel.pendingMessagesForThread(threadId)).toHaveLength(1);
  });

  it('b) a dormant wake is not aborted by a second message mid-turn, which is delivered exactly once on the follow-up turn, and job status stays truthful throughout', async() => {
    // risk: (1) dispatchToAgent's own busy guard is the only thing standing
    // between a second orchestrator dispatch and aborting the first turn if
    // anything else ever races past wakeParkedAgent's own check; (2) a
    // message that arrives mid-turn and is declined is never redelivered,
    // stranding it forever; (3) the job is left lying 'running' or 'parked'
    // for longer than the turn that is actually executing
    const channelId = 'sulla-desktop';
    const threadId = 'busy-guard-dormant-wake-thread';
    const manager = await registry.createJob(
      [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId, depth: 1 }],
      channelId, 'busy-guard-dormant-wake-root',
    );
    await registry.parkJobTask(manager.jobId, 0, 1); // dormant: no live waiter in THIS process

    vi.spyOn(agentDefinitionService, 'findBySlug').mockImplementation(async(slug: string) =>
      (slug === 'coding-manager-sol' ? { slug, run_location: 'vm' } as any : null));

    const executeCalls: string[] = [];
    let releaseFirstExecute: (() => void) | undefined;
    const firstExecuteGate = new Promise<void>(resolve => { releaseFirstExecute = resolve });
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockImplementation(async() => ({
      graph: {
        execute: vi.fn(async() => {
          executeCalls.push(`call-${ executeCalls.length + 1 }`);
          if (executeCalls.length === 1) await firstExecuteGate;
        }),
      },
      state: { metadata: { threadId, wsChannel: channelId, options: {}, agent: {} }, messages: [] },
    } as any));

    const instance = bareInstance();
    const dispatchSpy = vi.spyOn(instance as any, 'dispatchToAgent');
    const abortKey = `${ channelId }|${ threadId }`;

    const target = (await messaging.AgentJobMessagingModel.targetsForJob(manager.jobId))[0];
    const firstRecord = await messaging.AgentJobMessagingModel.queueMessage(target, 'first message');

    // The dormant wake: no live run for this thread yet, so it actually
    // dispatches — left "in flight" on the paused gate below.
    const firstWakePromise = instance.wakeParkedAgent(channelId, threadId, 'first message', 'coding-manager-sol', { jobMessageId: firstRecord.id, jobMessageThreadId: threadId });

    await vi.waitFor(() => expect(executeCalls).toEqual(['call-1']), { timeout: 2_000, interval: 10 });
    expect(instance.hasActiveRun(channelId, threadId)).toBe(true);
    const abortDuringFirstRun = (instance as any).activeAborts.get(abortKey);
    expect(abortDuringFirstRun).toBeDefined();
    // Truthful for the turn's duration — not lying 'parked' while it executes.
    expect((await registry.getJob(manager.jobId))?.status).toBe('running');

    // A second message arrives mid-turn. send_job_message.ts always queues
    // before attempting delivery, so the row exists durably regardless of
    // what the dispatch attempt below does with it.
    const secondRecord = await messaging.AgentJobMessagingModel.queueMessage(target, 'second message');
    await (instance as any).dispatchToAgent(channelId, 'sulla-desktop', '[Message from orchestrator]\nsecond message', threadId, undefined, 'coding-manager-sol', 'system', {
      source: 'orchestrator_job_message', jobMessageId: secondRecord.id, jobMessageThreadId: threadId,
    });

    expect(executeCalls).toEqual(['call-1']); // the second dispatch never reached graph.execute
    expect(abortDuringFirstRun.aborted).toBe(false); // and never touched the first run's abort

    // Let the first turn finish.
    releaseFirstExecute!();
    await firstWakePromise;

    // Its finally block redelivers the still-pending second message as a
    // follow-up turn — wait for that follow-up's own graph.execute to settle.
    await vi.waitFor(() => expect(executeCalls).toEqual(['call-1', 'call-2']), { timeout: 2_000, interval: 10 });
    await vi.waitFor(() => expect(instance.hasActiveRun(channelId, threadId)).toBe(false), { timeout: 2_000, interval: 10 });

    expect(dispatchSpy).toHaveBeenCalledTimes(3); // first wake + the busy direct attempt + the follow-up
    expect((await registry.getJob(manager.jobId))?.status).toBe('parked'); // re-parked, not left 'running'
    expect(await messaging.AgentJobMessagingModel.pendingMessagesForThread(threadId)).toEqual([]); // both delivered, neither stranded or double-delivered
  });
});
