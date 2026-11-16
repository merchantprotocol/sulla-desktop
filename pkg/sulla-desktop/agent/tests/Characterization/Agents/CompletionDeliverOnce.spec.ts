// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';

import { tmpdir } from 'node:os';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';
import { AbortService } from '../../../services/AbortService';

vi.mock('../../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({ isInitialized: () => true, getPrimaryProvider: () => 'anthropic' }),
}));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

/**
 * A finished child's result must reach its parent exactly once: never
 * re-handed after the parent's model already read it, and never dropped
 * when the parent was busy at the moment of delivery.
 */
dbDescribe('BackendGraphWebSocketService child result delivers once (real Postgres)', () => {
  const database = new TestDatabase();
  const channelId = 'sulla-desktop';
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let inbox: typeof import('../../../services/AgentCompletionInbox');
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
    inbox = await import('../../../services/AgentCompletionInbox');
    BackendGraphWebSocketService = (await import('../../../services/BackendGraphWebSocketService')).BackendGraphWebSocketService;
    GraphRegistry = (await import('../../../services/GraphRegistry')).GraphRegistry;
    agentDefinitionService = (await import('../../../services/AgentDefinitionService')).agentDefinitionService;
  }, 60_000);
  afterAll(async() => database.dispose());
  afterEach(() => vi.restoreAllMocks());

  function bareInstance(): InstanceType<typeof BackendGraphWebSocketService> {
    const instance = Object.create(BackendGraphWebSocketService.prototype);
    (instance as any).activeAborts = new Map();
    (instance as any).resumeContexts = new Map();
    (instance as any).wsService = { send: () => undefined, connect: () => undefined, onMessage: () => undefined };
    return instance;
  }

  async function finishedChild(parentThreadId: string, output: string) {
    const child = await registry.createJob(
      [{ agentId: 'opus-worker', label: 'worker', prompt: 'do it', status: 'running', threadId: `${ parentThreadId }-child`, depth: 2 }],
      channelId, parentThreadId,
    );
    const result = { label: 'worker', status: 'completed' as const, output, threadId: `${ parentThreadId }-child` };
    await registry.recordTaskCompletion(child.jobId, 0, result);
    return { jobId: child.jobId, entry: { jobId: child.jobId, taskIndex: 0, results: [result] } };
  }

  function fakeGraph(threadId: string, execute: (state: any) => Promise<void>) {
    vi.spyOn(agentDefinitionService, 'findBySlug').mockImplementation(async(slug: string) =>
      (slug === 'coding-manager-sol' ? { slug, run_location: 'vm' } as any : null));
    vi.spyOn(GraphRegistry, 'getOrCreateAgentGraph').mockImplementation(async() => {
      const state = { metadata: { threadId, wsChannel: channelId, options: {}, agent: {} }, messages: [] as any[] };
      return { graph: { execute: vi.fn(async() => execute(state)) }, state } as any;
    });
  }

  it('a) a result the parent model already answered is not re-delivered when the turn later fails', async() => {
    // risk: duplicate delivery — the turn read the child result, then a later model/tool step threw; the
    // result was released, requeued and re-dispatched to the parent as if it were new.
    const threadId = 'deliver-once-answered-then-failed';
    const { jobId, entry } = await finishedChild(threadId, 'PR #1 merged');
    fakeGraph(threadId, async(state) => {
      state.messages.push({ id: 'reply', role: 'assistant', content: 'Got the worker result, reviewing.' });
      throw new Error('provider exploded on the next model call');
    });

    const instance = bareInstance();
    const dispatchSpy = vi.spyOn(instance as any, 'dispatchToAgent');
    await (instance as any).dispatchToAgent(channelId, 'sulla-desktop', inbox.formatCompletionBatch([entry]), threadId, undefined, 'coding-manager-sol', 'system', {
      source: 'sub_agent_completion', completionEntries: [entry],
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1); // no follow-up turn re-handing the same result
    expect((await registry.getJob(jobId))?.tasks[0].completionDeliveredAt).toBeTruthy(); // durable ack kept
    expect(inbox.takeAgentCompletions(channelId, threadId)).toEqual([]);
  });

  it('b) a result the turn failed before any model reply is still handed back for another turn', async() => {
    // risk: data loss — the deliver-once guard must not swallow a result the parent never read.
    const threadId = 'deliver-once-failed-before-reply';
    const { jobId, entry } = await finishedChild(threadId, 'tests pass');
    let calls = 0;
    fakeGraph(threadId, async() => {
      calls++;
      if (calls === 1) throw new Error('provider unavailable');
    });

    const instance = bareInstance();
    const dispatchSpy = vi.spyOn(instance as any, 'dispatchToAgent');
    await (instance as any).dispatchToAgent(channelId, 'sulla-desktop', inbox.formatCompletionBatch([entry]), threadId, undefined, 'coding-manager-sol', 'system', {
      source: 'sub_agent_completion', completionEntries: [entry],
    });

    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 2_000, interval: 10 });
    await vi.waitFor(() => expect(instance.hasActiveRun(channelId, threadId)).toBe(false), { timeout: 2_000, interval: 10 });
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(dispatchSpy.mock.calls[1][7]).toMatchObject({ source: 'sub_agent_completion', completionEntries: [expect.objectContaining({ jobId })] });
    expect((await registry.getJob(jobId))?.tasks[0].completionDeliveredAt).toBeTruthy();
  });

  it('c) a result deferred because the parent is busy stays queued instead of being dropped', async() => {
    // risk: stranded result — the deferred path re-added an already-claimed entry with enqueue, which
    // treats it as a duplicate of its own claim and drops it; the recovery sweep is dropped the same way.
    const threadId = 'deliver-once-busy-parent';
    const { entry } = await finishedChild(threadId, 'blocked on review');
    fakeGraph(threadId, async() => undefined);
    inbox.enqueueAgentCompletion(channelId, threadId, entry);
    const claimed = inbox.takeAgentCompletions(channelId, threadId); // what handleCompletionWake does
    expect(claimed).toHaveLength(1);

    const instance = bareInstance();
    const liveAbort = new AbortService();
    (instance as any).activeAborts.set(`${ channelId }|${ threadId }`, liveAbort);
    const receipt = await (instance as any).dispatchToAgent(channelId, 'sulla-desktop', inbox.formatCompletionBatch(claimed), threadId, undefined, 'coding-manager-sol', 'system', {
      source: 'sub_agent_completion', completionEntries: claimed,
    });

    expect(receipt).toBe('deferred');
    expect(liveAbort.aborted).toBe(false);
    expect(inbox.takeAgentCompletions(channelId, threadId)).toEqual([expect.objectContaining({ jobId: entry.jobId, taskIndex: 0 })]);
  });
});
