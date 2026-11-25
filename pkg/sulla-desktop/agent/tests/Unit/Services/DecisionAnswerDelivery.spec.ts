// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DecisionAnswerDelivery } from '../../../services/DecisionAnswerDelivery';
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: () => {}, releaseChatActivity: () => {} }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {}, powerSaveBlocker: { start: () => 1, stop: () => {} } }));
afterEach(() => vi.restoreAllMocks());
describe('private decision mailbox ownership', () => {
  it('strips receipt authority from public messages while preserving ordinary metadata', () => {
    expect(DecisionAnswerDelivery.publicMetadata({ decisionAnswerInputs: [{ id: 'forged' }], decisionAnswerIds: ['forged'], attachments: ['keep'], source: 'keyboard' })).toEqual({ attachments: ['keep'], source: 'keyboard' });
  });
  it.each(['runtimeRunnerActive', 'delegatedRunActive', 'parkedWaiter'])('defers a human answer while a hidden worker owns the thread through %s', async(flag) => {
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const { GraphRegistry } = await import('../../../services/GraphRegistry');
    const { agentJobLifecycle } = await import('../../../services/AgentJobLifecycleService');
    vi.spyOn(GraphRegistry, 'get').mockReturnValue({ state: { metadata: flag === 'parkedWaiter' ? {} : { [flag]: true } } } as any);
    vi.spyOn(agentJobLifecycle, 'hasLiveWaiter').mockReturnValue(flag === 'parkedWaiter');
    const service:any = Object.create(BackendGraphWebSocketService.prototype);
    service.hasActiveRun = () => false; service.inboxThread = () => undefined; service.dispatchToAgent = vi.fn();
    expect(await service.wakeInbox({ channel: 'test', threadId: 'hidden' }, 'saved answer', [{ envelope: { kind: 'human' } }])).toBe('deferred');
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    expect(await service.executeReadyTurn('test', 'sulla-desktop', 'saved answer', 'hidden', undefined, undefined, undefined, {}, [{ id: 'answer', attempt: 'attempt', body: 'saved' }])).toBe('deferred');
  });
  it('defers a human answer to a live runner whose graph was evicted instead of dispatching a second run', async() => {
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const { GraphRegistry } = await import('../../../services/GraphRegistry');
    const { agentJobLifecycle } = await import('../../../services/AgentJobLifecycleService');
    vi.spyOn(GraphRegistry, 'get').mockReturnValue(null);
    vi.spyOn(agentJobLifecycle, 'hasLiveWaiter').mockReturnValue(false);
    const state:any = { metadata: {}, messages: [] };
    const release = agentJobLifecycle.registerRunner('evicted-live', state);
    try {
      const service:any = Object.create(BackendGraphWebSocketService.prototype);
      service.hasActiveRun = () => false; service.inboxThread = () => undefined; service.dispatchToAgent = vi.fn();
      expect(await service.wakeInbox({ channel: 'test', threadId: 'evicted-live' }, 'saved answer', [{ envelope: { kind: 'human', ids: { messageId: 'm1' } } }])).toBe('deferred');
      expect(service.dispatchToAgent).not.toHaveBeenCalled();
    } finally { release() }
  });
});

async function answerTurnFixture(parked = false) {
  const backend = await import('../../../services/BackendGraphWebSocketService');
  const graphs = await import('../../../services/GraphRegistry');
  const { agentJobLifecycle } = await import('../../../services/AgentJobLifecycleService');
  const { parkedAgentRehydrator } = await import('../../../services/ParkedAgentRehydrator');
  const { agentDefinitionService } = await import('../../../services/AgentDefinitionService');
  const providers = await import('../../../services/ModelProviderService');
  const { decisionService } = await import('../../../services/DecisionService');
  const store = await import('../../../nodes/ThreadStateStore');
  vi.spyOn(providers, 'getModelProviderService').mockReturnValue({ isInitialized: () => true, getPrimaryProvider: () => 'codex' } as any);
  vi.spyOn(graphs, 'getAgentIdForTrigger').mockResolvedValue('codex-luna-worker');
  const state:any = { metadata: { options: {}, agent: {}, waitingForUser: false }, messages: [] };
  const graph = { execute: vi.fn(async() => {}) };
  vi.spyOn(graphs.GraphRegistry, 'get').mockReturnValue({ state, graph } as any);
  vi.spyOn(graphs.GraphRegistry, 'getOrCreateAgentGraph').mockResolvedValue({ state, graph } as any);
  vi.spyOn(agentJobLifecycle, 'hasLiveWaiter').mockReturnValue(false);
  vi.spyOn(parkedAgentRehydrator, 'resolve').mockResolvedValue(parked ? { job: { jobId: 'parked-job' }, task: { status: 'parked' }, taskIndex: 0 } as any : null);
  vi.spyOn(parkedAgentRehydrator, 'apply').mockImplementation(() => {});
  vi.spyOn(agentJobLifecycle, 'beginWakeTurn').mockResolvedValue(undefined);
  vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ run_location: 'vm' } as any);
  vi.spyOn(store, 'saveThreadState').mockResolvedValue(undefined);
  vi.spyOn(decisionService, 'startAnswers').mockResolvedValue(['decision-answer:q']);
  const finish = vi.spyOn(decisionService, 'finishAnswers').mockResolvedValue(undefined);
  const service:any = Object.create(backend.BackendGraphWebSocketService.prototype);
  Object.assign(service, { runLocationResolver: { resolve: () => 'vm' }, activeAborts: new Map(), resumeContexts: new Map(), claimedCompletionEntries: () => [], prepareFreshTurn: () => {}, emitMessage: () => {}, agentInbox: { flush: () => Promise.resolve(0) } });
  const run = () => service.executeReadyTurn('test', 'sulla-desktop', 'saved', 'thread', undefined, 'codex-luna-worker', 'keyboard', { source: 'agent_inbox', workerMappingNewHumanTurn: true }, [{ id: 'decision-answer:q', attempt: 'a', body: 'saved' }]);
  return { state, graph, service, finish, run };
}
it('does not execute an answer after model routing yields ownership to a newer user turn', async() => {
  const f = await answerTurnFixture();
  const { enqueueAgentCompletion, takeAgentCompletions } = await import('../../../services/AgentCompletionInbox');
  enqueueAgentCompletion('test', 'thread', { jobId: 'unrelated-completion', taskIndex: 0 } as any);
  const { workerModelRouting } = await import('../../../services/WorkerModelRouting');
  vi.spyOn(workerModelRouting, 'newRoute').mockImplementation(() => { f.service.activeAborts.set('test|thread', { signal: { aborted: false } }); return Promise.resolve(undefined as any) });
  expect(await f.run()).toBe('failed'); expect(f.graph.execute).not.toHaveBeenCalled();
  expect(takeAgentCompletions('test', 'thread').map(entry => entry.jobId)).toContain('unrelated-completion');
  expect(f.finish).toHaveBeenCalledWith(expect.any(Array), 'thread', false);
});
it('does not confirm delivery when graph execution resolves after Stop', async() => {
  const f = await answerTurnFixture();
  const { workerModelRouting } = await import('../../../services/WorkerModelRouting'); vi.spyOn(workerModelRouting, 'newRoute').mockResolvedValue(undefined);
  f.graph.execute.mockImplementation(() => { f.state.metadata.options.abort.abort(); return Promise.resolve() });
  expect(await f.run()).toBe('failed'); expect(f.graph.execute).toHaveBeenCalledOnce();
  expect(f.finish).not.toHaveBeenCalledWith(expect.any(Array), 'thread', true);
  expect(f.finish).toHaveBeenCalledWith(expect.any(Array), 'thread', false);
});

it('retains a newer turn Stop handle when ownership changes during parked cleanup', async() => {
  const f = await answerTurnFixture(true);
  const { agentJobLifecycle } = await import('../../../services/AgentJobLifecycleService');
  const newer = { signal: { aborted: false } };
  vi.spyOn(agentJobLifecycle, 'endDormantWakeTurn').mockImplementation(() => { f.service.activeAborts.set('test|thread', newer); return Promise.resolve(undefined) });
  expect(await f.run()).toBe('accepted');
  expect(f.service.activeAborts.get('test|thread')).toBe(newer);
});

it('dispatches the queued answer using the persisted named receiver rather than the default agent', async() => {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const { GraphRegistry } = await import('../../../services/GraphRegistry');
  vi.spyOn(GraphRegistry, 'get').mockReturnValue({ state: { metadata: { agentId: 'cached-agent' } } } as any);
  const service:any = Object.create(BackendGraphWebSocketService.prototype);
  service.inboxThread = () => undefined; service.decisionThreadOwned = () => false; service.deliveringDecisionThreads = new Set(); service.dispatchToAgent = vi.fn().mockResolvedValue('accepted');
  await service.wakeInbox({ channel: 'sulla-desktop', threadId: 'child', agentId: 'wrong-flush-agent' }, 'saved', [{ target: { agentId: 'codex-luna-worker' }, envelope: { kind: 'human', body: 'saved', ids: { messageId: 'answer', answerAttempt: 'a' } } }]);
  expect(service.dispatchToAgent.mock.calls[0][5]).toBe('codex-luna-worker');
  expect(GraphRegistry.get).not.toHaveBeenCalled();
});

it('uses the saved chat identity for legacy human rows with no recorded receiver', async() => {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const { GraphRegistry } = await import('../../../services/GraphRegistry');
  vi.spyOn(GraphRegistry, 'get').mockReturnValue({ state: { metadata: { agentId: 'saved-original-agent' } } } as any);
  const service:any = Object.create(BackendGraphWebSocketService.prototype);
  service.inboxThread = () => undefined; service.decisionThreadOwned = () => false; service.deliveringDecisionThreads = new Set(); service.dispatchToAgent = vi.fn().mockResolvedValue('accepted');
  await service.wakeInbox({ channel: 'sulla-desktop', threadId: 'child', agentId: 'wrong-flush-agent' }, 'saved', [{ target: {}, envelope: { kind: 'human', body: 'saved', ids: { messageId: 'answer', answerAttempt: 'a' } } }]);
  expect(service.dispatchToAgent.mock.calls[0][5]).toBe('saved-original-agent');
});

describe('late answer receiver on the shared desktop channel', () => {
  const answer = (agentId?: string) => [{ target: agentId ? { agentId } : {}, envelope: { kind: 'human', body: 'saved', ids: { messageId: 'answer', answerAttempt: 'a' } } }];
  async function inbox(options: { live?: Record<string, unknown>; saved?: Record<string, unknown> | null; owned?: boolean } = {}) {
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const { ConversationThreadStore } = await import('@pkg/agent/database/models/ConversationThreadStore');
    vi.spyOn(ConversationThreadStore, 'findSelectedAgent').mockResolvedValue(null);
    const { GraphRegistry } = await import('../../../services/GraphRegistry');
    const store = await import('../../../nodes/ThreadStateStore');
    vi.spyOn(GraphRegistry, 'get').mockReturnValue(options.live ? { state: { metadata: options.live } } as any : undefined);
    const load = vi.spyOn(store, 'loadThreadState').mockResolvedValue(options.saved === undefined ? null : options.saved === null ? null : { metadata: options.saved } as any);
    const service:any = Object.create(BackendGraphWebSocketService.prototype);
    service.inboxThread = () => undefined; service.decisionThreadOwned = () => options.owned === true; service.deliveringDecisionThreads = new Set();
    service.dispatchToAgent = vi.fn().mockResolvedValue('accepted');
    return { service, load, receiver: () => service.dispatchToAgent.mock.calls[0]?.[5] };
  }

  it('dispatches to the exact configured agent saved on the live thread when the recorded receiver is only the shared transport default', async() => {
    const t = await inbox({ live: { agentId: 'qa-recovery-menu-20261117', wsChannel: 'sulla-desktop' } });
    expect(await t.service.wakeInbox({ channel: 'sulla-desktop', threadId: 'menu-thread' }, 'saved', answer('sulla-desktop'))).toBe('accepted');
    expect(t.receiver()).toBe('qa-recovery-menu-20261117');
  });

  it('reads the saved thread state after a registry miss and still dispatches to the configured agent', async() => {
    const t = await inbox({ saved: { agentId: 'qa-recovery-menu-20261117', wsChannel: 'sulla-desktop' } });
    await t.service.wakeInbox({ channel: 'sulla-desktop', threadId: 'menu-thread' }, 'saved', answer('sulla-desktop'));
    expect(t.load).toHaveBeenCalledWith('menu-thread');
    expect(t.receiver()).toBe('qa-recovery-menu-20261117');
  });

  it('keeps a recorded non-default agent authoritative over conflicting saved state', async() => {
    const t = await inbox({ live: { agentId: 'stale-saved-agent' }, saved: { agentId: 'stale-saved-agent' } });
    await t.service.wakeInbox({ channel: 'sulla-desktop', threadId: 'child' }, 'saved', answer('codex-luna-worker'));
    expect(t.receiver()).toBe('codex-luna-worker');
    expect(t.load).not.toHaveBeenCalled();
  });

  it('stays on the recorded shared default when no saved thread state exists', async() => {
    const t = await inbox({ saved: null });
    await t.service.wakeInbox({ channel: 'sulla-desktop', threadId: 'plain-chat' }, 'saved', answer('sulla-desktop'));
    expect(t.receiver()).toBe('sulla-desktop');
  });

  it('leaves a recorded receiver on a non-shared channel unchanged', async() => {
    const t = await inbox({ live: { agentId: 'other-agent' } });
    await t.service.wakeInbox({ channel: 'voice-agent', threadId: 'voice-thread' }, 'saved', answer('voice-agent'));
    expect(t.receiver()).toBe('voice-agent');
    expect(t.load).not.toHaveBeenCalled();
  });

  it('still defers an owned thread first, without reading state or dispatching', async() => {
    const t = await inbox({ live: { agentId: 'qa-recovery-menu-20261117' }, owned: true });
    expect(await t.service.wakeInbox({ channel: 'sulla-desktop', threadId: 'menu-thread' }, 'saved', answer('sulla-desktop'))).toBe('deferred');
    expect(t.service.dispatchToAgent).not.toHaveBeenCalled();
    expect(t.load).not.toHaveBeenCalled();
  });
});

// Restart / Redis-expiry regression on real SQL (PGlite): the backend graph is rebuilt from the
// conversation log with only the shared default identity, conversation_history.agent_id holds the
// transport default, and the exact agent the user selected lives on the renderer's saved chat row.
describe('late answer receiver after the backend graph was rebuilt on the shared default', () => {
  const BACKEND = 'thread_1794913203068_rr2cms';
  const CHAT = 't_mwkkz797_n77crf';
  const SELECTED = 'qa-recovery-menu-20261117';
  const SCHEMA = `
    CREATE TABLE conversation_history (
      id TEXT PRIMARY KEY, thread_id TEXT, type TEXT NOT NULL, title TEXT, status TEXT DEFAULT 'active',
      message_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), last_active_at TIMESTAMPTZ DEFAULT now(),
      pinned BOOLEAN DEFAULT FALSE, hidden BOOLEAN NOT NULL DEFAULT FALSE, source TEXT, last_message_preview TEXT,
      channel_id TEXT, agent_id TEXT, log_file TEXT, summary TEXT, last_summary TEXT, deleted_at TIMESTAMPTZ, thread_state JSONB
    );
    CREATE TABLE conversation_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversation_history(id) ON DELETE CASCADE,
      seq BIGINT GENERATED ALWAYS AS IDENTITY, role TEXT NOT NULL, content TEXT, tool_calls JSONB, tool_call_id TEXT,
      tool_name TEXT, tool_result JSONB, model TEXT, status TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ, kind TEXT, turn_id TEXT, position INTEGER, payload JSONB
    );`;
  const answer = (agentId?: string) => [{ target: agentId ? { agentId } : {}, envelope: { kind: 'human', body: 'saved', ids: { messageId: 'decision-answer:qa-late-grok-role-20261117', answerAttempt: 'a' } } }];
  let pg: any;
  let dir: string;

  /** Route the shared Postgres client to the in-process database, as the store and history model use it. */
  async function database() {
    const { PGlite } = await import('@electric-sql/pglite');
    const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
    pg = new PGlite();
    await pg.exec(SCHEMA);
    const db = { query: async(text: string, params?: any[]) => { const r = await pg.query(text, params ?? []); return { rows: r.rows, rowCount: r.affectedRows ?? null } } };
    vi.spyOn(postgresClient, 'transaction').mockImplementation(async(work: any) => {
      await pg.query('BEGIN');
      try { const result = await work(db); await pg.query('COMMIT'); return result } catch (error) { await pg.query('ROLLBACK'); throw error }
    });
    vi.spyOn(postgresClient, 'query').mockImplementation(async(text: string, params?: any[]) => (await db.query(text, params)).rows as any);
    vi.spyOn(postgresClient, 'queryAll').mockImplementation(async(text: string, params?: any[]) => (await db.query(text, params)).rows as any);
    vi.spyOn(postgresClient, 'queryOne').mockImplementation(async(text: string, params?: any[]) => ((await db.query(text, params)).rows[0] ?? null) as any);
    return db;
  }

  /** The backend conversation SullaLogger recorded at thread creation, on the shared transport default. */
  async function backendConversation() {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-answer-role-'));
    const logFile = path.join(dir, `conv_${ BACKEND }.jsonl`);
    fs.writeFileSync(logFile, [
      { type: 'message', role: 'user', content: 'Ask me the QA menu question', ts: '2026-11-17T10:00:00Z' },
      { type: 'message', role: 'assistant', content: 'Saved the question in For You.', ts: '2026-11-17T10:00:05Z' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n');
    await pg.query(`INSERT INTO conversation_history (id, thread_id, type, channel_id, agent_id, log_file, last_active_at)
      VALUES ($1, $1, 'chat', 'sulla-desktop', 'sulla-desktop', $2, '2026-11-17T10:00:05Z')`, [BACKEND, logFile]);
  }

  /** The renderer chat saved with its exact selection, then linked to the backend thread. */
  async function rendererChat(id: string, agentId: string | null, backendThreadId = BACKEND) {
    const { ConversationThreadStore } = await import('@pkg/agent/database/models/ConversationThreadStore');
    const { ConversationHistoryModel } = await import('@pkg/agent/database/models/ConversationHistoryModel');
    await ConversationThreadStore.saveThreadState(id, {
      thread: { id, title: 'QA menu', agentId, backendThreadId, messages: [{ id: 'u1', kind: 'user', text: 'Ask me the QA menu question', createdAt: 1 }] },
      queue: [], model: { id: 'grok-4.7', name: 'Grok 4.7' },
    });
    await ConversationHistoryModel.linkThreads([{ id, threadId: backendThreadId }]);
  }

  /** Redis key expired (or the app restarted); memory is empty; the real log recovery runs. */
  async function service(live?: Record<string, unknown>, owned = false) {
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const { GraphRegistry } = await import('../../../services/GraphRegistry');
    const { ConversationHistoryModel } = await import('@pkg/agent/database/models/ConversationHistoryModel');
    const repositories = await import('@pkg/agent/app/Repositories/ThreadStateRepository');
    const store = await import('../../../nodes/ThreadStateStore');
    const expiredRedis = { available: async() => true, load: async() => null } as any;
    const states = new repositories.FallbackThreadStateRepository(expiredRedis, new repositories.MemoryThreadStateRepository(), new repositories.LogRecoveryThreadStateRepository(ConversationHistoryModel), { log: () => undefined, error: () => undefined });
    const load = vi.spyOn(store, 'loadThreadState').mockImplementation(id => states.load(id) as any);
    vi.spyOn(GraphRegistry, 'get').mockReturnValue(live ? { state: { metadata: live } } as any : undefined);
    const inbox: any = Object.create(BackendGraphWebSocketService.prototype);
    inbox.inboxThread = () => undefined; inbox.decisionThreadOwned = () => owned; inbox.deliveringDecisionThreads = new Set();
    inbox.dispatchToAgent = vi.fn().mockResolvedValue('accepted');
    return { inbox, load, states, receiver: () => inbox.dispatchToAgent.mock.calls[0]?.[5] };
  }

  beforeEach(async() => { await database(); await backendConversation() });
  afterEach(async() => {
    await pg?.close();
    if (dir) (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['the recorded shared default', 'rebuilt from the conversation log', 'sulla-desktop'],
    ['no recorded receiver', 'rebuilt from the conversation log', undefined],
    ['the recorded shared default', 'not recoverable', 'sulla-desktop'],
    ['no recorded receiver', 'not recoverable', undefined],
  ])('after a restart, routes the answer to the exact agent selected on the linked chat (%s, graph state %s)', async(_label, recovery, recorded) => {
    await rendererChat(CHAT, SELECTED);
    // Log recovery reads the newest row for the thread: the logged backend row, or the linked chat row (no log).
    if (recovery === 'rebuilt from the conversation log') await pg.query(`UPDATE conversation_history SET last_active_at = now() + interval '1 hour' WHERE id = $1`, [BACKEND]);
    const t = await service();
    // Precondition: what the restart really leaves behind carries no exact identity.
    const rebuilt = await t.states.load(BACKEND);
    if (recovery === 'rebuilt from the conversation log') {
      expect(rebuilt?.metadata).toMatchObject({ wsChannel: 'sulla-desktop' });
      expect((rebuilt?.metadata as any).agentId).toBeUndefined();
    } else expect(rebuilt).toBeNull();
    expect(await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer(recorded))).toBe('accepted');
    expect(t.receiver()).toBe(SELECTED);
    expect(t.inbox.dispatchToAgent).toHaveBeenCalledTimes(1);
  });

  it('routes to the selected agent when a live graph was already reconstructed on the shared default', async() => {
    await rendererChat(CHAT, SELECTED);
    const t = await service({ agentId: 'sulla-desktop', wsChannel: 'sulla-desktop' });
    await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'));
    expect(t.receiver()).toBe(SELECTED);
  });

  it('keeps a recorded exact receiver (a worker launch) over a different chat selection', async() => {
    await rendererChat(CHAT, SELECTED);
    const t = await service();
    await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('codex-luna-worker'));
    expect(t.receiver()).toBe('codex-luna-worker');
  });

  it('keeps the exact agent that owns the live graph over a later, different chat selection', async() => {
    await rendererChat(CHAT, 'some-other-agent');
    const t = await service({ agentId: SELECTED, wsChannel: 'sulla-desktop' });
    await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'));
    expect(t.receiver()).toBe(SELECTED);
  });

  it('stays on the shared default when the user chose the default agent for that chat', async() => {
    await rendererChat(CHAT, null);
    const t = await service();
    await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'));
    expect(t.receiver()).toBe('sulla-desktop');
  });

  it.each([
    ['another exact agent', 'some-other-agent'],
    ['the default agent', null],
  ])('leaves the answer undelivered when linked chats disagree (%s), instead of running either agent', async(_label, otherSelection) => {
    await rendererChat(CHAT, SELECTED);
    await rendererChat('t_other_tab', otherSelection);
    const t = await service();
    await expect(t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'))).rejects.toThrow(/ambiguous/i);
    expect(t.inbox.dispatchToAgent).not.toHaveBeenCalled();
    expect(t.inbox.deliveringDecisionThreads.size).toBe(0);
  });

  it('routes once to the exact agent when two linked chats saved the same selection', async() => {
    await rendererChat(CHAT, SELECTED);
    await rendererChat('t_other_tab', SELECTED);
    const t = await service();
    expect(await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'))).toBe('accepted');
    expect(t.receiver()).toBe(SELECTED);
    expect(t.inbox.dispatchToAgent).toHaveBeenCalledTimes(1);
  });

  it('ignores a selection saved on a chat for another backend thread', async() => {
    await rendererChat('t_unrelated', SELECTED, 'thread_unrelated');
    const t = await service();
    await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'));
    expect(t.receiver()).toBe('sulla-desktop');
  });

  it('leaves the answer undelivered for retry when the saved selection cannot be read, instead of running the default agent', async() => {
    await rendererChat(CHAT, SELECTED);
    const t = await service();
    const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
    vi.mocked(postgresClient.transaction).mockRejectedValue(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }));
    await expect(t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'))).rejects.toThrow('Connection terminated');
    expect(t.inbox.dispatchToAgent).not.toHaveBeenCalled();
    expect(t.inbox.deliveringDecisionThreads.size).toBe(0);
  });

  it('still defers an owned thread first, without dispatching', async() => {
    await rendererChat(CHAT, SELECTED);
    const t = await service(undefined, true);
    expect(await t.inbox.wakeInbox({ channel: 'sulla-desktop', threadId: BACKEND }, 'saved', answer('sulla-desktop'))).toBe('deferred');
    expect(t.inbox.dispatchToAgent).not.toHaveBeenCalled();
    expect(t.load).not.toHaveBeenCalled();
  });
});
